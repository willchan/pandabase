import { describe, expect, it } from "vitest";
import { createTestDb } from "./client";
import { assertResettable, redact, remoteWriteRefusal, wipeRows } from "./preview-db";
import { seed } from "./seed";

const PREVIEW = "libsql://pandabase-preview-willchan.aws-us-west-2.turso.io";
const PROD = "libsql://pandabase-willchan.aws-us-west-2.turso.io";
const allow = { PANDABASE_ALLOW_REMOTE_SEED: "preview" };

describe("remoteWriteRefusal — only the preview DB may be reset or seeded remotely", () => {
  it("allows local files without any opt-in", () => {
    expect(remoteWriteRefusal("file:/tmp/x.db", {})).toBeNull();
    expect(remoteWriteRefusal(":memory:", {})).toBeNull();
  });

  it("allows the preview DB only with both signals", () => {
    expect(remoteWriteRefusal(PREVIEW, allow)).toBeNull();
    expect(remoteWriteRefusal(PREVIEW.replace("libsql:", "https:"), allow)).toBeNull();
    expect(remoteWriteRefusal(PREVIEW, {})).toMatch(/PANDABASE_ALLOW_REMOTE_SEED=preview/);
    expect(remoteWriteRefusal(PREVIEW, { PANDABASE_ALLOW_REMOTE_SEED: "1" })).toMatch(/not set/);
  });

  it("refuses production even with the opt-in", () => {
    expect(remoteWriteRefusal(PROD, allow)).toMatch(/isn't a preview database/);
    expect(() => assertResettable(PROD, allow)).toThrow(/Refusing to reset or seed/);
  });

  it("looks for `preview` as a word of the database name, not anywhere in the URL", () => {
    for (const url of [
      "libsql://pandabase-willchan.preview.turso.io", // a later label
      "libsql://pandabase-willchan.turso.io/preview", // the path
      "libsql://pandabase-willchan.turso.io?preview=1", // the query
      "libsql://pandabasepreview-willchan.turso.io", // not a whole word
      "libsql://pandabase-previews-willchan.turso.io",
      "libsql://user:preview@pandabase-willchan.turso.io", // credentials
    ])
      expect(remoteWriteRefusal(url, allow), url).not.toBeNull();
    expect(remoteWriteRefusal("libsql://preview-db.turso.io", allow)).toBeNull();
    expect(remoteWriteRefusal("libsql://PANDABASE-PREVIEW-x.turso.io", allow)).toBeNull();
  });

  it("refuses odd schemes and unparseable URLs", () => {
    expect(remoteWriteRefusal("ftp://pandabase-preview.turso.io", allow)).toMatch(/scheme/);
    expect(remoteWriteRefusal("pandabase-preview", allow)).toMatch(/doesn't parse/);
  });

  it("never prints credentials", () => {
    expect(redact(`${PREVIEW}?authToken=secret`)).toBe(PREVIEW);
    expect(redact("libsql://u:p@pandabase-x.turso.io")).toBe("libsql://pandabase-x.turso.io");
    let message = "";
    try {
      assertResettable(`${PROD}?authToken=s3cret`, allow);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(PROD);
    expect(message).not.toContain("s3cret");
  });
});

describe("wipeRows", () => {
  it("empties every table, keeps the schema and migration journal, and the seed loads again", async () => {
    const db = await createTestDb();
    await seed(db);
    const before = await db.$client.execute("select count(*) n from __drizzle_migrations");
    const tables = await wipeRows(db);
    expect(tables).toContain("member");
    expect(tables).not.toContain("__drizzle_migrations");
    for (const t of tables) {
      const r = await db.$client.execute(`select count(*) n from "${t}"`);
      expect(Number(r.rows[0]!.n), t).toBe(0);
    }
    const after = await db.$client.execute("select count(*) n from __drizzle_migrations");
    expect(after.rows[0]!.n).toEqual(before.rows[0]!.n);
    await seed(db, { now: new Date().toISOString() });
    const members = await db.$client.execute("select count(*) n from member");
    expect(Number(members.rows[0]!.n)).toBe(2);
    db.$client.close();
  });
});
