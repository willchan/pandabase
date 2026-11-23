// Cart pauses (PRD §4.1 paused weeks, DESIGN §4.1/§4.7): the build is skipped, the agent sees the
// pause on cycle/current, purchases still count but don't teach the EMA, and "resume" ends it.
import { item, pausePeriod, systemTelemetry } from "@pandabase/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CycleT } from "@/lib/contracts";
import { ALEX, setup, type Harness } from "@/test/harness";
import { HANDLERS } from "@/test/routes";

let h: Harness;
beforeEach(async () => {
  h = await setup(); // Tue Oct 20 2026; W43 is open, built Sat Oct 24
});
afterEach(() => h.close());

interface Pause {
  id: string;
  starts_on: string;
  ends_on: string;
  note: string | null;
}
const current = async () =>
  (
    await h.call<{ cycle: CycleT | null; pause: Pause | null }>(
      HANDLERS.cycleCurrent.GET,
      "/api/grocery/cycle/current",
    )
  ).body;
const pause = (starts_on: string, ends_on: string, actor = ALEX) =>
  h.call<{ pause: Pause }>(HANDLERS.pauses.POST, "/api/pauses", {
    body: { actor_discord_id: actor, starts_on, ends_on, note: "parental leave" },
  });
const end = (id: string) =>
  h.call<{ pause: Pause | null }>(HANDLERS.pauseEnd.POST, `/api/pauses/${id}/end`, {
    params: { id },
    body: { actor_discord_id: ALEX },
  });
const status = (id: string, s: string) =>
  h.call<{ cycle: CycleT }>(HANDLERS.cycleStatus.POST, `/api/grocery/cycle/${id}/status`, {
    params: { id },
    body: { status: s, actor_discord_id: ALEX },
  });

describe("cart pauses", () => {
  it("skips the Saturday build with reason `paused` and shows on cycle/current", async () => {
    expect((await current()).pause).toBeNull();
    const p = await pause("2026-10-20", "2027-03-01");
    expect(p.status).toBe(200);
    expect(p.body.pause).toMatchObject({ starts_on: "2026-10-20", ends_on: "2027-03-01" });

    const { cycle, pause: shown } = await current();
    expect(shown).toEqual(p.body.pause);
    expect((await status(cycle!.id, "building")).body.cycle).toMatchObject({
      status: "skipped",
      close_reason: "paused",
    });
  });

  it("a pause starting later this week already shows (it covers the build date)", async () => {
    await pause("2026-10-23", "2026-11-30");
    expect((await current()).pause).toMatchObject({ starts_on: "2026-10-23" });
  });

  it("cart-result refuses a paused build", async () => {
    const { cycle } = await current();
    await pause("2026-10-20", "2027-03-01");
    const res = await h.call(
      HANDLERS.cycleCartResult.POST,
      `/api/grocery/cycle/${cycle!.id}/cart-result`,
      {
        params: { id: cycle!.id },
        body: { lines: [] },
      },
    );
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("paused");
  });

  it("a purchase during the pause adds inventory but leaves the item's EMA alone", async () => {
    const coffee = await h.itemId("Coffee Beans");
    const ridgeline = await h.productId("Ridgeline Roasters House Blend 12oz");
    const [before] = await h.db.select().from(item).where(eq(item.id, coffee));
    await pause("2026-10-01", "2027-03-01");
    h.advance(3 * 86_400_000); // the seed already bought coffee today
    const res = await h.call(HANDLERS.receiptsIngest.POST, "/api/receipts/ingest", {
      body: {
        actor_discord_id: ALEX,
        source: "digital",
        vendor: "wholefoods",
        account: ALEX,
        external_order_id: "WF-LEAVE-1",
        fulfillment: "pickup",
        acquired_at: h.now(),
        lines: [{ raw_text: "coffee", qty: 1, item_id: coffee, product_id: ridgeline }],
      },
    });
    expect(res.status).toBe(200);
    const [after] = await h.db.select().from(item).where(eq(item.id, coffee));
    expect(before!.currentEmaDays).toBe(0.91);
    expect(after!.currentEmaDays).toBe(before!.currentEmaDays);
    const tel = await h.db
      .select()
      .from(systemTelemetry)
      .where(eq(systemTelemetry.metricType, "ema_paused"));
    expect(tel.map((t) => (t.payload as { itemId: string }).itemId)).toContain(coffee);
  });

  it("resume: a started pause ends yesterday; a future one is removed; an ended one is a 409", async () => {
    const started = (await pause("2026-10-01", "2027-03-01")).body.pause;
    const ended = await end(started.id);
    expect(ended.body.pause).toMatchObject({ starts_on: "2026-10-01", ends_on: "2026-10-19" });
    expect((await current()).pause).toBeNull();
    expect((await end(started.id)).status).toBe(409);

    const future = (await pause("2026-12-01", "2026-12-24")).body.pause;
    expect((await end(future.id)).body.pause).toBeNull();
    const today = (await pause("2026-10-20", "2026-12-24")).body.pause;
    expect((await end(today.id)).body.pause).toBeNull();
    expect(await h.db.select().from(pausePeriod)).toHaveLength(1);

    const changes = await h.db
      .select()
      .from(systemTelemetry)
      .where(eq(systemTelemetry.metricType, "cart_pause_changed"));
    expect(changes.map((t) => (t.payload as { action: string }).action)).toEqual([
      "created",
      "ended",
      "created",
      "removed",
      "created",
      "removed",
    ]);
  });

  it("validates dates, ids and the actor", async () => {
    expect((await pause("2026-11-09", "2026-11-05")).status).toBe(400);
    expect((await pause("2026-09-01", "2026-10-01")).status).toBe(400);
    expect((await pause("2026-10-20", "2026-11-05", "999999")).status).toBe(403);
    expect((await end("nope")).status).toBe(404);
  });
});
