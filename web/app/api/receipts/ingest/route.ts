import { ROUTES } from "@/lib/contracts";
import { badRequest } from "@/lib/http";
import { resolveMemberRef } from "@/lib/repo/members";
import { handle } from "@/lib/route";
import { ingestReceipt } from "@/lib/services/receipts";
import { isoUtc } from "@/lib/services/types";

export const POST = handle(
  ROUTES.receiptsIngest,
  async ({ app, body, now, config, actor, idempotencyKey }) => {
    if (body.source === "manual" && !idempotencyKey) {
      throw badRequest("manual receipts need an Idempotency-Key header");
    }
    const account = body.account ? (await resolveMemberRef(app.db, body.account)).id : null;
    return ingestReceipt(
      app.db,
      {
        source: body.source,
        vendor: body.vendor,
        accountMemberId: account,
        externalOrderId: body.external_order_id ?? null,
        fulfillment: body.fulfillment ?? "unknown",
        orderedAt: body.ordered_at ? isoUtc(body.ordered_at) : null,
        acquiredAt: isoUtc(body.acquired_at),
        subtotalCents: body.subtotal_cents ?? null,
        totalCents: body.total_cents ?? null,
        idempotencyKey,
        lines: body.lines.map((l) => ({
          rawText: l.raw_text,
          asin: l.asin ?? null,
          title: l.title ?? null,
          qty: l.qty,
          unitPriceCents: l.unit_price_cents ?? null,
          lineTotalCents: l.line_total_cents ?? null,
          itemId: l.item_id ?? null,
          productId: l.product_id ?? null,
        })),
      },
      { now, config, actor: await actor(body.actor_discord_id, { required: true }) },
    );
  },
);
