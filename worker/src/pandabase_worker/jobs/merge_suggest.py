"""Merge suggestions: find catalog items that are the same need under different names.

Text-only, on the small local text model. Job `input` is the `MergeSuggestInput` contract
(`{"items": [{"item_id", "name", "aliases"?: [str]}]}`, 2 to 150 items), set by the State Engine —
the worker never reads the catalog itself.
"""

import json

from pydantic import BaseModel, ValidationError

from pandabase_worker.contracts import MergeSuggestInput, MergeSuggestResult, Suggestion
from pandabase_worker.jobs import JobFailure, Outcome
from pandabase_worker.jobs.context import JobContext


class LlmSuggestion(BaseModel):
    item_id: str
    merge_into_item_id: str
    confidence: float
    reason: str | None = None


class LlmMerges(BaseModel):
    suggestions: list[LlmSuggestion]


def parse_input(raw: object) -> MergeSuggestInput:
    try:
        return MergeSuggestInput.model_validate(raw)
    except ValidationError as err:
        raise JobFailure(
            f"merge_suggest input invalid: {err.errors(include_url=False)[:3]}"
        ) from err


def to_result(raw: LlmMerges, inp: MergeSuggestInput) -> MergeSuggestResult:
    """Keep suggestions between two distinct known items, one per pair."""
    known = {i.item_id for i in inp.items}
    seen: set[frozenset[str]] = set()
    out: list[Suggestion] = []
    for s in sorted(raw.suggestions, key=lambda s: s.confidence, reverse=True):
        pair = frozenset((s.item_id, s.merge_into_item_id))
        if len(pair) != 2 or not pair <= known or pair in seen:
            continue
        seen.add(pair)
        out.append(
            Suggestion(
                item_id=s.item_id,
                merge_into_item_id=s.merge_into_item_id,
                confidence=min(max(s.confidence, 0.0), 1.0),
                reason=(s.reason or "").strip()[:200] or None,
            )
        )
    return MergeSuggestResult(suggestions=out)


def run(ctx: JobContext) -> Outcome:
    inp = parse_input(ctx.job.input)
    items = json.dumps(
        [i.model_dump(exclude_none=True) for i in inp.items], ensure_ascii=False, indent=None
    )
    inf = ctx.ollama.generate(
        ctx.settings.text_model,
        ctx.prompt.system,
        ctx.prompt.render(items=items),
        LlmMerges,
    )
    result = to_result(inf.value, inp)
    return Outcome(
        result=result.model_dump(mode="json", exclude_none=True),
        model=inf.model,
        prompt_version=ctx.prompt.version,
        raw_model_response={"responses": inf.raw},
        latency_ms=inf.latency_ms,
        repaired=inf.repaired,
        telemetry={
            "items": len(inp.items),
            "suggestions": len(result.suggestions),
            "dropped": len(inf.value.suggestions) - len(result.suggestions),
        },
    )
