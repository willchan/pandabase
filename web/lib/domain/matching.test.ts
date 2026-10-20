import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import {
  confirmedAlias,
  deriveItemName,
  matchDigitalLine,
  matchPaperLine,
  normalizeReceiptText,
  parseUnitQuantity,
  ratio,
  toBaseUnits,
  tokenSetRatio,
  type Alias,
} from "./matching";

const config = DEFAULT_CONFIG;

describe("normalizeReceiptText", () => {
  it.each([
    ["  365 org large eggs   $5.99 ", "365 ORG LARGE EGGS"],
    ["BANANAS 4011 0.79 lb", "BANANAS LB"],
    ["Oat-Milk, Barista (32oz)", "OAT MILK BARISTA 32OZ"],
    ["CHKN THIGH 012345678905 -1.50", "CHKN THIGH"],
    ["Ben & Jerry's 100%", "BEN & JERRY S 100%"],
    ["12 CT EGGS €3,49", "12 CT EGGS"],
  ])("%j → %j", (raw, out) => expect(normalizeReceiptText(raw)).toBe(out));
});

describe("ratio / tokenSetRatio", () => {
  it.each([
    ["", "", 1],
    ["abc", "abc", 1],
    ["abc", "xyz", 0],
    ["kitten", "sitting", 8 / 13],
  ])("ratio(%j, %j)", (a, b, out) => expect(ratio(a, b)).toBeCloseTo(out, 9));

  it.each([
    ["word order doesn't matter", "LARGE EGGS ORG", "ORG LARGE EGGS", 1],
    ["subset scores 1", "EGGS", "ORG LARGE EGGS", 1],
    ["empty side", "", "EGGS", 0],
    ["no shared tokens", "EGGS", "MILK", 0],
    ["partial overlap", "ORG WHOLE MILK", "ORG OAT MILK", 0.8],
    ["typo", "BANANAS", "BANANA", 12 / 13],
  ])("%s", (_, a, b, out) => expect(tokenSetRatio(a, b)).toBeCloseTo(out, 9));
});

const alias = (vendorString: string, o: Partial<Alias> = {}): Alias => ({
  vendor: "wholefoods",
  kind: "receipt_text",
  vendorString,
  itemId: "eggs",
  productId: "p-eggs",
  confidenceScore: 1,
  ignored: false,
  ...o,
});
const aliases: Alias[] = [
  alias("365 ORG LARGE EGGS"),
  alias("ORG BANANAS", { itemId: "bananas", productId: null, confidenceScore: 0.9 }),
  alias("BAG FEE", { itemId: null, productId: null, ignored: true }),
  alias("CRV", { itemId: null, productId: null, ignored: true }),
  alias("WHOLE MILK GAL", { vendor: "safeway", itemId: "milk", productId: null }),
];
const items = [
  { id: "eggs", canonicalName: "Eggs" },
  { id: "oat", canonicalName: "Oat Milk" },
  { id: "whole", canonicalName: "Whole Milk" },
  { id: "spinach", canonicalName: "Baby Spinach" },
];

describe("matchPaperLine — DESIGN §4.5 table", () => {
  it.each([
    [
      "exact alias with confidence 1.0 → apply, confirmed",
      "365 ORG LARGE EGGS 5.99",
      {
        kind: "exact",
        itemId: "eggs",
        productId: "p-eggs",
        trust: "confirmed",
        matchMethod: "alias_exact",
        score: 1,
      },
    ],
    [
      "exact alias below 1.0 → fuzzy, provisional",
      "ORG BANANAS",
      { kind: "fuzzy", itemId: "bananas", trust: "provisional", via: "alias", score: 1 },
    ],
    [
      "fuzzy ≥ 0.85 vs this vendor's aliases → apply, provisional",
      "365 ORG LRG EGGS",
      {
        kind: "fuzzy",
        itemId: "eggs",
        productId: "p-eggs",
        trust: "provisional",
        matchMethod: "fuzzy",
        via: "alias",
      },
    ],
    [
      "then canonical names",
      "BABY SPINACH 5OZ",
      { kind: "fuzzy", itemId: "spinach", productId: null, via: "canonical_name" },
    ],
    ["ties on token-set break on the whole string", "OAT MILK", { kind: "fuzzy", itemId: "oat" }],
    [
      "other vendors' aliases are not used",
      "WHOLE MILK GAL",
      { kind: "fuzzy", itemId: "whole", via: "canonical_name" },
    ],
    ["ignored alias (bag fee) → skip", "BAG FEE 0.10", { kind: "ignored", normalized: "BAG FEE" }],
    ["ignored alias (CRV) → skip", "CRV", { kind: "ignored" }],
    ["else → pending", "DRAGONFRUIT", { kind: "none", normalized: "DRAGONFRUIT" }],
  ] as const)("%s", (_, rawText, expected) => {
    expect(matchPaperLine({ rawText, vendor: "wholefoods", aliases, items, config })).toMatchObject(
      expected,
    );
  });

  it("reports the best near miss for the review", () => {
    const m = matchPaperLine({
      rawText: "ORG EGGPLANT",
      vendor: "wholefoods",
      aliases,
      items,
      config,
    });
    expect(m.kind).toBe("none");
    if (m.kind === "none") {
      expect(m.bestScore).toBeGreaterThan(0);
      expect(m.bestScore).toBeLessThan(0.85);
      expect(m.bestItemId).not.toBeNull();
    }
  });

  it("no aliases and no items → pending with score 0", () => {
    expect(
      matchPaperLine({ rawText: "EGGS", vendor: "wholefoods", aliases: [], items: [], config }),
    ).toEqual({ kind: "none", normalized: "EGGS", bestScore: 0, bestItemId: null });
  });

  it("the threshold is a config knob", () => {
    const strict = { ...config, matching: { fuzzyApplyThreshold: 0.99 } };
    const line = { rawText: "365 ORG LRG EGGS", vendor: "wholefoods", aliases, items: [] };
    expect(matchPaperLine({ ...line, config }).kind).toBe("fuzzy");
    expect(matchPaperLine({ ...line, config: strict }).kind).toBe("none");
  });
});

describe("matchDigitalLine", () => {
  const asinAliases: Alias[] = [
    alias("B0ALIAS", { vendor: "amazon", kind: "asin", itemId: "tp", productId: null }),
    alias("B0IGNORE", {
      vendor: "amazon",
      kind: "asin",
      itemId: null,
      productId: null,
      ignored: true,
    }),
  ];
  const products = [{ id: "p1", itemId: "eggs", vendor: "amazon", asin: "B0PRODUCT" }];
  it.each([
    ["alias(kind=asin)", "b0alias", { kind: "known", itemId: "tp", productId: null, via: "alias" }],
    [
      "product.asin",
      " B0PRODUCT ",
      { kind: "known", itemId: "eggs", productId: "p1", via: "product" },
    ],
    ["ignored ASIN", "B0IGNORE", { kind: "ignored" }],
    ["unknown ASIN", "B0NEW", { kind: "unknown" }],
  ] as const)("%s", (_, asin, out) => {
    expect(matchDigitalLine({ asin, vendor: "amazon", aliases: asinAliases, products })).toEqual(
      out,
    );
  });

  it("ignores other vendors' products", () => {
    expect(
      matchDigitalLine({ asin: "B0PRODUCT", vendor: "wholefoods", aliases: [], products }),
    ).toEqual({ kind: "unknown" });
  });
});

describe("parseUnitQuantity / toBaseUnits — 12 vs 18 pack", () => {
  it.each([
    ["Pete and Gerry's Organic Eggs, 12 Count", 12],
    ["Vital Farms Pasture-Raised Eggs, 18 ct", 18],
    ["Sparkling Water, Pack of 6", 6],
    ["Paper Towels 12-Pack", 12],
    ["Bounty Select-A-Size (8)", 8],
    ["Large Brown Eggs, 1 Dozen", 12],
    ["Half Dozen Eggs", 6],
    ["Olive Oil 500ml", null],
    ["Pack of 0", null],
  ])("%j → %j", (title, n) => expect(parseUnitQuantity(title)).toBe(n));

  it.each([
    [1, 12, 12],
    [1, 18, 18],
    [2, 12, 24],
    [1.5, 1, 1.5],
  ])("%i × %i = %i base units", (q, u, out) => expect(toBaseUnits(q, u)).toBe(out));
});

describe("deriveItemName", () => {
  it.each([
    ["KIRKLAND Signature Paper Towels, 12 Count", "Kirkland Signature Paper Towels"],
    ["Brand Kombucha - Ginger (12 fl oz)", "Brand Kombucha"],
    ["Pack of 6", "Pack of 6"],
    ["Organic Rolled Oats 32 oz | Bulk", "Organic Rolled Oats"],
  ])("%j → %j", (title, name) => expect(deriveItemName(title)).toBe(name));
});

describe("confirmedAlias", () => {
  it("creates a confirmed 1.0 alias", () => {
    expect(
      confirmedAlias({
        vendor: "wholefoods",
        normalized: "ORG EGGS",
        itemId: "eggs",
        productId: null,
        existing: null,
      }),
    ).toEqual({
      vendor: "wholefoods",
      kind: "receipt_text",
      vendorString: "ORG EGGS",
      itemId: "eggs",
      productId: null,
      confidenceScore: 1,
      ignored: false,
      trust: "confirmed",
      created: true,
    });
  });
  it("strengthens an existing alias, keeping its product", () => {
    const existing = alias("ORG BANANAS", {
      itemId: "bananas",
      productId: "p-ban",
      confidenceScore: 0.9,
    });
    expect(
      confirmedAlias({
        vendor: "wholefoods",
        normalized: "ORG BANANAS",
        itemId: "bananas",
        productId: null,
        existing,
      }),
    ).toMatchObject({ confidenceScore: 1, productId: "p-ban", created: false });
  });
});
