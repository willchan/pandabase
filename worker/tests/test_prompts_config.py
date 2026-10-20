"""Versioned prompt files, settings from env, telemetry batching."""

from pathlib import Path
from typing import Any

import pytest

from pandabase_worker.config import DEFAULT_TEXT_MODEL, DEFAULT_VLM_MODEL, PROMPTS_DIR, Settings
from pandabase_worker.contracts import TelemetryEvent
from pandabase_worker.prompts import load_prompt
from pandabase_worker.telemetry import Telemetry


@pytest.mark.parametrize("job_type", ["paper_receipt", "trash_cam", "merge_suggest"])
def test_every_job_type_has_a_v1_prompt(job_type: str) -> None:
    p = load_prompt(PROMPTS_DIR, job_type)
    assert p.version == f"{job_type}.v1"
    assert p.system and p.user
    assert "<!--" not in p.system


def test_paper_receipt_prompt_is_transcription_only() -> None:
    p = load_prompt(PROMPTS_DIR, "paper_receipt")
    assert "do not interpret" in p.system.lower()
    for field in ("store", "date", "raw_text", "qty", "unit_price", "line_total", "subtotal"):
        assert f"`{field}`" in p.system


def test_highest_version_wins_and_renders(tmp_path: Path) -> None:
    (tmp_path / "merge_suggest.v1.md").write_text("old\n---user---\n{{items}}")
    (tmp_path / "merge_suggest.v10.md").write_text(
        "<!-- note -->\nnew\n---user---\nItems: {{items}}"
    )
    (tmp_path / "merge_suggest.v2.md").write_text("mid\n---user---\n{{items}}")
    p = load_prompt(tmp_path, "merge_suggest")
    assert (p.version, p.system) == ("merge_suggest.v10", "new")
    assert p.render(items="[1]") == "Items: [1]"


def test_prompt_errors(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        load_prompt(tmp_path, "trash_cam")
    (tmp_path / "trash_cam.v1.md").write_text("no separator")
    with pytest.raises(ValueError, match="---user---"):
        load_prompt(tmp_path, "trash_cam")


def test_settings_from_env() -> None:
    s = Settings.from_env({"PANDABASE_API_URL": "https://pb.test/", "WORKER_API_TOKEN": "t"})
    assert s.api_url == "https://pb.test"
    assert (s.vlm_model, s.text_model) == (DEFAULT_VLM_MODEL, DEFAULT_TEXT_MODEL)
    assert s.ollama_url == "http://host.docker.internal:11434"
    assert s.poll_interval_seconds == 10
    s2 = Settings.from_env(
        {
            "PANDABASE_API_URL": "https://pb.test",
            "WORKER_API_TOKEN": "t",
            "OLLAMA_URL": "http://localhost:11434/",
            "OLLAMA_VLM_MODEL": "gemma4:e4b",
            "POLL_INTERVAL_SECONDS": "2.5",
        }
    )
    assert (s2.ollama_url, s2.vlm_model, s2.poll_interval_seconds) == (
        "http://localhost:11434",
        "gemma4:e4b",
        2.5,
    )
    with pytest.raises(ValueError, match="WORKER_API_TOKEN"):
        Settings.from_env({"PANDABASE_API_URL": "https://pb.test"})


class Sink:
    def __init__(self, fail: bool = False) -> None:
        self.batches: list[list[TelemetryEvent]] = []
        self.fail = fail

    def telemetry(self, events: list[TelemetryEvent]) -> int:
        if self.fail:
            raise OSError("down")
        self.batches.append(events)
        return len(events)


def test_telemetry_batches_and_never_raises() -> None:
    sink = Sink()
    t = Telemetry(sink)
    for n in range(501):
        t.emit("vlm_inference", n=n)
    t.flush()
    assert [len(b) for b in sink.batches] == [500, 1]
    payload: dict[str, Any] = sink.batches[0][0].payload
    assert payload == {"n": 0}
    t.flush()  # nothing buffered → nothing sent
    assert len(sink.batches) == 2

    down = Telemetry(Sink(fail=True))
    down.emit("vlm_inference")
    down.flush()  # logged, not raised
