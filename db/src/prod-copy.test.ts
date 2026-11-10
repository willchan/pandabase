// `prod-copy`: the copy is faithful and the source only ever sees SELECTs. The "prod" side here is
// an in-memory database with the synthetic seed.
import { createClient } from "@libsql/client";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb } from "./client";
import {
  assertSelectOnly,
  copyDatabase,
  formatCounts,
  parseEnvFile,
  prodSourceFromEnv,
  readOnly,
  writeProdCopy,
} from "./prod-copy";
import { seed } from "./seed";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "prod-copy-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("assertSelectOnly", () => {
  it.each(["SELECT 1", "  select * from member;", "SELECT name FROM sqlite_master WHERE x = 1"])(
    "allows %s",
    (sql) => expect(() => assertSelectOnly(sql)).not.toThrow(),
  );
  it.each([
    "DELETE FROM member",
    "INSERT INTO member VALUES (1)",
    "PRAGMA writable_schema = 1",
    "WITH x AS (SELECT 1) DELETE FROM member",
    "SELECT 1; DROP TABLE member",
    "UPDATE item SET name = 'x'",
  ])("refuses %s", (sql) => expect(() => assertSelectOnly(sql)).toThrow(/only reads/));

  it("refuses before anything reaches the client", async () => {
    const sent: string[] = [];
    const src = readOnly({
      execute: (async (sql: string) => {
        sent.push(sql);
        return { rows: [] };
      }) as never,
    });
    await expect(src.select("DROP TABLE member")).rejects.toThrow(/only reads/);
    expect(sent).toEqual([]);
  });
});

describe("copyDatabase", () => {
  it("copies schema, rows, indexes and the migration journal", async () => {
    const prod = await createTestDb();
    await seed(prod, { now: "2026-11-01T12:00:00.000Z" });
    const sent: string[] = [];
    const src = readOnly({
      execute: ((sql: string) => {
        sent.push(sql);
        return prod.$client.execute(sql);
      }) as never,
    });
    const dest = createClient({ url: ":memory:" });

    const counts = await copyDatabase(src, dest);

    expect(sent.every((s) => /^SELECT\b/.test(s))).toBe(true);
    expect(counts.member).toBeGreaterThan(0);
    expect(counts.__drizzle_migrations).toBeGreaterThan(0);
    for (const [table, n] of Object.entries(counts)) {
      const r = await dest.execute(`SELECT count(*) AS n FROM "${table}"`);
      expect(Number(r.rows[0]!.n), table).toBe(n);
    }
    const a = await prod.$client.execute("SELECT * FROM member ORDER BY id");
    const b = await dest.execute("SELECT * FROM member ORDER BY id");
    expect(b.rows).toEqual(a.rows);
    const idx = (c: { execute: typeof dest.execute }) =>
      c
        .execute("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
        .then((r) => r.rows.map((x) => x.name).sort());
    expect(await idx(dest)).toEqual(await idx(prod.$client));
    prod.$client.close();
    dest.close();
  });

  it("writes the file atomically and leaves no temp file", async () => {
    const prod = await createTestDb();
    await seed(prod, { now: "2026-11-01T12:00:00.000Z" });
    const target = path.join(tmp(), "nested", "prod-copy.db");
    const counts = await writeProdCopy(readOnly(prod.$client), target);
    const copy = createClient({ url: `file:${target}` });
    const r = await copy.execute("SELECT count(*) AS n FROM item");
    expect(Number(r.rows[0]!.n)).toBe(counts.item);
    copy.close();
    expect(() => readFileSync(`${target}.tmp`)).toThrow();
    prod.$client.close();
  });
});

describe("prodSourceFromEnv", () => {
  it("prefers the env, then the env file", () => {
    const file = path.join(tmp(), "prod-ro.env");
    writeFileSync(
      file,
      "# read-only\nexport PROD_RO_TURSO_URL='libsql://db-org.turso.io'\nPROD_RO_TURSO_TOKEN=\"t0k\"\n",
    );
    expect(prodSourceFromEnv({ PROD_RO_ENV_FILE: file })).toEqual({
      url: "libsql://db-org.turso.io",
      authToken: "t0k",
    });
    expect(
      prodSourceFromEnv({ PROD_RO_ENV_FILE: file, PROD_RO_TURSO_TOKEN: "env" }).authToken,
    ).toBe("env");
  });

  it("says what is missing without echoing values", () => {
    const file = path.join(tmp(), "missing.env");
    expect(() =>
      prodSourceFromEnv({ PROD_RO_ENV_FILE: file, PROD_RO_TURSO_URL: "libsql://x" }),
    ).toThrow(/--read-only/);
  });

  it("in a cloud session, leaves the token to the proxy and talks HTTPS", () => {
    // The network secret is added by the agent proxy; the docs promise that for HTTP(S) only.
    expect(
      prodSourceFromEnv({
        PROD_RO_TOKEN_FROM_PROXY: "1",
        PROD_RO_TURSO_URL: "libsql://db-org.aws-us-west-2.turso.io",
        PROD_RO_ENV_FILE: path.join(tmp(), "absent.env"),
      }),
    ).toEqual({ url: "https://db-org.aws-us-west-2.turso.io" });
    expect(() => prodSourceFromEnv({ PROD_RO_TOKEN_FROM_PROXY: "1" })).toThrow(/PROD_RO_TURSO_URL/);
    expect(() =>
      prodSourceFromEnv({
        PROD_RO_TOKEN_FROM_PROXY: "1",
        PROD_RO_TURSO_URL: "libsql://x.turso.io",
        PROD_RO_TURSO_TOKEN: "t",
      }),
    ).toThrow(/don't also set/);
    expect(() =>
      prodSourceFromEnv({ PROD_RO_TOKEN_FROM_PROXY: "1", PROD_RO_TURSO_URL: "file:db/dev.db" }),
    ).toThrow(/remote/);
  });

  it("refuses a local file as the source", () => {
    expect(() =>
      prodSourceFromEnv({ PROD_RO_TURSO_URL: "file:db/dev.db", PROD_RO_TURSO_TOKEN: "t" }),
    ).toThrow(/remote/);
  });
});

it("parseEnvFile skips comments and blank lines", () => {
  expect(parseEnvFile("\n# A=1\nB = 2\n  C='x y'\n")).toEqual({ B: "2", C: "x y" });
});

it("formatCounts lists tables and a total", () => {
  expect(formatCounts({ b: 2, a: 1 })).toBe("  a     1\n  b     2\n  total 3");
});
