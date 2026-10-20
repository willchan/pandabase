"""The generated contracts (`pnpm contracts:gen`) parse the State Engine's payloads."""

from pandabase_tools.contracts import CycleOverrideRequest, LookupResponse, ReceiptIngestRequest


def test_lookup_response_parses() -> None:
    res = LookupResponse.model_validate(
        {
            "query": "eggs",
            "matches": [
                {
                    "item_id": "01ITEM",
                    "name": "Eggs",
                    "score": 1,
                    "base_unit": "egg",
                    "on_hand": 4.2,
                    "status": "stocked",
                    "runout_at": "2026-10-24T19:00:00.000Z",
                    "confidence": "medium",
                    "text": "~4.2 eggs (bought Oct 12) → probably fine",
                    "by_location": [{"location": "fridge", "on_hand": 4.2}],
                }
            ],
        }
    )
    assert res.matches[0].by_location[0].location == "fridge"


def test_requests_serialize_snake_case() -> None:
    override = CycleOverrideRequest(actor_discord_id="1", kind="add", free_text="candles")
    assert override.model_dump(exclude_none=True) == {
        "actor_discord_id": "1",
        "kind": "add",
        "free_text": "candles",
    }
    receipt = ReceiptIngestRequest.model_validate(
        {
            "actor_discord_id": "1",
            "source": "digital",
            "vendor": "amazon",
            "external_order_id": "111-1",
            "acquired_at": "2026-10-20T01:00:00Z",
            "lines": [{"raw_text": "Eggs", "asin": "B0X", "qty": 1}],
        }
    )
    assert receipt.lines[0].asin == "B0X"
