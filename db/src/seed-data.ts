// Synthetic household catalog for the seed. Everything here is invented — no real data.
import type { LOCATIONS } from "./schema/common";

export type Location = (typeof LOCATIONS)[number];

export interface ProductSpec {
  vendor: "wholefoods" | "amazon";
  title: string;
  /** Base units per purchase unit. */
  unit: number;
  priceCents: number;
  asin?: string;
  /** Week index (0 = first seeded week) from which this product is the one bought. */
  from?: number;
  rejected?: boolean;
}

export interface ItemSpec {
  name: string;
  category: string;
  location: Location;
  tracking: "velocity" | "static";
  baseUnit: string;
  /** Simulation truth: days one base unit lasts in this household. */
  days: number;
  /** Seed `default_ema_days` from `days` (velocity items only). */
  defaultEma?: boolean;
  shelfLifeDays?: number;
  auditHint?: string;
  reorderThreshold?: number;
  products: ProductSpec[];
}

const wf = (title: string, unit: number, priceCents: number, from?: number): ProductSpec => ({
  vendor: "wholefoods",
  title,
  unit,
  priceCents,
  ...(from === undefined ? {} : { from }),
});
const amz = (
  title: string,
  asin: string,
  unit: number,
  priceCents: number,
  from?: number,
): ProductSpec => ({
  vendor: "amazon",
  title,
  asin,
  unit,
  priceCents,
  ...(from === undefined ? {} : { from }),
});

export const MEMBERS = [
  {
    email: "alex@example.com",
    displayName: "Alex",
    discordUserId: "100000000000000001",
    chromiumProfile: "alex",
    amazonSweep: "daily",
    isCartAccount: true,
  },
  {
    email: "sam@example.com",
    displayName: "Sam",
    discordUserId: "100000000000000002",
    chromiumProfile: "sam",
    amazonSweep: "weekly",
    isCartAccount: false,
  },
] as const;

export const ITEMS: ItemSpec[] = [
  // dairy & eggs
  {
    name: "Eggs",
    category: "dairy",
    location: "fridge",
    tracking: "velocity",
    baseUnit: "egg",
    days: 0.55,
    defaultEma: true,
    shelfLifeDays: 35,
    auditHint: "Cartons on the top shelf; count eggs, not cartons",
    products: [
      wf("365 Large Brown Eggs 12ct", 12, 499),
      wf("Pasture Hen Large Eggs 12ct", 12, 649, 11),
    ],
  },
  {
    name: "Whole Milk",
    category: "dairy",
    location: "fridge",
    tracking: "velocity",
    baseUnit: "oz",
    days: 0.08,
    defaultEma: true,
    shelfLifeDays: 10,
    products: [
      wf("365 Organic Whole Milk Half Gallon", 64, 459),
      wf("Valley Creamery Whole Milk 64oz", 64, 529, 17),
    ],
  },
  {
    name: "Greek Yogurt",
    category: "dairy",
    location: "fridge",
    tracking: "velocity",
    baseUnit: "oz",
    days: 0.22,
    shelfLifeDays: 21,
    products: [
      wf("Hillside Greek Yogurt Plain 32oz", 32, 649),
      wf("365 Greek Yogurt Plain 32oz", 32, 499, 8),
    ],
  },
  {
    name: "Butter",
    category: "dairy",
    location: "fridge",
    tracking: "velocity",
    baseUnit: "stick",
    days: 3,
    products: [wf("365 Unsalted Butter 4 Sticks", 4, 549)],
  },
  {
    name: "Cheddar Cheese",
    category: "dairy",
    location: "fridge",
    tracking: "velocity",
    baseUnit: "oz",
    days: 1,
    shelfLifeDays: 45,
    products: [wf("Coastline Sharp Cheddar 8oz", 8, 599)],
  },
  // produce
  {
    name: "Bananas",
    category: "produce",
    location: "pantry",
    tracking: "velocity",
    baseUnit: "count",
    days: 1.2,
    defaultEma: true,
    shelfLifeDays: 7,
    products: [wf("Organic Bananas Bunch", 6, 199)],
  },
  {
    name: "Apples",
    category: "produce",
    location: "fridge",
    tracking: "velocity",
    baseUnit: "count",
    days: 1.5,
    products: [wf("Organic Honeycrisp Apple", 1, 129)],
  },
  {
    name: "Baby Spinach",
    category: "produce",
    location: "fridge",
    tracking: "velocity",
    baseUnit: "oz",
    days: 0.8,
    shelfLifeDays: 7,
    auditHint: "Clamshell in the crisper drawer",
    products: [wf("365 Organic Baby Spinach 5oz", 5, 349)],
  },
  {
    name: "Avocados",
    category: "produce",
    location: "pantry",
    tracking: "velocity",
    baseUnit: "count",
    days: 2,
    shelfLifeDays: 6,
    products: [
      wf("Organic Hass Avocado", 1, 199),
      wf("Organic Hass Avocados Bag of 4", 4, 599, 13),
    ],
  },
  {
    name: "Carrots",
    category: "produce",
    location: "fridge",
    tracking: "velocity",
    baseUnit: "lb",
    days: 7,
    products: [wf("Organic Carrots 2lb Bag", 2, 249)],
  },
  {
    name: "Yellow Onions",
    category: "produce",
    location: "pantry",
    tracking: "velocity",
    baseUnit: "count",
    days: 3,
    products: [wf("Organic Yellow Onions 3lb Bag", 6, 399)],
  },
  {
    name: "Lemons",
    category: "produce",
    location: "fridge",
    tracking: "velocity",
    baseUnit: "count",
    days: 3,
    products: [wf("Organic Lemon", 1, 99)],
  },
  {
    name: "Strawberries",
    category: "produce",
    location: "fridge",
    tracking: "velocity",
    baseUnit: "oz",
    days: 0.3,
    shelfLifeDays: 5,
    products: [wf("Organic Strawberries 16oz", 16, 499)],
  },
  // meat, seafood, protein
  {
    name: "Chicken Thighs",
    category: "meat",
    location: "fridge",
    tracking: "velocity",
    baseUnit: "lb",
    days: 3.5,
    shelfLifeDays: 3,
    auditHint: "Check the freezer too — extras get moved there",
    products: [wf("Boneless Skinless Chicken Thighs", 1.5, 899)],
  },
  {
    name: "Ground Beef",
    category: "meat",
    location: "freezer",
    tracking: "velocity",
    baseUnit: "lb",
    days: 7,
    shelfLifeDays: 120,
    products: [wf("Grass-Fed Ground Beef 85/15 1lb", 1, 799)],
  },
  {
    name: "Salmon Fillet",
    category: "seafood",
    location: "freezer",
    tracking: "velocity",
    baseUnit: "lb",
    days: 10,
    shelfLifeDays: 90,
    products: [wf("Wild Sockeye Salmon Fillet Frozen", 1, 1299)],
  },
  {
    name: "Tofu",
    category: "protein",
    location: "fridge",
    tracking: "velocity",
    baseUnit: "block",
    days: 7,
    shelfLifeDays: 30,
    products: [wf("Organic Extra Firm Tofu 14oz", 1, 279)],
  },
  // bakery
  {
    name: "Sourdough Bread",
    category: "bakery",
    location: "pantry",
    tracking: "velocity",
    baseUnit: "loaf",
    days: 4,
    defaultEma: true,
    shelfLifeDays: 7,
    products: [
      wf("WF Bakery Sourdough Loaf", 1, 599),
      wf("Harbor Bakery Sourdough Batard", 1, 749, 20),
    ],
  },
  {
    name: "Tortillas",
    category: "bakery",
    location: "fridge",
    tracking: "velocity",
    baseUnit: "count",
    days: 0.7,
    products: [wf("Flour Tortillas 10ct", 10, 349)],
  },
  // beverages
  {
    name: "Coffee Beans",
    category: "beverages",
    location: "pantry",
    tracking: "velocity",
    baseUnit: "oz",
    days: 0.85,
    defaultEma: true,
    products: [
      wf("Ridgeline Roasters House Blend 12oz", 12, 1399),
      amz("Summit Coffee Dark Roast Whole Bean 18oz", "B0SEED0001", 18, 1499, 9),
    ],
  },
  {
    name: "Oat Milk",
    category: "beverages",
    location: "fridge",
    tracking: "velocity",
    baseUnit: "oz",
    days: 0.13,
    shelfLifeDays: 10,
    products: [
      wf("Oatfield Oat Milk Original 64oz", 64, 499),
      { ...wf("Silkish Oat Milk 64oz", 64, 399), rejected: true },
      wf("Meadow Oat Milk Barista 64oz", 64, 549, 15),
    ],
  },
  {
    name: "Sparkling Water",
    category: "beverages",
    location: "pantry",
    tracking: "velocity",
    baseUnit: "can",
    days: 0.5,
    products: [amz("Fizzwell Sparkling Water Lime 12pk", "B0SEED0002", 12, 599)],
  },
  {
    name: "Orange Juice",
    category: "beverages",
    location: "fridge",
    tracking: "velocity",
    baseUnit: "oz",
    days: 0.14,
    shelfLifeDays: 10,
    products: [wf("365 Orange Juice No Pulp 52oz", 52, 549)],
  },
  // pantry staples
  {
    name: "Spaghetti",
    category: "pantry",
    location: "pantry",
    tracking: "velocity",
    baseUnit: "lb",
    days: 10,
    products: [wf("Trattoria Spaghetti 1lb", 1, 229), wf("365 Organic Spaghetti 1lb", 1, 179, 6)],
  },
  {
    name: "Jasmine Rice",
    category: "pantry",
    location: "pantry",
    tracking: "velocity",
    baseUnit: "lb",
    days: 14,
    products: [wf("Golden Fields Jasmine Rice 2lb", 2, 649)],
  },
  {
    name: "Rolled Oats",
    category: "pantry",
    location: "pantry",
    tracking: "velocity",
    baseUnit: "oz",
    days: 0.7,
    products: [amz("Old Mill Rolled Oats 32oz", "B0SEED0003", 32, 699)],
  },
  {
    name: "Peanut Butter",
    category: "pantry",
    location: "pantry",
    tracking: "velocity",
    baseUnit: "oz",
    days: 1.3,
    products: [wf("Crunchy Peanut Butter 16oz", 16, 449)],
  },
  {
    name: "Canned Tomatoes",
    category: "pantry",
    location: "pantry",
    tracking: "static",
    baseUnit: "can",
    days: 9,
    reorderThreshold: 2,
    products: [wf("Organic Crushed Tomatoes 28oz", 1, 329)],
  },
  {
    name: "Black Beans",
    category: "pantry",
    location: "pantry",
    tracking: "static",
    baseUnit: "can",
    days: 8,
    reorderThreshold: 2,
    products: [wf("365 Organic Black Beans 15oz", 1, 139)],
  },
  {
    name: "Olive Oil",
    category: "pantry",
    location: "pantry",
    tracking: "static",
    baseUnit: "bottle",
    days: 40,
    reorderThreshold: 1,
    products: [wf("365 Extra Virgin Olive Oil 1L", 1, 1199)],
  },
  {
    name: "Sea Salt",
    category: "pantry",
    location: "pantry",
    tracking: "static",
    baseUnit: "container",
    days: 150,
    reorderThreshold: 0,
    products: [wf("Fine Sea Salt 26oz", 1, 299)],
  },
  // frozen
  {
    name: "Frozen Peas",
    category: "frozen",
    location: "freezer",
    tracking: "velocity",
    baseUnit: "oz",
    days: 0.9,
    products: [wf("365 Organic Sweet Peas 16oz", 16, 249)],
  },
  {
    name: "Frozen Blueberries",
    category: "frozen",
    location: "freezer",
    tracking: "velocity",
    baseUnit: "oz",
    days: 0.31,
    products: [wf("365 Organic Wild Blueberries 32oz", 32, 999)],
  },
  {
    name: "Ice Cream",
    category: "frozen",
    location: "freezer",
    tracking: "velocity",
    baseUnit: "pint",
    days: 5,
    products: [wf("Moo Creamery Vanilla Bean Pint", 1, 599)],
  },
  // household
  {
    name: "Toilet Paper",
    category: "household",
    location: "bathroom",
    tracking: "velocity",
    baseUnit: "roll",
    days: 2.5,
    defaultEma: true,
    auditHint: "Count rolls in the cabinet under the sink",
    products: [amz("SoftCloud Toilet Paper 24 Mega Rolls", "B0SEED0004", 24, 2899)],
  },
  {
    name: "Paper Towels",
    category: "household",
    location: "utility",
    tracking: "velocity",
    baseUnit: "roll",
    days: 5,
    products: [amz("SoftCloud Paper Towels 12 Rolls", "B0SEED0005", 12, 2499)],
  },
  {
    name: "Dish Soap",
    category: "household",
    location: "utility",
    tracking: "static",
    baseUnit: "bottle",
    days: 30,
    reorderThreshold: 1,
    products: [amz("Brightwash Dish Soap 22oz", "B0SEED0006", 1, 399)],
  },
  {
    name: "Laundry Detergent",
    category: "household",
    location: "utility",
    tracking: "static",
    baseUnit: "bottle",
    days: 45,
    reorderThreshold: 0,
    products: [
      amz("Fresh Day Laundry Detergent 92oz", "B0SEED0007", 1, 1399),
      amz("Plainleaf Free & Clear Detergent 100oz", "B0SEED0008", 1, 1549, 10),
    ],
  },
  {
    name: "Trash Bags",
    category: "household",
    location: "garage",
    tracking: "static",
    baseUnit: "box",
    days: 50,
    reorderThreshold: 0,
    products: [amz("Sturdy Kitchen Trash Bags 13gal 80ct", "B0SEED0009", 1, 1699)],
  },
  {
    name: "Hand Soap",
    category: "household",
    location: "bathroom",
    tracking: "static",
    baseUnit: "bottle",
    days: 25,
    reorderThreshold: 1,
    products: [wf("365 Lavender Hand Soap 12oz", 1, 299)],
  },
  {
    name: "Potting Soil",
    category: "garden",
    location: "garden",
    tracking: "static",
    baseUnit: "bag",
    days: 400,
    reorderThreshold: 0,
    products: [amz("Greenroot Organic Potting Mix 1cu ft", "B0SEED0010", 1, 1299)],
  },
];

/** Created from the last paper receipt; left unverified with pending reviews. */
export const NEW_ITEM: ItemSpec = {
  name: "Kombucha",
  category: "beverages",
  location: "fridge",
  tracking: "static",
  baseUnit: "bottle",
  days: 7,
  reorderThreshold: 0,
  products: [wf("Brightbrew Ginger Kombucha 16oz", 1, 399)],
};

/** Store fee lines and the like: aliased, ignored, never matched to an item. */
export const IGNORED_ALIASES = [
  { vendor: "wholefoods", kind: "receipt_text", vendorString: "BAG FEE" },
  { vendor: "wholefoods", kind: "receipt_text", vendorString: "CRV" },
  { vendor: "amazon", kind: "asin", vendorString: "B0SEEDGIFT" },
] as const;
