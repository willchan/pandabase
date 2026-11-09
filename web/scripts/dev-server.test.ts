// dev-server: the prod-copy server only ever runs on a local file, signs in as one member of that
// copy, and blanks every secret that could reach a real service. Synthetic members only.
import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BLANKED, pickMember, prepareDevServer, prodCopyRefusal } from "./dev-server";

let dir: string;
let url: string;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "dev-server-"));
  url = `file:${path.join(dir, "copy.db")}`;
  const db = createClient({ url });
  await db.batch([
    "CREATE TABLE member (id TEXT PRIMARY KEY, email TEXT, created_at TEXT)",
    "INSERT INTO member VALUES ('b', 'second@example.com', '2026-02-01')",
    "INSERT INTO member VALUES ('a', 'First@example.com', '2026-01-01')",
  ]);
  db.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("prodCopyRefusal", () => {
  it.each([
    [undefined, /not set/],
    ["libsql://pandabase-org.turso.io", /file: URL/],
    ["https://pandabase-org.turso.io", /file: URL/],
    ["file:/nowhere/prod-copy.db", /make prod-copy/],
  ])("refuses %s", (u, why) => expect(prodCopyRefusal(u)).toMatch(why));

  it("accepts an existing local copy", () => expect(prodCopyRefusal(url)).toBeNull());
});

describe("pickMember", () => {
  it("defaults to the first member created", async () => {
    expect(await pickMember(url)).toBe("first@example.com");
  });
  it("takes PROD_COPY_MEMBER when it is a member", async () => {
    expect(await pickMember(url, "SECOND@example.com")).toBe("second@example.com");
  });
  it("refuses an email that isn't a member, without echoing it", async () => {
    await expect(pickMember(url, "x@example.com")).rejects.toThrow(/^PROD_COPY_MEMBER is not/);
  });
});

describe("prepareDevServer('prod-copy')", () => {
  const prod: NodeJS.ProcessEnv = {
    NODE_ENV: "development",
    TURSO_DATABASE_URL: "",
    TURSO_AUTH_TOKEN: "real-token",
    R2_SECRET_ACCESS_KEY: "real-r2",
    AGENT_API_TOKEN: "real-agent",
    ALLOWED_EMAILS: "someone@else.com",
  };

  it("refuses a remote TURSO_DATABASE_URL", async () => {
    await expect(
      prepareDevServer("prod-copy", { ...prod, TURSO_DATABASE_URL: "libsql://prod.turso.io" }),
    ).rejects.toThrow(/refused: .*file: URL/);
  });

  it("runs on the copy as one member with every secret blanked", async () => {
    const { env, email } = await prepareDevServer("prod-copy", {
      ...prod,
      TURSO_DATABASE_URL: url,
    });
    expect(email).toBe("first@example.com");
    expect(env.ALLOWED_EMAILS).toBe("first@example.com");
    expect(env.TURSO_DATABASE_URL).toBe(url);
    expect(env.DEV_AUTH_BYPASS).toBe("1");
    for (const k of BLANKED) expect(env[k], k).toBe("");
  });
});
