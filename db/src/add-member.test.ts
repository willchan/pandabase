import { describe, expect, it } from "vitest";
import { upsertMember } from "./add-member";
import { createTestDb } from "./client";
import { member } from "./schema/index";

describe("upsertMember (first-run bootstrap)", () => {
  it("creates, then updates the same row by email", async () => {
    const db = await createTestDb();
    const a = await upsertMember(db, {
      email: "Alex@Example.com",
      displayName: "Alex",
      amazonSweep: "daily",
      isCartAccount: true,
    });
    expect(a.created).toBe(true);
    const b = await upsertMember(db, {
      email: "alex@example.com",
      displayName: "Alex B",
      discordUserId: "100000000000000101",
    });
    expect(b).toEqual({ id: a.id, created: false });
    const rows = await db.select().from(member);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: "alex@example.com",
      displayName: "Alex B",
      discordUserId: "100000000000000101",
      amazonSweep: "daily", // untouched when not passed
      isCartAccount: true,
    });
    db.$client.close();
  });

  it("keeps exactly one cart account", async () => {
    const db = await createTestDb();
    await upsertMember(db, { email: "a@example.com", displayName: "A", isCartAccount: true });
    await upsertMember(db, { email: "b@example.com", displayName: "B", isCartAccount: true });
    const carts = (await db.select().from(member)).filter((m) => m.isCartAccount);
    expect(carts.map((m) => m.email)).toEqual(["b@example.com"]);
    db.$client.close();
  });

  it("rejects bad input", async () => {
    const db = await createTestDb();
    await expect(upsertMember(db, { email: "nope", displayName: "X" })).rejects.toThrow(/email/);
    await expect(
      upsertMember(db, { email: "x@example.com", displayName: "X", discordUserId: "abc" }),
    ).rejects.toThrow(/digits/);
    db.$client.close();
  });
});
