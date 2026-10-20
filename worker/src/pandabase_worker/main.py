"""Worker loop (DESIGN §5 step 4): claim → media → model → complete, one job at a time.

Concurrency is 1 by construction: a single thread claims, processes and completes a job before
it claims the next (DESIGN §1.2). SIGTERM/SIGINT stop the loop after the current job; a second
signal exits at once (the job's lease then expires and it is re-queued).
"""

import logging
import signal
import sys
import threading
import time
from collections.abc import Callable
from types import FrameType
from typing import Any

import httpx
from pydantic import ValidationError

from pandabase_worker import __version__
from pandabase_worker.api import ApiClient, ApiError, JobType, LeaseLost
from pandabase_worker.config import HEARTBEAT_SECONDS, Settings
from pandabase_worker.contracts import ClaimedJob, JobCompleteRequest
from pandabase_worker.jobs import JobFailure, Outcome, merge_suggest, paper_receipt, trash_cam
from pandabase_worker.jobs.context import JobContext
from pandabase_worker.media import MediaClient, MediaError, normalize
from pandabase_worker.ollama import OllamaClient, OllamaError, ParseFailure
from pandabase_worker.prompts import load_prompt
from pandabase_worker.telemetry import Telemetry

log = logging.getLogger("pandabase_worker")

HANDLERS: dict[JobType, Callable[[JobContext], Outcome]] = {
    "paper_receipt": paper_receipt.run,
    "trash_cam": trash_cam.run,
    "merge_suggest": merge_suggest.run,
}
MAX_ERROR_CHARS = 2000


def _tagged(model: str) -> str:
    return model if ":" in model else f"{model}:latest"


class Worker:
    def __init__(
        self,
        settings: Settings,
        api: ApiClient,
        ollama: OllamaClient,
        media: MediaClient,
        stop: threading.Event | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.settings = settings
        self.api = api
        self.ollama = ollama
        self.media = media
        self.stop = stop or threading.Event()
        self._ollama_health: tuple[str, tuple[str, ...]] | None = None
        self._clock = clock
        self._last_heartbeat: float | None = None
        self._ollama_checked = False

    # -- loop ---------------------------------------------------------------------------------

    def run(self) -> None:
        log.info(
            "worker %s: vlm=%s text=%s poll=%ss",
            __version__,
            self.settings.vlm_model,
            self.settings.text_model,
            self.settings.poll_interval_seconds,
        )
        while not self.stop.is_set():
            try:
                self.heartbeat()
                worked = self.run_once()
            except Exception:
                log.exception("poll failed")
                worked = False
            if not worked:
                self.stop.wait(self.settings.poll_interval_seconds)
        log.info("worker stopped")

    def heartbeat(self) -> None:
        """`worker_heartbeat` at startup and every `HEARTBEAT_SECONDS` (liveness for deploys)."""
        now = self._clock()
        if self._last_heartbeat is not None and now - self._last_heartbeat < HEARTBEAT_SECONDS:
            return
        self._last_heartbeat = now
        self._emit_now(
            "worker_heartbeat",
            version=__version__,
            vlm_model=self.settings.vlm_model,
            text_model=self.settings.text_model,
            ollama_ok=(self._ollama_health is None) if self._ollama_checked else None,
        )

    def run_once(self) -> bool:
        """Claim and finish at most one job. True if a job was processed."""
        types = self.claimable_types()
        if not types:
            return False
        job = self.api.claim(types)
        if job is None:
            return False
        self.process(job)
        return True

    def claimable_types(self) -> list[JobType]:
        """Job types whose model is pulled. Claiming costs the job an attempt, so never claim
        work the local models can't do right now."""
        models = self.ollama.available_models()
        need: dict[JobType, str] = {
            "paper_receipt": self.settings.vlm_model,
            "trash_cam": self.settings.vlm_model,
            "merge_suggest": self.settings.text_model,
        }
        tagged = {_tagged(m) for m in models or ()}
        types = [t for t, m in need.items() if _tagged(m) in tagged]
        missing = sorted({m for t, m in need.items() if t not in types})
        reason = "unreachable" if models is None else "models missing"
        health = (reason, tuple(missing)) if missing else None
        self._ollama_checked = True
        if health != self._ollama_health:  # report each change, not every poll
            self._ollama_health = health
            if health:
                log.warning("ollama %s: %s", reason, ", ".join(missing))
                self._emit_now("worker_ollama_unavailable", reason=reason, missing_models=missing)
            else:
                log.info("ollama ready")
        return types

    # -- one job --------------------------------------------------------------------------------

    def process(self, job: ClaimedJob) -> None:
        log.info("job %s (%s) attempt %d", job.id, job.job_type, job.attempt)
        t = Telemetry(self.api)
        base: dict[str, Any] = {"job_id": job.id, "job_type": job.job_type, "attempt": job.attempt}
        keyframes: list[str] = []
        req: JobCompleteRequest
        prompt_version: str | None = None
        try:
            prompt = load_prompt(self.settings.prompts_dir, job.job_type)
            prompt_version = prompt.version
            images: list[bytes] = []
            if job.media_url is not None:
                jpeg = normalize(self.media.download(str(job.media_url)))
                if job.keyframe_uploads:
                    keyframes.append(self.media.upload_keyframe(job.keyframe_uploads[0], jpeg))
                images.append(jpeg)
            ctx = JobContext(job, self.settings, self.ollama, prompt, images)
            out = HANDLERS[job.job_type](ctx)
            req = JobCompleteRequest(
                job_id=job.id,
                attempt=job.attempt,
                status="completed",
                result=out.result,
                model=out.model,
                prompt_version=out.prompt_version,
                raw_model_response=out.raw_model_response,
                keyframe_r2_keys=keyframes or None,
            )
            t.emit(
                "vlm_inference",
                **base,
                model=out.model,
                prompt_version=out.prompt_version,
                latency_ms=out.latency_ms,
                parse_failure=False,
                repaired=out.repaired,
                **out.telemetry,
            )
        except ParseFailure as err:
            error = f"model output invalid after one repair: {err.error}"
            req = self._failed(job, error, keyframes, err.model, prompt_version, err.raw)
            fields = {**base, "model": err.model, "prompt_version": prompt_version}
            t.emit("vlm_inference", **fields, latency_ms=err.latency_ms, parse_failure=True)
            t.emit("vlm_parse_failure", **fields, error=err.error[:500])
        except (JobFailure, MediaError, OllamaError) as err:
            req = self._failed(job, str(err), keyframes, None, prompt_version, None)
        except Exception as err:  # a bug in the worker must not wedge the job until lease expiry
            log.exception("job %s crashed", job.id)
            msg = f"worker error: {type(err).__name__}: {err}"
            req = self._failed(job, msg, keyframes, None, prompt_version, None)

        if req.status == "failed":
            log.warning("job %s attempt %d failed: %s", job.id, job.attempt, req.error)
            t.emit("worker_job_failed", **base, error=(req.error or "")[:500])
        try:
            res = self.api.complete(req)
            log.info("job %s → %s", job.id, res.outcome)
        except LeaseLost:
            log.warning("job %s attempt %d: lease lost, dropping result", job.id, job.attempt)
            t.emit("worker_lease_lost", **base)
        except (ApiError, httpx.HTTPError, ValidationError) as err:
            # Transport errors after retries, or a reply we can't read: the lease will expire.
            log.error("job %s: complete failed: %s", job.id, err)
            t.emit("worker_complete_error", **base, error=str(err)[:500])
        t.flush()

    def _failed(
        self,
        job: ClaimedJob,
        error: str,
        keyframes: list[str],
        model: str | None,
        prompt_version: str | None,
        raw: list[str] | None,
    ) -> JobCompleteRequest:
        return JobCompleteRequest(
            job_id=job.id,
            attempt=job.attempt,
            status="failed",
            error=error[:MAX_ERROR_CHARS],
            model=model,
            prompt_version=prompt_version,
            raw_model_response={"responses": raw} if raw else None,
            keyframe_r2_keys=keyframes or None,
        )

    def _emit_now(self, metric: str, **payload: Any) -> None:
        t = Telemetry(self.api)
        t.emit(metric, **payload)
        t.flush()


def install_signal_handlers(stop: threading.Event) -> None:
    def handle(signum: int, _frame: FrameType | None) -> None:
        if stop.is_set():
            log.warning("second %s: exiting now", signal.Signals(signum).name)
            raise SystemExit(1)
        log.info("%s: finishing the current job, then stopping", signal.Signals(signum).name)
        stop.set()

    signal.signal(signal.SIGTERM, handle)
    signal.signal(signal.SIGINT, handle)


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)  # its INFO lines include presigned URLs
    try:
        settings = Settings.from_env()
    except ValueError as err:
        log.error("%s", err)
        return 2
    stop = threading.Event()
    install_signal_handlers(stop)
    api = ApiClient(settings.api_url, settings.api_token)
    ollama = OllamaClient(settings.ollama_url)
    media = MediaClient()
    try:
        Worker(settings, api, ollama, media, stop).run()
    finally:
        api.close()
        ollama.close()
        media.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
