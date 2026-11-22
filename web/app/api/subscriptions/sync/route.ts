import { ROUTES } from "@/lib/contracts";
import { resolveMemberRef } from "@/lib/repo/members";
import { handle } from "@/lib/route";
import { syncSubscriptions } from "@/lib/services/subscriptions";

export const POST = handle(ROUTES.subscriptionsSync, async ({ app, body, now, config }) => {
  const m = await resolveMemberRef(app.db, body.account);
  const res = await syncSubscriptions(
    app.db,
    {
      memberId: m.id,
      vendor: body.vendor,
      subscriptions: body.subscriptions.map((s) => ({
        asin: s.asin,
        title: s.title ?? null,
        nextDeliveryOn: s.next_delivery_on ?? null,
        schedule: s.schedule ?? null,
      })),
    },
    { now, config },
  );
  return { account_member_id: m.id, synced_at: now, ...res };
});
