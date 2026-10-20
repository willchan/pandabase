import { receipt } from "@pandabase/db";
import { and, desc, eq } from "drizzle-orm";
import { ROUTES } from "@/lib/contracts";
import { resolveMemberRef } from "@/lib/repo/members";
import { handle } from "@/lib/route";

export const GET = handle(ROUTES.receiptsCursor, async ({ app, query }) => {
  const m = await resolveMemberRef(app.db, query.account);
  const [last] = await app.db
    .select()
    .from(receipt)
    .where(and(eq(receipt.accountMemberId, m.id), eq(receipt.source, "digital")))
    .orderBy(desc(receipt.acquiredAt), desc(receipt.id))
    .limit(1);
  return {
    account_member_id: m.id,
    external_order_id: last?.externalOrderId ?? null,
    acquired_at: last?.acquiredAt ?? null,
    ordered_at: last?.orderedAt ?? null,
  };
});
