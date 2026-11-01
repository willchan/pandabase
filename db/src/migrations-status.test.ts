import { describe, expect, it } from "vitest";
import { createTestDb } from "./client";
import { compareMigrations, expectedMigrations } from "./migrations-status";

describe("compareMigrations", () => {
  const files = [
    { createdAt: 1, hash: "a" },
    { createdAt: 2, hash: "b" },
  ];

  it("is ok when every file is applied with the same hash", () => {
    expect(compareMigrations(files, files)).toMatchObject({ ok: true, expected: 2, applied: 2 });
  });

  it("reports pending, edited and unknown migrations", () => {
    expect(compareMigrations([{ createdAt: 1, hash: "a" }], files)).toMatchObject({
      ok: false,
      pending: [2],
    });
    expect(compareMigrations([files[0]!, { createdAt: 2, hash: "x" }], files).changed).toEqual([2]);
    expect(compareMigrations([...files, { createdAt: 3, hash: "c" }], files).unknown).toEqual([3]);
  });

  it("matches a freshly migrated database", async () => {
    const db = await createTestDb();
    const res = await db.$client.execute("select hash, created_at from __drizzle_migrations");
    const applied = res.rows.map((r) => ({
      hash: String(r.hash),
      createdAt: Number(r.created_at),
    }));
    db.$client.close();
    const status = compareMigrations(applied, expectedMigrations());
    expect(status.ok).toBe(true);
    expect(status.expected).toBeGreaterThanOrEqual(2);
  });
});
