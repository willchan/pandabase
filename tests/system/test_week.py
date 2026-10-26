"""A household week through every component (docs/TESTING.md, tier A).

Each test is one step, run in file order against one shared stack (`conftest.Stack`); later
steps build on earlier ones (`W` carries ids between them). Agent actions run the commands the
skills name (`stack.skill(<skill>, <unique substring>, …)`), so a skill that drifts from the
tools or the API breaks here. Assertions are on API responses, database rows and telemetry —
never on wording the model would produce.
"""

from __future__ import annotations

import json
import re
from typing import Any

import httpx
from conftest import ALEX, SAM, Stack, wait_for

GC = "grocery-cycle"
DI = "discord-intake"
IL = "item-lookup"

# State carried between steps.
W: dict[str, Any] = {}


def lookup(stack: Stack, words: str, skill: str = GC) -> dict[str, Any]:
    slot = {"item_words": words} if skill == GC else {"words": words}
    out: dict[str, Any] = stack.skill(skill, "/api/items/lookup", **slot)
    return out


def resolve(stack: Stack, words: str, skill: str = GC) -> str | None:
    """The skills' rule: `matches[0].item_id` when its `match` is `confident`, else free text."""
    matches = lookup(stack, words, skill)["matches"]
    return matches[0]["item_id"] if matches and matches[0]["match"] == "confident" else None


def item_id(stack: Stack, name: str) -> str:
    return str(stack.one("select id from item where canonical_name = ?", name)["id"])


def png(path: Any) -> Any:
    """A tiny valid PNG (the fake VLM ignores pixels; the worker still decodes and re-encodes)."""
    import struct
    import zlib

    w, h = 8, 8
    raw = b"".join(b"\x00" + b"\xff\xff\xff" * w for _ in range(h))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
        )

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw))
    path.write_bytes(data + chunk(b"IEND", b""))
    return path


def finished_job(stack: Stack, job_id: str, timeout: float = 30) -> dict[str, Any]:
    return wait_for(
        f"job {job_id} to finish",
        lambda: next(
            iter(
                stack.rows(
                    "select * from audit_job where id = ? and status in ('completed', 'failed')",
                    job_id,
                )
            ),
            None,
        ),
        timeout=timeout,
    )


def test_00_stack_is_up(stack: Stack) -> None:
    started = stack.rows("select max(created_at) t from system_telemetry")[0]["t"] or ""
    W["t0"] = started
    # The worker announced itself through the API (heartbeat read path, M9).
    health = wait_for(
        "worker heartbeat",
        lambda: stack.tools(["api", "get", "/api/health/worker"])["heartbeat"],
    )
    assert health["sha"] == "systemtest" and health["vlm_model"] == "qwen3.5:9b"
    shown = stack.tools(["config", "show"])
    assert shown["token_set"] is True and shown["api_base_url"] == stack.base_url


def test_01_open_cycle(stack: Stack) -> None:
    """The seeded week went to another store; §1 opens the next cycle with its thread."""
    cur = stack.skill(GC, "api get /api/grocery/cycle/current")["cycle"]
    assert cur is not None and cur["status"] == "open"
    W["seed_cycle"] = cur["id"]
    out = stack.skill(
        GC,
        '"status": "skipped"',  # "shopping at Trader Joe's" = same route, other_store
        json_body={"status": "other_store", "reason": "Trader Joe's"},
        c=cur["id"],
        sender_id=SAM,
        message_id=stack.message_id(),
    )
    print(out)
    assert stack.skill(GC, "api get /api/grocery/cycle/current")["cycle"] is None
    thread = "400000000000000101"
    opened = stack.skill(GC, "/api/grocery/cycle/open", thread_id=thread)
    print(opened)
    W["cycle"] = opened["cycle"]["id"]


def test_02_running_list_adds(stack: Stack) -> None:
    """ "add oat milk" (catalog item) and "add cake flour" (free text)."""
    c = W["cycle"]
    oat = resolve(stack, "oat milk")
    assert oat == item_id(stack, "Oat Milk")
    assert resolve(stack, "cake flour") is None  # not in the catalog → free text
    add = stack.skill(
        GC, '"kind": "add"', c=c, id=oat, sender_id=ALEX, message_id=stack.message_id()
    )["override"]
    assert add["item_id"] == oat and add["actor_member_id"]
    # Amazon-only items, so Saturday's tier 1 has work whatever the seed predicts today.
    for words in ("potting soil", "coffee beans"):
        amz = resolve(stack, words)
        assert amz, words
        stack.skill(GC, '"kind": "add"', c=c, id=amz, sender_id=ALEX, message_id=stack.message_id())
    msg = stack.message_id()
    free_args = {"c": c, "id": "-", "sender_id": SAM, "message_id": msg}
    free = stack.skill(
        GC, '"kind": "add"', json_body={"kind": "add", "free_text": "cake flour"}, **free_args
    )["override"]
    assert free["free_text"] == "cake flour" and free["item_id"] is None
    # A re-delivered Discord message (same --key) doesn't add twice.
    again = stack.skill(
        GC, '"kind": "add"', json_body={"kind": "add", "free_text": "cake flour"}, **free_args
    )["override"]
    assert again["id"] == free["id"]
    n = stack.one(
        "select count(*) n from grocery_cycle_override where cycle_id = ? and free_text = ?",
        c,
        "cake flour",
    )
    assert n["n"] == 1
    plan = stack.skill(DI, "api get /api/predictions")  # (the skill omits cycle_id)
    W["plan"] = plan
    items = {line.get("item_id") for line in plan["lines"]}
    assert oat in items
    assert any(line.get("free_text") == "cake flour" for line in plan["lines"])


def test_03_skip(stack: Stack) -> None:
    """ "skip bananas" takes a planned line out; "3 eggs" sets a quantity."""
    c = W["cycle"]
    bananas = resolve(stack, "bananas")
    assert bananas == item_id(stack, "Bananas")
    # The skip/qty rows are "same route" as add, with the body the table gives.
    stack.skill(
        GC, '"kind": "add"', json_body={"kind": "skip", "item_id": bananas},
        c=c, id=bananas, sender_id=ALEX, message_id=stack.message_id(),
    )  # fmt: skip
    eggs = resolve(stack, "eggs")
    assert eggs == item_id(stack, "Eggs")
    stack.skill(
        GC, '"kind": "add"', json_body={"kind": "qty", "item_id": eggs, "quantity": 3},
        c=c, id=eggs, sender_id=SAM, message_id=stack.message_id(),
    )  # fmt: skip
    plan = stack.tools(["api", "get", "/api/predictions", "-q", f"cycle_id={c}"])
    lines = {line.get("item_id"): line for line in plan["lines"]}
    assert bananas not in lines
    assert lines[eggs]["quantity"] == 3
    W["plan"] = plan


def test_04_away_period(stack: Stack) -> None:
    """ "away in two weeks": stored, and today's estimates and plan don't change."""
    from datetime import date, timedelta

    start = date.fromisoformat(stack.today()) + timedelta(days=14)
    end = start + timedelta(days=7)
    before = stack.tools(["api", "get", "/api/predictions", "-q", f"cycle_id={W['cycle']}"])
    out = stack.skill(
        GC,
        "/api/away-periods",
        json_body={"starts_on": start.isoformat(), "ends_on": end.isoformat(), "note": "away"},
        today=stack.today(),
        sender_id=SAM,
        message_id=stack.message_id(),
    )
    print("AWAY", out)
    row = stack.one("select * from away_period where starts_on = ?", start.isoformat())
    assert row["ends_on"] == end.isoformat()
    after = stack.tools(["api", "get", "/api/predictions", "-q", f"cycle_id={W['cycle']}"])
    assert [x.get("item_id") for x in after["lines"]] == [x.get("item_id") for x in before["lines"]]


def test_05_do_we_have(stack: Stack) -> None:
    """ "do we have oat milk?" → `matches[0].text`, read-only."""
    writes = stack.one("select count(*) n from inventory_event")["n"]
    out = stack.skill(IL, "/api/items/lookup", item_words="oat milk")
    top = out["matches"][0]
    assert top["name"] == "Oat Milk" and top["match"] == "confident"
    assert "oat milk" in top["text"].lower() and "→" in top["text"]
    assert stack.one("select count(*) n from inventory_event")["n"] == writes
    assert stack.skill(IL, "/api/items/lookup", item_words="unicorn steaks")["matches"] == []


def test_06_friday_nudge(stack: Stack) -> None:
    c = W["cycle"]
    out = stack.skill(GC, '"status": "nudged"', c=c)
    print("NUDGE", out)
    cyc = stack.one("select * from grocery_cycle where id = ?", c)
    assert cyc["nudge_sent_at"] and cyc["status"] == "open"
    again = stack.skill(GC, '"status": "nudged"', c=c)
    assert stack.one("select nudge_sent_at from grocery_cycle where id = ?", c) == {
        "nudge_sent_at": cyc["nudge_sent_at"]
    }
    print("NUDGE2", again)
    checkin = stack.skill(GC, "api get /api/grocery/checkin")
    print("CHECKIN", checkin)
    assert checkin["likely_needed"] and checkin["pending_review_count"] >= 1
    W["checkin"] = checkin


def submit_photo(stack: Stack, caption: str, name: str) -> tuple[dict[str, Any], str]:
    msg = stack.message_id()
    out = stack.skill(
        DI,
        "photo submit --file",
        drop=("--description",),
        attachment_path=str(png(stack.tmp / name)),
        sender_id=ALEX,
        message_text=caption,
        channel_id="100000000000000010",
        message_id=msg,
    )
    return out, msg


def test_07_paper_receipt_photo(stack: Stack) -> None:
    """Photo → R2 → job → worker (fake VLM) → receipt + review → reply → confirm in the web UI."""
    out, msg = submit_photo(stack, "receipt from the corner market", "receipt.png")
    assert out["job_type"] == "paper_receipt" and out["basis"] == "caption"
    key = out["media_r2_key"]
    assert key in stack.r2.objects and stack.r2.objects[key].content_type == "image/png"
    job = finished_job(stack, out["job_id"])
    assert job["status"] == "completed", job["error"]
    assert job["model"] == "qwen3.5:9b" and job["prompt_version"] == "paper_receipt.v1"
    # The worker sent Ollama what DESIGN §1.2/§5 say, and stored a keyframe through its presign.
    chat = stack.ollama.chats[-1]
    assert chat["keep_alive"] == "2m" and chat["think"] is False and chat["stream"] is False
    assert chat["options"]["num_ctx"] == 8192 and chat["format"]["properties"]["lines"]
    assert f"keyframes/{out['job_id']}/0.jpg" in stack.r2.objects
    receipt = stack.one("select * from receipt where job_id = ?", out["job_id"])
    # The fixture's $1 coupon isn't a line, but the totals still add up (discount_cents).
    assert receipt["totals_check"] == "pass" and receipt["vendor"] == "syntheticfoods"
    lines = stack.rows("select * from receipt_line where receipt_id = ?", receipt["id"])
    assert sorted(ln["raw_text"] for ln in lines) == [
        "GREEK YOGURT",
        "ORG BANANAS",
        "SOURDOUGH BREAD",
        "WHOLE MILK 1GAL",
    ]
    # A new store: nothing is a known alias yet, so every line waits for a human.
    assert {ln["trust"] for ln in lines} <= {"unverified", "provisional"}
    review = stack.one(
        "select * from review_item where receipt_id = ? and kind = 'receipt'", receipt["id"]
    )
    W["receipt"] = receipt["id"]
    W["receipt_review"] = review["id"]
    reply = stack.skill(DI, "pandabase-tools jobs replies")
    assert reply.startswith(f"[[reply_to:{msg}]] 🧾")
    assert stack.tools(["jobs", "replies"]) == "NO_REPLY"


def test_07b_confirm_receipt_in_web_ui(stack: Stack) -> None:
    """Playwright against the same server: a Google-style session cookie, Cleanup → confirm."""
    from playwright.sync_api import expect, sync_playwright

    review = W["receipt_review"]
    t = stack.rows("select max(created_at) t from system_telemetry")[0]["t"]
    with sync_playwright() as pw:
        exe = "/opt/pw-browsers/chromium"
        import os

        kw = {"executable_path": exe} if os.path.exists(exe) else {}
        browser = pw.chromium.launch(**kw)  # type: ignore[arg-type]
        ctx = browser.new_context(viewport={"width": 390, "height": 844})
        page = ctx.new_page()
        # Signed out: the proxy sends every page to /sign-in (no dev bypass in production).
        page.goto(stack.base_url + "/cleanup")
        expect(page).to_have_url(re.compile(r"/sign-in\?callbackUrl=%2Fcleanup"))
        expect(page.get_by_role("button", name=re.compile("Continue as"))).to_have_count(0)
        ctx.add_cookies([stack.session_cookie("sam@example.com")])  # type: ignore[list-item]
        page.goto(stack.base_url + "/cleanup")
        page.locator(f"a[href='/cleanup/receipts/{review}']").click()
        expect(page.get_by_text("Check each line against the photo")).to_be_visible()
        # The photo is a presigned R2 GET the browser loads from the (fake) bucket.
        img = page.locator(f"img[src^='{stack.r2.url}']")
        expect(img).to_have_count(1)
        page.get_by_role("button", name="Confirm receipt").click()
        expect(page).to_have_url(re.compile(r"/cleanup\?done=receipt"))
        browser.close()
    assert any(r.method == "GET" and r.status == 200 and r.key.startswith("media/")
               for r in stack.r2.requests)  # fmt: skip
    row = stack.one("select * from review_item where id = ?", review)
    sam = stack.one("select id from member where discord_user_id = ?", SAM)["id"]
    assert row["status"] != "pending" and row["reviewed_by_member_id"] == sam
    lines = stack.rows("select * from receipt_line where receipt_id = ?", W["receipt"])
    assert {ln["trust"] for ln in lines} == {"confirmed"}
    labels = stack.rows(
        "select * from labeled_observation where source_kind = 'receipt_line' and member_id = ?",
        sam,
    )
    assert len(labels) >= 4  # human-confirmed lines became training labels (PRD §3.3)
    resolved = [x["payload"] for x in stack.telemetry("review_resolved", t)]
    assert any(p["reviewId"] == review for p in resolved)
    assert any(x["payload"]["ok"] for x in stack.telemetry("ui_action", t))


def test_08_trash_cam_photo(stack: Stack) -> None:
    """ "we're out of this" + photo → Trash Cam → provisional `consumed` on the detected item."""
    out, msg = submit_photo(stack, "we're out of this", "empty.png")
    assert out["job_type"] == "trash_cam" and out["basis"] == "caption"
    job = finished_job(stack, out["job_id"])
    assert job["status"] == "completed", job["error"]
    oat = item_id(stack, "Oat Milk")  # the fixture's top detection: "oat milk" 0.93
    ev = stack.one("select * from inventory_event where source_ref = ?", out["job_id"])
    assert ev["item_id"] == oat and ev["kind"] == "consumed" and ev["trust"] == "provisional"
    reply = stack.skill(DI, "pandabase-tools jobs replies")
    assert reply.startswith(f"[[reply_to:{msg}]] 🗑️") and "Oat Milk" in reply
    plan = stack.tools(["api", "get", "/api/predictions", "-q", f"cycle_id={W['cycle']}"])
    assert oat in {x.get("item_id") for x in plan["lines"]}  # → it lands in the next cart


def test_09_text_purchase(stack: Stack) -> None:
    """ "bought chicken thighs and avocados" → one manual receipt through applyReceipt."""
    ids = [resolve(stack, w, DI) for w in ("chicken thighs", "avocados")]
    assert all(ids), ids
    msg = stack.message_id()
    events = [{"item_id": i, "kind": "acquired", "quantity": 1} for i in ids]
    out = stack.skill(
        DI, "/api/inventory/events", json_body={"events": events}, sender_id=SAM, message_id=msg
    )
    manual = stack.one("select * from receipt where source = 'manual'")
    assert out["receipt_id"] == manual["id"] and manual["status"] == "applied"
    lines = stack.rows("select * from receipt_line where receipt_id = ?", manual["id"])
    assert sorted(str(ln["item_id"]) for ln in lines) == sorted(map(str, ids))
    assert {(ln["match_method"], ln["trust"]) for ln in lines} == {("manual", "confirmed")}
    acquired = {e["item_id"] for e in out["estimates"] if e["on_hand"] > 0}
    assert acquired == set(ids)
    # A re-delivered message doesn't buy twice (Idempotency-Key = discord:<message id>).
    stack.skill(
        DI, "/api/inventory/events", json_body={"events": events}, sender_id=SAM, message_id=msg
    )
    assert len(stack.rows("select * from receipt where source = 'manual'")) == 1


def test_10_froze_the_chicken(stack: Stack) -> None:
    chicken = resolve(stack, "chicken thighs", DI)
    assert chicken == item_id(stack, "Chicken Thighs")
    out = stack.skill(
        DI,
        "/api/inventory/events",
        json_body={"events": [{"item_id": chicken, "kind": "moved", "to_location": "freezer"}]},
        sender_id=ALEX,
        message_id=stack.message_id(),
    )
    ev = stack.one("select * from inventory_event where id = ?", out["event_ids"][0])
    assert ev["location"] == "fridge" and ev["to_location"] == "freezer"
    assert ev["quantity"] > 0  # the chicken bought in step 9, not nothing
    aging = stack.tools(["api", "get", "/api/freezer/aging", "-q", "limit=50"])["items"]
    frozen = next(i for i in aging if i["item_id"] == chicken)
    assert frozen["frozen_at"] and frozen["quantity"] >= ev["quantity"]


def test_11_saturday_build(stack: Stack) -> None:
    """`cart build` (price checks → tier 1 on synthetic Amazon) → tier 2 → `cart finish`."""
    c = W["cycle"]
    t = stack.rows("select max(created_at) t from system_telemetry")[0]["t"]
    built = stack.skill(GC, "pandabase-tools cart build", shim=True)
    assert built["status"] == "needs_agent" and built["cycle_id"] == c and not built["failed"]
    added = {x["index"]: x for x in built["added"]}
    agent = {x["index"]: x for x in built["needs_agent"]}
    assert added and all(x["vendor"] == "amazon" and x["asin"] for x in added.values())
    # Whole Foods isn't tier-1 verified (cart.wholefoods_tier1 false); free text needs a search.
    assert {x["vendor"] for x in agent.values()} <= {"wholefoods", None}
    cake = next(i for i, x in agent.items() if x["free_text"] == "cake flour")
    assert stack.one("select status from grocery_cycle where id = ?", c)["status"] == "building"
    # Re-running is safe: nothing is added twice.
    again = stack.skill(GC, "pandabase-tools cart build", shim=True)
    assert {x["index"] for x in again["added"]} == set(added)

    # Tier 2: the agent holds the profile lock while it browses, then reports.
    lock = stack.skill(GC, "lock acquire", cart_member="alex")
    busy = stack.skill(GC, "pandabase-tools cart build", shim=True, expect=3)
    assert busy["error"] == "profile_locked"
    outcomes = {str(i): ("failed" if i == cake else "tier2") for i in agent}
    finished = stack.skill(GC, "cart finish", c=c, flags={"--outcomes": json.dumps(outcomes)})
    assert finished["status"] == "ready"
    assert finished["counts"] == {"tier1": len(added), "tier2": len(agent) - 1, "failed": 1}
    stack.skill(GC, "lock release", cart_member="alex", token=lock["token"])

    cyc = stack.one("select * from grocery_cycle where id = ?", c)
    assert cyc["status"] == "ready" and cyc["built_at"]
    result = json.loads(cyc["cart_result"])
    assert set(result["vendors"]) == {"amazon", "wholefoods"}
    lines = [x["payload"] for x in stack.telemetry("cart_line_result", t)]
    assert sorted(x["outcome"] for x in lines) == sorted(
        ["tier1"] * len(added) + ["tier2"] * (len(agent) - 1) + ["failed"]
    )
    tier1 = [x["payload"] for x in stack.telemetry("cart_tier1_line", t)]
    assert {x["asin"] for x in tier1} == {x["asin"] for x in added.values()}
    quotes = stack.rows("select * from price_quote where cycle_id = ?", c)
    assert len(quotes) >= built["quotes_accepted"] >= 1
    # Price checks the tools can't do (no ASIN: Whole Foods) are logged, not attempted.
    failed = [x["payload"] for x in stack.telemetry("price_lookup_failed", t)]
    assert {x["error"] for x in failed} <= {"no_asin"}
    # Never near checkout: every page the injector opened or landed on passed the guard.
    pages = [json.loads(x) for x in stack.amazon_log.read_text().splitlines()]
    assert pages and all("checkout" not in p["url"] and "/gp/buy/" not in p["url"] for p in pages)
    assert {p["url"].split("?")[0] for p in pages if p["kind"] == "clicked"} == {
        "https://www.amazon.com/gp/aws/cart/add.html"
    }


def test_12_digital_receipt_closes_the_cycle(stack: Stack) -> None:
    """A synthetic Amazon order via `receipts ingest` (the agent-extraction path) closes it."""
    from datetime import UTC, datetime

    c = W["cycle"]
    now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    order = {
        "vendor": "amazon",
        "external_order_id": "112-0000000-0000001",
        "fulfillment": "delivery",
        "acquired_at": now,
        "ordered_at": now,
        "total_cents": 4196,
        "lines": [
            {"raw_text": "Summit Coffee Dark Roast Whole Bean 18oz", "asin": "B0SEED0001",
             "qty": 1, "unit_price_cents": 1499, "line_total_cents": 1499},
            {"raw_text": "Greenroot Organic Potting Mix 1cu ft", "asin": "B0SEED0010",
             "qty": 1, "unit_price_cents": 1299, "line_total_cents": 1299},
            # A product the catalog has never seen → a new, unverified item (for step 14).
            {"raw_text": "Synthetic Lavender Dish Soap Refill, 48 fl oz", "asin": "B0SYNTH0099",
             "qty": 1, "unit_price_cents": 1398, "line_total_cents": 1398},
        ],
    }  # fmt: skip
    path = stack.tmp / "order.json"
    path.write_text(json.dumps(order))
    out = stack.skill(
        "digital-receipt-scraper", "receipts ingest", member_name="alex", file=str(path)
    )
    assert {ln["match_method"] for ln in out["lines"]} == {"asin"} and out["new_item_ids"]
    assert out["closed_cycle_id"] == c and out["duplicate"] is False
    cyc = stack.one("select * from grocery_cycle where id = ?", c)
    assert cyc["status"] == "closed" and cyc["close_reason"] == "order_ingested"
    # Re-ingesting is harmless: the tool's key replays the first answer, and a new key hits the
    # external_order_id dedupe.
    again = stack.skill(
        "digital-receipt-scraper", "receipts ingest", member_name="alex", file=str(path)
    )
    assert again["receipt_id"] == out["receipt_id"]
    (stack.tmp / "order2.json").write_text(
        json.dumps({**order, "source": "digital", "account": ALEX})
    )
    other = stack.tools(
        ["api", "post", "/api/receipts/ingest", "--input", str(stack.tmp / "order2.json"),
         "--actor", ALEX, "--key", "another-sweep"]
    )  # fmt: skip
    assert other["duplicate"] is True and other["receipt_id"] == out["receipt_id"]
    oid = order["external_order_id"]
    assert stack.one("select count(*) n from receipt where external_order_id = ?", oid)["n"] == 1
    cursor = stack.tools(["api", "get", "/api/receipts/cursor", "-q", f"account={ALEX}"])
    assert cursor["external_order_id"] == order["external_order_id"]
    W["new_item"] = out["new_item_ids"][0]


def test_13_next_cycle_opens(stack: Stack) -> None:
    assert stack.skill(GC, "api get /api/grocery/cycle/current")["cycle"] is None
    opened = stack.skill(GC, "/api/grocery/cycle/open", thread_id="400000000000000102")
    cyc = opened["cycle"]
    assert opened["created"] is True and cyc["status"] == "open" and cyc["id"] != W["cycle"]
    prev = stack.one("select week_label from grocery_cycle where id = ?", W["cycle"])
    assert cyc["week_label"] > prev["week_label"]
    W["next_cycle"] = cyc["id"]


def test_14_merge_suggestions(stack: Stack) -> None:
    """End of a backfill: queue merge_suggest → worker (fake text model) → merge reviews."""
    t = stack.rows("select max(created_at) t from system_telemetry")[0]["t"]
    out = stack.skill(
        "digital-receipt-scraper",
        "merge-suggestions/run",
        member_discord_id=ALEX,
        yyyy_mm_dd=stack.today(),
    )
    assert out["created"] is True and out["jobs"] and out["candidates"] >= 1
    for queued in out["jobs"]:
        job = finished_job(stack, queued["id"])
        assert job["status"] == "completed", job["error"]
        assert job["model"] == "qwen3.5:4b" and job["prompt_version"] == "merge_suggest.v1"
    # Idempotent while queued/claimed; once done a new run may queue again.
    reviews = stack.rows(
        "select * from review_item where kind = 'merge_suggestion' and status = 'pending'"
    )
    assert any(r["item_id"] == W["new_item"] for r in reviews)
    created = [x["payload"] for x in stack.telemetry("merge_suggestions_created", t)]
    assert created and created[0]["created"] >= 1
    assert stack.telemetry("merge_suggest_requested", t)[0]["payload"]["trigger"] == "backfill"
    # The text model got the State Engine's item list, never the catalog itself.
    chat = stack.ollama.chats[-1]
    assert chat["model"] == "qwen3.5:4b" and W["new_item"] in json.dumps(chat["messages"])


def test_15_maintenance_cron(stack: Stack) -> None:
    """Vercel Cron's call: only CRON_SECRET may run it."""
    assert stack.http("GET", "/api/cron/maintenance").status_code == 401
    agent = stack.http("GET", "/api/cron/maintenance", token=stack.tokens["agent"])
    assert agent.status_code == 403
    res = stack.http("GET", "/api/cron/maintenance", token=stack.tokens["cron"])
    assert res.status_code == 200, res.text
    print("CRON", res.json())
    runs = stack.telemetry("maintenance_run")
    assert runs and runs[-1]["source"] == "cron"
    # A cycle is already open, so the cron doesn't open another.
    assert len(stack.rows("select * from grocery_cycle where status = 'open'")) == 1


def test_16_weekly_diagnostics(stack: Stack) -> None:
    """telemetry-aggregator: `diagnostics write` renders and writes the report + extracts."""
    out = stack.skill("telemetry-aggregator", "diagnostics write")
    week = out["week"]
    root = stack.tmp / "diagnostics"
    assert (root / f"{week}.md").exists()
    names = {p.name for p in (root / week).iterdir()}
    extracts = ("velocity", "receipt_lines", "vlm", "product_choice", "cart_injection", "ux")
    assert names == {f"{n}.jsonl" for n in extracts}
    # This week (the default is the last complete one) shows what the run just did.
    from datetime import datetime
    from zoneinfo import ZoneInfo

    y, w, _ = datetime.now(ZoneInfo("America/Los_Angeles")).isocalendar()
    this = stack.tools(["diagnostics", "write", "--week", f"{y}-W{w:02d}"])
    md = (root / f"{this['week']}.md").read_text()
    print(md[:3000])
    for section in ("## 1. Summary", "## 4. VLM", "## 6. Cart injection", "## 8. Deploys"):
        assert section in md
    vlm = (root / this["week"] / "vlm.jsonl").read_text()
    assert "paper_receipt.v1" in vlm and "trash_cam.v1" in vlm
    cart = (root / this["week"] / "cart_injection.jsonl").read_text()
    assert "B0SEED0001" in cart


def test_17_telemetry_from_every_component(stack: Stack) -> None:
    """Every emitter in the run reached system_telemetry with its source (DESIGN §7)."""
    t0 = W["t0"]
    by_source: dict[str, set[str]] = {}
    for r in stack.rows(
        "select source, metric_type from system_telemetry where created_at >= ?", t0
    ):
        by_source.setdefault(r["source"], set()).add(r["metric_type"])
    print("TELEMETRY", by_source)
    want = {
        "worker": {"worker_heartbeat", "vlm_inference", "worker_job_failed"},
        "agent": {"photo_classified", "cart_tier1_line"},
        "state_engine": {"cycle_opened", "cycle_transition", "job_created", "job_finished",
                         "cart_line_result", "review_resolved", "receipt_line_match"},
        "api": {"api_request"},
        "session": {"ui_action"},
        "cron": {"maintenance_run"},
    }  # fmt: skip
    for source, metrics in want.items():
        assert metrics <= by_source.get(source, set()), (
            source,
            metrics - by_source.get(source, set()),
        )
    # The seeded queued job (its media isn't in R2) failed after 3 attempts with a review.
    seeded = stack.rows(
        "select * from audit_job where media_r2_key like 'seed/%' and status = 'failed'"
        " and attempts = 3"
    )
    assert seeded and stack.rows(
        "select * from review_item where kind = 'failed_job' and job_id = ?", seeded[0]["id"]
    )


def test_18_away_on_build_day_skips(stack: Stack) -> None:
    """ "away until <next week>" covering today: the next `cart build` skips the cycle."""
    from datetime import date, timedelta

    c = W["next_cycle"]
    end = date.fromisoformat(stack.today()) + timedelta(days=3)
    stack.skill(
        GC,
        "/api/away-periods",
        json_body={"starts_on": stack.today(), "ends_on": end.isoformat(), "note": "away"},
        today=stack.today(),
        sender_id=ALEX,
        message_id=stack.message_id(),
    )
    built = stack.skill(GC, "pandabase-tools cart build", shim=True)
    print("SKIP", built)
    assert built["status"] == "skipped"
    assert stack.one("select status from grocery_cycle where id = ?", c)["status"] == "skipped"


def test_19_auth_seams(stack: Stack) -> None:
    """Production-mode auth across the real server (DESIGN §3.1)."""
    cur = "/api/grocery/cycle/current"
    assert stack.http("GET", cur).status_code == 401  # DEV_AUTH_BYPASS=1 is set but ignored
    assert stack.http("GET", cur, token="nope").status_code == 401
    assert stack.http("GET", cur, token=stack.tokens["worker"]).status_code == 403
    assert stack.http("GET", cur, token=stack.tokens["cron"]).status_code == 403
    claim = stack.http("POST", "/api/jobs/claim", token=stack.tokens["agent"], json={})
    assert claim.status_code == 403
    # Unknown Discord ids may not act for the household.
    ev = json.dumps({"events": [{"item_id": item_id(stack, "Eggs"), "kind": "consumed"}]})
    bad = stack.tools(
        ["api", "post", "/api/inventory/events", "--json", ev, "--actor", "999"], expect=1
    )
    assert bad["status"] == 403, bad

    def as_session(email: str) -> httpx.Response:
        c = stack.session_cookie(email)
        return stack.http("GET", cur, headers={"cookie": f"{c['name']}={c['value']}"})

    assert as_session("alex@example.com").status_code == 200
    assert as_session("mallory@example.com").status_code == 403  # not in ALLOWED_EMAILS
