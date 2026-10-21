import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config } from "../config";
import {
  mergeSuggestionReviews,
  planMergeSuggestBatches,
  scheduledMergeSuggestRun,
  type ExistingSuggestion,
  type MergeCatalogItem,
  type MergeSuggestion,
} from "./mergeSuggest";

const NOW = "2026-10-20T12:00:00.000Z";

const cfg = (mergeSuggest: Partial<Config["mergeSuggest"]> = {}): Config => ({
  ...DEFAULT_CONFIG,
  mergeSuggest: { ...DEFAULT_CONFIG.mergeSuggest, ...mergeSuggest },
});

const it_ = (id: string, name: string, over: Partial<MergeCatalogItem> = {}): MergeCatalogItem => ({
  id,
  name,
  category: "Uncategorized",
  trust: "unverified",
  mergedIntoItemId: null,
  aliases: [],
  ...over,
});
const confirmed = (id: string, name: string, category: string) =>
  it_(id, name, { trust: "confirmed", category });

const CATALOG: MergeCatalogItem[] = [
  confirmed("eggs", "Eggs", "dairy"),
  confirmed("milk", "Whole Milk", "dairy"),
  confirmed("towels", "Paper Towels", "household"),
  confirmed("tissues", "Facial Tissues", "household"),
  it_("hh-eggs", "Happy Hen Organic Large Eggs", {
    aliases: ["Happy Hen Organic Large Eggs, 12 ct"],
  }),
  it_("bounty", "Bounty Select-A-Size Paper Towels"),
  it_("old", "Old Item", { mergedIntoItemId: "eggs" }),
];

const ids = (b: { input: { items: { item_id: string }[] } }) => b.input.items.map((i) => i.item_id);

describe("planMergeSuggestBatches", () => {
  it("sends one job with every candidate and every confirmed item when it fits", () => {
    const [b, ...rest] = planMergeSuggestBatches(CATALOG, cfg());
    expect(rest).toEqual([]);
    expect(ids(b!)).toEqual(["bounty", "hh-eggs", "eggs", "tissues", "towels", "milk"]);
    expect(b!.candidateIds).toEqual(["bounty", "hh-eggs"]);
    // Merged items are never sent; aliases go along (minus the name itself).
    expect(b!.input.items.find((i) => i.item_id === "hh-eggs")).toEqual({
      item_id: "hh-eggs",
      name: "Happy Hen Organic Large Eggs",
      aliases: ["Happy Hen Organic Large Eggs, 12 ct"],
    });
    expect(b!.input.items.find((i) => i.item_id === "eggs")).toEqual({
      item_id: "eggs",
      name: "Eggs",
    });
  });

  it.each([
    ["no unverified items", CATALOG.filter((i) => i.trust === "confirmed")],
    [
      "only merged unverified items",
      [...CATALOG.slice(0, 4), it_("x", "X", { mergedIntoItemId: "eggs" })],
    ],
    ["a lone unverified item and nothing else", [it_("solo", "Solo")]],
    ["an empty catalog", []],
  ])("queues nothing with %s", (_, catalog) => {
    expect(planMergeSuggestBatches(catalog, cfg())).toEqual([]);
  });

  it("pairs two unverified items even without confirmed ones", () => {
    const out = planMergeSuggestBatches([it_("a", "Oat Milk"), it_("b", "Oatly Oat Milk")], cfg());
    expect(out.map(ids)).toEqual([["a", "b"]]);
  });

  it("splits into several jobs, each candidate with its closest confirmed items", () => {
    const out = planMergeSuggestBatches(CATALOG, cfg({ batchSize: 3, targetsPerItem: 1 }));
    // Grouped by the closest target's category: dairy (eggs) before household (towels); a group
    // that doesn't fit the current job starts the next one.
    expect(out.map(ids)).toEqual([
      ["hh-eggs", "eggs"],
      ["bounty", "towels"],
    ]);
    expect(out.map((b) => b.candidateIds)).toEqual([["hh-eggs"], ["bounty"]]);
    for (const b of out) expect(b.input.items.length).toBeLessThanOrEqual(3);
  });

  it("keeps look-alike new items in the same job and shares their targets", () => {
    const catalog = [
      ...CATALOG,
      it_("vital", "Vital Farms Pasture Raised Eggs"),
      it_("brawny", "Brawny Paper Towels", { category: "household" }),
    ];
    const out = planMergeSuggestBatches(catalog, cfg({ batchSize: 5, targetsPerItem: 1 }));
    expect(out.map(ids)).toEqual([
      ["hh-eggs", "eggs", "vital"],
      ["bounty", "towels", "brawny"],
    ]);
  });

  it.each([
    ["batchSize below the contract minimum", { batchSize: 1, targetsPerItem: 5 }, 2],
    ["batchSize above the contract maximum", { batchSize: 1000, targetsPerItem: 500 }, 150],
  ])("clamps %s", (_, over, max) => {
    const many = [
      ...Array.from({ length: 200 }, (_, i) => it_(`u${String(i).padStart(3, "0")}`, `Thing ${i}`)),
      ...Array.from({ length: 40 }, (_, i) => confirmed(`c${i}`, `Known ${i}`, "pantry")),
    ];
    const out = planMergeSuggestBatches(many, cfg(over));
    expect(out.length).toBeGreaterThan(1);
    for (const b of out) {
      expect(b.input.items.length).toBeLessThanOrEqual(max);
      expect(b.input.items.length).toBeGreaterThanOrEqual(2);
    }
    // Every candidate is asked about exactly once.
    const asked = out.flatMap((b) => b.candidateIds).sort();
    expect(asked).toEqual(many.filter((i) => i.trust === "unverified").map((i) => i.id));
  });

  it("truncates long names and aliases to the contract's 200 chars and caps aliases", () => {
    const long = "x".repeat(300);
    const [b] = planMergeSuggestBatches(
      [it_("a", long, { aliases: ["a1", "a2", "a3", " ", "a1"] }), confirmed("b", "B", "pantry")],
      cfg({ aliasesPerItem: 2 }),
    );
    expect(b!.input.items[0]).toEqual({
      item_id: "a",
      name: "x".repeat(200),
      aliases: ["a1", "a2"],
    });
  });
});

describe("scheduledMergeSuggestRun", () => {
  const base = { lastRunAt: null, newUnverifiedItems: 10, openJobs: 0, now: NOW };
  it.each([
    ["first run with enough new items", base, { run: true }],
    ["a job still queued", { ...base, openJobs: 1 }, { run: false, reason: "already_queued" }],
    [
      "last run 6 days ago",
      { ...base, lastRunAt: "2026-10-14T12:00:00.000Z" },
      { run: false, reason: "too_soon" },
    ],
    ["last run 7 days ago", { ...base, lastRunAt: "2026-10-13T12:00:00.000Z" }, { run: true }],
    [
      "too few new items",
      { ...base, newUnverifiedItems: 9 },
      { run: false, reason: "too_few_new_items" },
    ],
  ] as const)("%s", (_, input, expected) => {
    expect(scheduledMergeSuggestRun(input, cfg())).toEqual(expected);
  });

  it("never runs on zero new items, even with minNewItems 0", () => {
    expect(
      scheduledMergeSuggestRun({ ...base, newUnverifiedItems: 0 }, cfg({ minNewItems: 0 })),
    ).toEqual({
      run: false,
      reason: "too_few_new_items",
    });
  });
});

describe("mergeSuggestionReviews", () => {
  const items = new Map(
    [
      ["eggs", "confirmed", null],
      ["milk", "confirmed", null],
      ["hh-eggs", "unverified", null],
      ["vital", "unverified", null],
      ["old", "unverified", "eggs"],
      ["older", "unverified", "old"],
      ["loop-a", "unverified", "loop-b"],
      ["loop-b", "unverified", "loop-a"],
    ].map(([id, trust, into]) => [
      id!,
      { trust: trust as "confirmed" | "unverified", mergedIntoItemId: into ?? null },
    ]),
  );
  const s = (
    item_id: string,
    merge_into_item_id: string,
    confidence = 0.9,
    reason?: string,
  ): MergeSuggestion => ({
    item_id,
    merge_into_item_id,
    confidence,
    reason,
  });
  const run = (suggestions: MergeSuggestion[], existing: ExistingSuggestion[] = [], c = cfg()) =>
    mergeSuggestionReviews({ suggestions, items, existing, now: NOW }, c);
  const pairs = (r: ReturnType<typeof run>) =>
    r.reviews.map((x) => [x.itemId, x.payload.merge_into_item_id]);

  it("creates a pending 30-day review whose default does nothing", () => {
    const r = run([s("hh-eggs", "eggs", 0.92, "  same product, brand name  ")]);
    expect(r.reviews).toEqual([
      {
        kind: "merge_suggestion",
        status: "pending",
        defaultAction: { action: "none" },
        expiresAt: "2026-11-19T12:00:00.000Z",
        impactScore: 1,
        urgency: "cleanup",
        itemId: "hh-eggs",
        payload: {
          merge_into_item_id: "eggs",
          confidence: 0.92,
          reason: "same product, brand name",
        },
      },
    ]);
    expect(Object.values(r.dropped).every((n) => n === 0)).toBe(true);
  });

  it.each([
    ["an item into itself", [s("eggs", "eggs")], "self"],
    ["an unknown source", [s("nope", "eggs")], "unknown"],
    ["an unknown target", [s("hh-eggs", "nope")], "unknown"],
    ["a source merged meanwhile", [s("old", "eggs")], "merged"],
    ["a target merged into the source", [s("eggs", "old")], "self"],
    ["a target in a merge loop", [s("hh-eggs", "loop-a")], "merged"],
    ["two confirmed items", [s("milk", "eggs")], "both_confirmed"],
    ["low confidence", [s("hh-eggs", "eggs", 0.49)], "low_confidence"],
  ] as const)("drops %s", (_, suggestions, reason) => {
    const r = run([...suggestions]);
    expect(r.reviews).toEqual([]);
    expect(r.dropped[reason]).toBe(1);
  });

  it("follows a merged target to the item it went into", () => {
    expect(pairs(run([s("hh-eggs", "older")]))).toEqual([["hh-eggs", "eggs"]]);
  });

  it("merges the unverified side into the confirmed one", () => {
    expect(pairs(run([s("eggs", "hh-eggs")]))).toEqual([["hh-eggs", "eggs"]]);
  });

  it.each([
    ["pending", "pending", 1],
    ["dismissed", "dismissed", 1],
    ["expired (asked again)", "expired", 0],
  ] as const)("dedupes against an existing %s suggestion for the same pair", (_, status, dup) => {
    const r = run([s("hh-eggs", "eggs")], [{ itemId: "eggs", mergeIntoItemId: "hh-eggs", status }]);
    expect(r.dropped.duplicate).toBe(dup);
    expect(r.reviews).toHaveLength(1 - dup);
  });

  it("keeps one suggestion per pair and per item, the most confident", () => {
    const r = run([
      s("hh-eggs", "vital", 0.6),
      s("hh-eggs", "eggs", 0.95),
      s("eggs", "hh-eggs", 0.9),
      s("vital", "eggs", 0.8),
    ]);
    expect(pairs(r)).toEqual([
      ["hh-eggs", "eggs"],
      ["vital", "eggs"],
    ]);
    expect(r.dropped.duplicate).toBe(2);
  });

  it("respects a configured minConfidence", () => {
    expect(run([s("hh-eggs", "eggs", 0.3)], [], cfg({ minConfidence: 0.2 })).reviews).toHaveLength(
      1,
    );
  });
});
