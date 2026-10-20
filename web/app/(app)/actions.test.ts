// Server actions call the services (never the HTTP routes) as the signed-in member, turn domain
// errors into form messages, and log `ui_action` telemetry.
import {
  awayPeriod,
  groceryCycleOverride,
  item,
  receipt,
  reviewItem,
  systemTelemetry,
} from "@pandabase/db";
import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { form, redirectOf, session } from "@/test/ui";
import { setup, type Harness } from "@/test/harness";
import { activeCycle } from "@/lib/repo/cycles";
import { loadEstimates } from "@/lib/repo/inventory";
import { DEFAULT_CONFIG } from "@/lib/config";
import { receiptReviewDetail } from "@/lib/services/reviews";
import {
  addToListAction,
  cycleStatusAction,
  markItemAction,
  openCycleAction,
  setQuantityAction,
  skipItemAction,
  unskipItemAction,
} from "./actions";
import { answerReceiptAction, dismissAction, mergeAction } from "./cleanup/actions";
import { updateItemSettingsAction } from "./pantry/actions";
import { addAwayAction, deleteAwayAction, updateTunablesAction } from "./settings/actions";

vi.mock("@/auth", async () => (await import("@/test/ui")).authMock);
vi.mock("next/server", async (o) => ({ ...(await o<object>()), connection: async () => {} }));
vi.mock("next/cache", async (o) => ({ ...(await o<object>()), refresh: vi.fn() }));

let h: Harness;
let cycleId: string;
beforeEach(async () => {
  h = await setup();
  session.email = "sam@example.com";
  cycleId = (await activeCycle(h.db))!.id;
});
afterEach(() => h.close());

const overrides = () =>
  h.db.select().from(groceryCycleOverride).where(eq(groceryCycleOverride.cycleId, cycleId));

describe("This Week", () => {
  it("adds a catalog item by exact name, or free text, attributed to the member", async () => {
    const before = (await overrides()).length;
    expect(await addToListAction(null, form({ cycleId, text: "eggs", quantity: 2 }))).toEqual({
      ok: true,
      message: "Added Eggs.",
    });
    expect(await addToListAction(null, form({ cycleId, text: "cake flour" }))).toMatchObject({
      ok: true,
    });
    const rows = (await overrides()).slice(before);
    const sam = await h.memberId("100000000000000002");
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "add",
        itemId: await h.itemId("Eggs"),
        quantity: 2,
        actorMemberId: sam,
      }),
      expect.objectContaining({ kind: "add", itemId: null, freeText: "cake flour", quantity: 1 }),
    ]);
    expect(refresh).toHaveBeenCalled();
    const [t] = await h.db
      .select()
      .from(systemTelemetry)
      .where(
        and(eq(systemTelemetry.metricType, "ui_action"), eq(systemTelemetry.source, "session")),
      );
    expect(t!.payload).toMatchObject({ action: "add_to_list", ok: true });
  });

  it("skip / add back / quantity", async () => {
    const eggs = await h.itemId("Eggs");
    await skipItemAction(null, form({ cycleId, itemId: eggs }));
    await unskipItemAction(null, form({ cycleId, itemId: eggs }));
    await setQuantityAction(null, form({ cycleId, itemId: eggs, quantity: 3 }));
    expect((await overrides()).slice(-3).map((o) => o.kind)).toEqual(["skip", "add", "qty"]);
    expect(await setQuantityAction(null, form({ cycleId, itemId: eggs, quantity: 0 }))).toEqual({
      ok: false,
      error: "Quantity must be more than 0",
    });
  });

  it("a stale cycle id is a message, not a crash", async () => {
    expect(await addToListAction(null, form({ cycleId: "old", text: "milk" }))).toEqual({
      ok: false,
      error: "This week's list changed — refresh and try again.",
    });
  });

  it("skip the week, then open the next list", async () => {
    await cycleStatusAction(null, form({ cycleId, status: "skipped" }));
    expect(await activeCycle(h.db)).toBeNull();
    expect(await openCycleAction()).toMatchObject({ ok: true });
    expect(await activeCycle(h.db)).not.toBeNull();
    expect(await cycleStatusAction(null, form({ cycleId, status: "bogus" }))).toMatchObject({
      ok: false,
    });
  });

  it("we're out / running low / count", async () => {
    const eggs = await h.itemId("Eggs");
    const status = async () =>
      (await loadEstimates(h.db, h.now(), DEFAULT_CONFIG, [eggs])).get(eggs)!.estimate.status;
    await markItemAction(null, form({ itemId: eggs, mark: "low" }));
    expect(await status()).toBe("critical");
    await markItemAction(null, form({ itemId: eggs, mark: "out" }));
    expect(await status()).toBe("consumed");
    expect(await markItemAction(null, form({ itemId: eggs, mark: "count", quantity: 12 }))).toEqual(
      {
        ok: true,
        message: "Count saved.",
      },
    );
    expect(await status()).toBe("stocked");
    expect(await markItemAction(null, form({ itemId: eggs, mark: "count" }))).toMatchObject({
      ok: false,
    });
  });

  it("someone outside the allowlist can't act", async () => {
    session.email = "stranger@example.com";
    expect(await redirectOf(addToListAction(null, form({ cycleId, text: "milk" })))).toBe(
      "/sign-in",
    );
  });
});

describe("Cleanup", () => {
  it("one confirm resolves the receipt review and returns to Cleanup", async () => {
    const [r] = await h.db
      .select()
      .from(reviewItem)
      .where(and(eq(reviewItem.kind, "receipt"), eq(reviewItem.status, "pending")));
    const line = (await receiptReviewDetail(h.db, r!.id)).lines.find(
      (l) => l.state === "provisional",
    )!;
    const to = await redirectOf(
      answerReceiptAction(null, form({ reviewId: r!.id, [`line:${line.id}`]: "keep" })),
    );
    expect(to).toBe("/cleanup?done=receipt");
    const [after] = await h.db.select().from(reviewItem).where(eq(reviewItem.id, r!.id));
    expect(after!.status).toBe("confirmed");
    const [rec] = await h.db.select().from(receipt).where(eq(receipt.id, r!.receiptId!));
    expect(rec!.status).toBe("applied");
    // Answering again is a message.
    expect(
      await answerReceiptAction(null, form({ reviewId: r!.id, [`line:${line.id}`]: "keep" })),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/already confirmed/) });
  });

  it("merge a new product into an existing item; dismiss a failed job", async () => {
    const [np] = await h.db.select().from(reviewItem).where(eq(reviewItem.kind, "new_product"));
    const target = await h.itemId("Oat Milk");
    expect(
      await mergeAction(null, form({ reviewId: np!.id, itemId: np!.itemId!, intoItemId: target })),
    ).toEqual({ ok: true, message: "Merged." });
    const [src] = await h.db.select().from(item).where(eq(item.id, np!.itemId!));
    expect(src!.mergedIntoItemId).toBe(target);
    const [fj] = await h.db.select().from(reviewItem).where(eq(reviewItem.kind, "failed_job"));
    await dismissAction(null, form({ reviewId: fj!.id }));
    const [after] = await h.db.select().from(reviewItem).where(eq(reviewItem.id, fj!.id));
    expect(after!.status).toBe("dismissed");
  });
});

describe("Pantry & Settings", () => {
  it("edits item settings; blank fields clear them", async () => {
    const milk = await h.itemId("Oat Milk");
    await updateItemSettingsAction(
      null,
      form({ itemId: milk, auditHint: "check the door", shelfLifeDays: 10, reorderThreshold: "" }),
    );
    const [row] = await h.db.select().from(item).where(eq(item.id, milk));
    expect(row).toMatchObject({
      auditHint: "check the door",
      shelfLifeDays: 10,
      reorderThreshold: null,
    });
  });

  it("adds and removes an away period", async () => {
    expect(
      await addAwayAction(
        null,
        form({ startsOn: "2026-11-01", endsOn: "2026-11-04", note: "Tahoe" }),
      ),
    ).toMatchObject({ ok: true });
    const [a] = await h.db.select().from(awayPeriod).where(eq(awayPeriod.note, "Tahoe"));
    expect(a).toMatchObject({ startsOn: "2026-11-01", endsOn: "2026-11-04" });
    expect(
      await addAwayAction(null, form({ startsOn: "2026-11-05", endsOn: "2026-11-01" })),
    ).toMatchObject({
      ok: false,
    });
    await deleteAwayAction(null, form({ id: a!.id }));
    expect(await h.db.select().from(awayPeriod).where(eq(awayPeriod.note, "Tahoe"))).toHaveLength(
      0,
    );
  });

  it("saves only changed thresholds", async () => {
    await updateTunablesAction(null, form({ lowWithinDays: 4, cartCoverDays: 7 }));
    const [t] = await h.db
      .select()
      .from(systemTelemetry)
      .where(eq(systemTelemetry.metricType, "settings_changed"));
    expect(t!.payload).toEqual({ keys: ["lowWithinDays"] });
  });
});
