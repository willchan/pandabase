// DESIGN §4.5 — receipt-line normalization, fuzzy matching and alias rules.
import type { Config } from "../config";

/**
 * Normalize paper-receipt text: upper-case, drop prices and long numeric codes (PLU/UPC), drop
 * punctuation, collapse whitespace. Short numbers ("12 CT") are kept — they carry pack sizes.
 */
export function normalizeReceiptText(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[$€£]?\s*-?\d+[.,]\d{2}\b/g, " ")
    .replace(/\b\d{4,}\b/g, " ")
    .replace(/[^A-Z0-9&%\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Indel similarity in [0, 1] (rapidfuzz `ratio` / 100): 1 − indel_distance / (|a| + |b|). */
export function ratio(a: string, b: string): number {
  if (a.length + b.length === 0) return 1;
  // LCS length via a rolling DP row.
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      row[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!);
    }
    prev = row;
  }
  return (2 * prev[b.length]!) / (a.length + b.length);
}

const tokens = (s: string): string[] => [...new Set(s.split(/\s+/).filter(Boolean))].sort();

/**
 * Token-set ratio in [0, 1] (as rapidfuzz `token_set_ratio` / 100): compares the sorted shared
 * tokens against each side's sorted tokens, so word order and extra words matter little.
 */
export function tokenSetRatio(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const setB = new Set(tb);
  const inter = ta.filter((t) => setB.has(t));
  const setA = new Set(ta);
  const onlyA = ta.filter((t) => !setB.has(t));
  const onlyB = tb.filter((t) => !setA.has(t));
  const t0 = inter.join(" ");
  const t1 = [t0, onlyA.join(" ")].filter(Boolean).join(" ");
  const t2 = [t0, onlyB.join(" ")].filter(Boolean).join(" ");
  if (inter.length > 0 && (onlyA.length === 0 || onlyB.length === 0)) return 1;
  return Math.max(
    inter.length ? ratio(t0, t1) : 0,
    inter.length ? ratio(t0, t2) : 0,
    ratio(t1, t2),
  );
}

/** A `vendor_alias` row (normalized `vendorString`). */
export interface Alias {
  vendor: string;
  kind: "receipt_text" | "asin";
  vendorString: string;
  itemId: string | null;
  productId: string | null;
  confidenceScore: number;
  ignored: boolean;
}

export interface CanonicalItem {
  id: string;
  canonicalName: string;
}

export type LineMatch =
  | { kind: "ignored"; normalized: string }
  | {
      kind: "exact" | "fuzzy";
      normalized: string;
      itemId: string;
      productId: string | null;
      score: number;
      /** `alias_exact` or `fuzzy` (receipt_line.match_method). */
      matchMethod: "alias_exact" | "fuzzy";
      /** Event / line trust: exact human-confirmed alias → confirmed; fuzzy → provisional. */
      trust: "confirmed" | "provisional";
      /** What the fuzzy match hit: a vendor alias or an item's canonical name. */
      via: "alias" | "canonical_name";
    }
  | { kind: "none"; normalized: string; bestScore: number; bestItemId: string | null };

/**
 * §4.5 paper-line resolution: exact confirmed alias → apply (confirmed); ignored alias → skip;
 * fuzzy ≥ threshold against this vendor's aliases, then all canonical names → apply
 * (provisional); else pending review.
 */
export function matchPaperLine(input: {
  rawText: string;
  vendor: string;
  aliases: readonly Alias[];
  items: readonly CanonicalItem[];
  config: Config;
}): LineMatch {
  const normalized = normalizeReceiptText(input.rawText);
  const vendorAliases = input.aliases.filter(
    (a) => a.vendor === input.vendor && a.kind === "receipt_text",
  );
  const exact = vendorAliases.find((a) => a.vendorString === normalized);
  if (exact?.ignored) return { kind: "ignored", normalized };
  if (exact && exact.itemId && exact.confidenceScore >= 1) {
    return {
      kind: "exact",
      normalized,
      itemId: exact.itemId,
      productId: exact.productId,
      score: 1,
      matchMethod: "alias_exact",
      trust: "confirmed",
      via: "alias",
    };
  }

  const threshold = input.config.matching.fuzzyApplyThreshold;
  // Token-set ratio scores subsets as 1.0 ("MILK" vs "OAT MILK" and "WHOLE MILK"), so ties break
  // on the plain ratio of the whole strings.
  const best = <T>(cands: readonly T[], text: (c: T) => string) => {
    let top: { c: T; score: number; tie: number } | null = null;
    for (const c of cands) {
      const score = tokenSetRatio(normalized, text(c));
      const tie = ratio(normalized, text(c));
      if (!top || score > top.score || (score === top.score && tie > top.tie))
        top = { c, score, tie };
    }
    return top;
  };
  const aliasHit = best(
    vendorAliases.filter((a) => !a.ignored && a.itemId),
    (a) => a.vendorString,
  );
  if (aliasHit && aliasHit.score >= threshold) {
    return {
      kind: "fuzzy",
      normalized,
      itemId: aliasHit.c.itemId!,
      productId: aliasHit.c.productId,
      score: aliasHit.score,
      matchMethod: "fuzzy",
      trust: "provisional",
      via: "alias",
    };
  }
  const nameHit = best(input.items, (i) => normalizeReceiptText(i.canonicalName));
  if (nameHit && nameHit.score >= threshold) {
    return {
      kind: "fuzzy",
      normalized,
      itemId: nameHit.c.id,
      productId: null,
      score: nameHit.score,
      matchMethod: "fuzzy",
      trust: "provisional",
      via: "canonical_name",
    };
  }
  const top = [
    aliasHit && { score: aliasHit.score, itemId: aliasHit.c.itemId },
    nameHit && { score: nameHit.score, itemId: nameHit.c.id },
  ]
    .filter((x): x is { score: number; itemId: string | null } => !!x)
    .sort((a, b) => b.score - a.score)[0];
  return { kind: "none", normalized, bestScore: top?.score ?? 0, bestItemId: top?.itemId ?? null };
}

/** A product row reachable by ASIN. */
export interface AsinProduct {
  id: string;
  itemId: string;
  vendor: string;
  asin: string | null;
}

export type DigitalLineMatch =
  | { kind: "ignored" }
  | { kind: "known"; itemId: string; productId: string | null; via: "alias" | "product" }
  | { kind: "unknown" };

/** §4.5 digital-line resolution: `vendor_alias(kind=asin)`, then `product.asin`. */
export function matchDigitalLine(input: {
  asin: string;
  vendor: string;
  aliases: readonly Alias[];
  products: readonly AsinProduct[];
}): DigitalLineMatch {
  const asin = input.asin.trim().toUpperCase();
  const alias = input.aliases.find(
    (a) => a.vendor === input.vendor && a.kind === "asin" && a.vendorString.toUpperCase() === asin,
  );
  if (alias?.ignored) return { kind: "ignored" };
  if (alias?.itemId) {
    return { kind: "known", itemId: alias.itemId, productId: alias.productId, via: "alias" };
  }
  const product = input.products.find(
    (p) => p.vendor === input.vendor && p.asin?.toUpperCase() === asin,
  );
  if (product)
    return { kind: "known", itemId: product.itemId, productId: product.id, via: "product" };
  return { kind: "unknown" };
}

const WORD_NUMBERS: Record<string, number> = { dozen: 12, "half dozen": 6 };

/**
 * Base units per purchase unit from a product title ("Eggs, 18 Count", "Pack of 6", "12-Pack",
 * "a dozen"). Null when no count is found — the caller then uses 1, unverified.
 */
export function parseUnitQuantity(title: string): number | null {
  const t = title.toLowerCase();
  const patterns = [
    /pack of (\d+(?:\.\d+)?)/,
    /(\d+(?:\.\d+)?)\s*-?\s*(?:count|ct|pack|pk|pcs|pieces|rolls|eggs)\b/,
    /\((\d+(?:\.\d+)?)\)/,
  ];
  for (const re of patterns) {
    const m = re.exec(t);
    if (m) {
      const n = Number(m[1]);
      if (n > 0) return n;
    }
  }
  for (const [word, n] of Object.entries(WORD_NUMBERS).sort((a, b) => b[0].length - a[0].length)) {
    if (t.includes(word)) return n;
  }
  return null;
}

/** Title-derived name for an auto-created item: text before the first comma/dash, sizes removed. */
export function deriveItemName(title: string): string {
  const head = title.split(/,| - | – |\|/)[0] ?? title;
  const cleaned = head
    .replace(/\(.*?\)/g, " ")
    .replace(
      /\b(pack of \d+|\d+(\.\d+)?\s*-?\s*(count|ct|pack|pk|oz|fl oz|lb|lbs|g|kg|ml|l)\b)/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter(Boolean).slice(0, 6);
  const name = words
    .map((w) => (w === w.toUpperCase() && w.length > 3 ? w[0] + w.slice(1).toLowerCase() : w))
    .join(" ");
  return name || title.trim();
}

/** Base units for a receipt line: purchase units × base units per purchase unit (12 vs 18 eggs). */
export const toBaseUnits = (qty: number, unitQuantity: number): number => qty * unitQuantity;

/**
 * The alias write when a human confirms (or corrects) a paper line: confidence 1.0, confirmed.
 * `existing` is the current alias for the same (vendor, receipt_text, normalized), if any.
 */
export function confirmedAlias(input: {
  vendor: string;
  normalized: string;
  itemId: string;
  productId: string | null;
  existing: Alias | null;
}): Alias & { trust: "confirmed"; created: boolean } {
  return {
    vendor: input.vendor,
    kind: "receipt_text",
    vendorString: input.normalized,
    itemId: input.itemId,
    productId: input.productId ?? input.existing?.productId ?? null,
    confidenceScore: 1,
    ignored: false,
    trust: "confirmed",
    created: input.existing === null,
  };
}
