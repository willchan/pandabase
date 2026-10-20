// The household-editable subset of `web/lib/config.ts` shown on Settings ("default thresholds").
import type { Config } from "./config";

export interface Tunable {
  key: string;
  label: string;
  hint: string;
  step: number;
  get: (c: Config) => number;
}

export const TUNABLES: Tunable[] = [
  {
    key: "lowWithinDays",
    label: "“Running low” window (days)",
    hint: "Items predicted to run out within this many days go in the cart.",
    step: 1,
    get: (c) => c.lowWithinDays,
  },
  {
    key: "cartCoverDays",
    label: "Cart covers (days)",
    hint: "How many days of use each cart line buys.",
    step: 1,
    get: (c) => c.cartCoverDays,
  },
  {
    key: "product.defaultSwitchThreshold",
    label: "Switch to a cheaper brand at",
    hint: "Fraction cheaper per unit (0.15 = 15%) for new items; each item learns its own.",
    step: 0.01,
    get: (c) => c.product.defaultSwitchThreshold,
  },
  {
    key: "matching.fuzzyApplyThreshold",
    label: "Receipt guess confidence",
    hint: "Paper-receipt matches at or above this score apply provisionally (0–1).",
    step: 0.01,
    get: (c) => c.matching.fuzzyApplyThreshold,
  },
  {
    key: "checkin.pleaseCheckMax",
    label: "Friday “please check” items",
    hint: "At most this many items to ask about.",
    step: 1,
    get: (c) => c.checkin.pleaseCheckMax,
  },
];
