// Schema smoke tests: migrations apply, enum/bool/json CHECKs, uniques, partial uniques, FKs.
import { eq, getTableName, is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { isValid as isUlid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type Db } from "./client";
import * as schema from "./schema/index";
import { seed } from "./seed";

const tables = Object.values(schema as Record<string, unknown>).filter((v): v is SQLiteTable =>
  is(v, SQLiteTable),
);

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
  await seed(db);
  // Tables the seed leaves empty get one row so every column can be probed.
  await db.insert(schema.setting).values({ key: "probe", value: { n: 1 } });
  await db
    .insert(schema.idempotencyKey)
    .values({ key: "k1", scope: "receipts", responseStatus: 201, responseBody: { ok: true } });
});
afterAll(() => db.$client.close());

/** Run raw SQL and return the constraint failure message ("" if it succeeded). */
async function failure(sql: string, args: (string | number | null)[] = []): Promise<string> {
  try {
    await db.$client.execute({ sql, args });
    return "";
  } catch (e) {
    return String((e as Error).message);
  }
}
const firstRow = (table: string) => `rowid = (SELECT min(rowid) FROM "${table}")`;

describe("migrations", () => {
  it("create every schema table", async () => {
    const res = await db.$client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%'",
    );
    const names = res.rows.map((r) => r.name).sort();
    expect(names).toEqual(tables.map((t) => getTableName(t)).sort());
    expect(names).toHaveLength(19);
  });

  it("enforce foreign keys", async () => {
    const msg = await failure(
      "INSERT INTO inventory_event (id, item_id, location, kind, quantity, occurred_at, source) VALUES ('x', 'missing', 'fridge', 'observed', 1, '2026-01-01T00:00:00.000Z', 'manual')",
    );
    expect(msg).toMatch(/FOREIGN KEY constraint failed/);
  });
});

describe("enum, boolean and json CHECKs", () => {
  const probes = tables.flatMap((t) => {
    const name = getTableName(t);
    return getTableConfig(t).columns.flatMap((c) => {
      const out: { table: string; column: string; bad: string | number }[] = [];
      if (c.enumValues?.length) out.push({ table: name, column: c.name, bad: "__bogus__" });
      if (c.columnType === "SQLiteBoolean") out.push({ table: name, column: c.name, bad: 2 });
      if (c.columnType === "SQLiteTextJson")
        out.push({ table: name, column: c.name, bad: "{not json" });
      return out;
    });
  });

  it("are discovered from the schema (every enum column is probed below)", () => {
    expect(probes.filter((p) => p.bad === "__bogus__").length).toBeGreaterThanOrEqual(35);
  });

  it.each(probes)("$table.$column rejects $bad", async ({ table, column, bad }) => {
    const msg = await failure(`UPDATE "${table}" SET "${column}" = ? WHERE ${firstRow(table)}`, [
      bad,
    ]);
    expect(msg).toMatch(/CHECK constraint failed/);
  });

  it("allow null for nullable enums", async () => {
    expect(
      await failure(`UPDATE item SET ema_outlier_direction = NULL WHERE ${firstRow("item")}`),
    ).toBe("");
  });
});

describe("row CHECKs", () => {
  it.each([
    [
      "moved without to_location",
      `UPDATE inventory_event SET kind = 'moved', to_location = NULL WHERE ${firstRow("inventory_event")}`,
    ],
    [
      "to_location on non-move",
      `UPDATE inventory_event SET kind = 'acquired', to_location = 'freezer' WHERE ${firstRow("inventory_event")}`,
    ],
    [
      "negative quantity",
      `UPDATE inventory_event SET quantity = -1 WHERE ${firstRow("inventory_event")}`,
    ],
    ["away period ends before it starts", `UPDATE away_period SET ends_on = '2000-01-01'`],
    [
      "alias confidence > 1",
      `UPDATE vendor_alias SET confidence_score = 1.5 WHERE ${firstRow("vendor_alias")}`,
    ],
    [
      "unignored alias without item",
      `UPDATE vendor_alias SET item_id = NULL, ignored = 0 WHERE ${firstRow("vendor_alias")}`,
    ],
    ["review without expiry", `UPDATE review_item SET expires_at = NULL WHERE kind = 'failed_job'`],
    [
      "override without target",
      `UPDATE grocery_cycle_override SET item_id = NULL, free_text = NULL WHERE kind = 'skip'`,
    ],
    [
      "non-positive unit quantity",
      `UPDATE product SET unit_quantity = 0 WHERE ${firstRow("product")}`,
    ],
  ])("reject %s", async (_, sql) => {
    expect(await failure(sql)).toMatch(/CHECK constraint failed/);
  });
});

describe("uniques", () => {
  it.each([
    [
      "member.email",
      "UPDATE member SET email = (SELECT email FROM member ORDER BY id LIMIT 1) WHERE id = (SELECT max(id) FROM member)",
    ],
    [
      "member.discord_user_id",
      "UPDATE member SET discord_user_id = (SELECT discord_user_id FROM member ORDER BY id LIMIT 1) WHERE id = (SELECT max(id) FROM member)",
    ],
    ["one cart account", "UPDATE member SET is_cart_account = 1"],
    ["product (vendor, asin)", "UPDATE product SET asin = 'B0SEED0001' WHERE asin = 'B0SEED0002'"],
    [
      "vendor_alias (vendor, kind, vendor_string)",
      "UPDATE vendor_alias SET vendor_string = 'BAG FEE' WHERE vendor_string = 'CRV'",
    ],
    [
      "receipt.dedupe_key",
      "UPDATE receipt SET dedupe_key = (SELECT dedupe_key FROM receipt ORDER BY id LIMIT 1) WHERE id = (SELECT max(id) FROM receipt)",
    ],
    [
      "grocery_cycle.week_label",
      "UPDATE grocery_cycle SET week_label = (SELECT week_label FROM grocery_cycle ORDER BY id LIMIT 1) WHERE id = (SELECT max(id) FROM grocery_cycle)",
    ],
    [
      "one active cycle",
      "UPDATE grocery_cycle SET status = 'ready' WHERE id = (SELECT min(id) FROM grocery_cycle)",
    ],
    ["setting.key", "INSERT INTO setting (key, value) VALUES ('probe', '1')"],
    [
      "inventory_state (item_id, location)",
      "INSERT INTO inventory_state (item_id, location) SELECT item_id, location FROM inventory_state LIMIT 1",
    ],
    [
      "idempotency_key (key, scope)",
      "INSERT INTO idempotency_key (key, scope, response_status) VALUES ('k1', 'receipts', 200)",
    ],
  ])("enforce %s", async (_, sql) => {
    expect(await failure(sql)).toMatch(/UNIQUE constraint failed/);
  });

  it("allow many products without an asin per vendor", async () => {
    const res = await db.$client.execute(
      "SELECT count(*) AS n FROM product WHERE vendor = 'wholefoods' AND asin IS NULL",
    );
    expect(Number(res.rows[0]!.n)).toBeGreaterThan(1);
  });

  it("allow many terminal cycles", async () => {
    expect(
      await failure("UPDATE grocery_cycle SET status = 'skipped' WHERE status = 'closed'"),
    ).toBe("");
  });
});

describe("column defaults", () => {
  it("assign ULIDs and UTC ISO timestamps, and bump updated_at", async () => {
    const [row] = await db
      .insert(schema.awayPeriod)
      .values({ startsOn: "2027-01-01", endsOn: "2027-01-02" })
      .returning();
    expect(isUlid(row!.id)).toBe(true);
    expect(row!.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    await new Promise((r) => setTimeout(r, 5));
    const [updated] = await db
      .update(schema.awayPeriod)
      .set({ note: "edited" })
      .where(eq(schema.awayPeriod.id, row!.id))
      .returning();
    expect(updated!.updatedAt > row!.updatedAt).toBe(true);
  });

  it("fill timestamps for rows inserted with raw SQL", async () => {
    await db.$client.execute(
      "INSERT INTO system_telemetry (id, source, metric_type, payload) VALUES ('raw', 's', 'm', '{}')",
    );
    const res = await db.$client.execute(
      "SELECT created_at FROM system_telemetry WHERE id = 'raw'",
    );
    expect(String(res.rows[0]!.created_at)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });
});
