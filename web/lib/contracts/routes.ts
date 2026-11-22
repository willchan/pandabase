// Every v1 route (DESIGN §3.2): method, path, scopes, contracts. Route handlers are built from
// these definitions (`web/lib/route.ts`) and `openapi.ts` documents them, so the two can't drift.
import type { z } from "zod";
import { EmptyRequest } from "./common";
import * as costco from "./costco";
import * as c from "./cycle";
import * as inv from "./inventory";
import * as jobs from "./jobs";
import * as platform from "./platform";
import * as receipts from "./receipts";
import * as subs from "./subscriptions";

/** `session` = a signed-in household member (Auth.js); sessions pass every non-cron scope. */
export type Scope = "agent" | "worker" | "session" | "cron";

export interface RouteDef<
  B extends z.ZodType | undefined = z.ZodType | undefined,
  Qy extends z.ZodType | undefined = z.ZodType | undefined,
  R extends z.ZodType = z.ZodType,
> {
  operationId: string;
  method: "GET" | "POST";
  /** OpenAPI path (`{id}` params). */
  path: string;
  summary: string;
  scopes: readonly Scope[];
  /** Honors `Idempotency-Key` (mutating machine routes). */
  idempotent: boolean;
  body: B;
  query: Qy;
  response: R;
}

const route = <
  B extends z.ZodType | undefined = undefined,
  Qy extends z.ZodType | undefined = undefined,
  R extends z.ZodType = z.ZodType,
>(
  d: Omit<RouteDef<B, Qy, R>, "idempotent" | "body" | "query"> & {
    idempotent?: boolean;
    body?: B;
    query?: Qy;
  },
): RouteDef<B, Qy, R> => ({
  ...d,
  idempotent: d.idempotent ?? d.method === "POST",
  body: d.body as B,
  query: d.query as Qy,
});

const agent = ["agent"] as const;

export const ROUTES = {
  cycleCurrent: route({
    operationId: "getCurrentCycle",
    method: "GET",
    path: "/api/grocery/cycle/current",
    summary: "Current non-closed cycle (or null)",
    scopes: agent,
    response: c.CycleCurrentResponse,
  }),
  cycleOpen: route({
    operationId: "openCycle",
    method: "POST",
    path: "/api/grocery/cycle/open",
    summary: "Open a new cycle (idempotent per week; returns the active cycle if there is one)",
    scopes: agent,
    body: c.CycleOpenRequest,
    response: c.CycleOpenResponse,
  }),
  cycleOverrides: route({
    operationId: "addCycleOverride",
    method: "POST",
    path: "/api/grocery/cycle/{id}/overrides",
    summary: "add / skip / qty / product override; free-text adds allowed",
    scopes: agent,
    body: c.CycleOverrideRequest,
    response: c.CycleOverrideResponse,
  }),
  cycleStatus: route({
    operationId: "setCycleStatus",
    method: "POST",
    path: "/api/grocery/cycle/{id}/status",
    summary: "Advance the cycle: nudged / building / ready / skipped / other_store / closed",
    scopes: agent,
    body: c.CycleStatusRequest,
    response: c.CycleStatusResponse,
  }),
  checkin: route({
    operationId: "getCheckin",
    method: "GET",
    path: "/api/grocery/checkin",
    summary: "Friday nudge lists: likely_needed, please_check, freezer, pending_review_count",
    scopes: agent,
    response: c.CheckinResponse,
  }),
  predictions: route({
    operationId: "getPredictions",
    method: "GET",
    path: "/api/predictions",
    summary: "Cart plan: lines with item, qty, candidate products, needs_price_check",
    scopes: agent,
    query: c.PredictionsQuery,
    response: c.PredictionsResponse,
  }),
  priceQuotes: route({
    operationId: "postPriceQuotes",
    method: "POST",
    path: "/api/grocery/price-quotes",
    summary: "Agent-observed prices for candidate products",
    scopes: agent,
    body: c.PriceQuotesRequest,
    response: c.PriceQuotesResponse,
  }),
  cycleCart: route({
    operationId: "getCycleCart",
    method: "GET",
    path: "/api/grocery/cycle/{id}/cart",
    summary: "Final cart lines (product chosen, reason text) after quotes",
    scopes: agent,
    response: c.CartResponse,
  }),
  cycleCartResult: route({
    operationId: "postCartResult",
    method: "POST",
    path: "/api/grocery/cycle/{id}/cart-result",
    summary: "Per-line injection outcome (tier1/tier2/failed); a building cycle becomes ready",
    scopes: agent,
    body: c.CartResultRequest,
    response: c.CartResultResponse,
  }),
  costcoTripCurrent: route({
    operationId: "getCostcoTrip",
    method: "GET",
    path: "/api/costco/trip",
    summary: "The planned Costco trip (or null) and its live list",
    scopes: agent,
    response: costco.CostcoTripResponse,
  }),
  costcoTripPlan: route({
    operationId: "planCostcoTrip",
    method: "POST",
    path: "/api/costco/trip",
    summary:
      '"Going to Costco Saturday": plan the trip, or move the planned one to the new date; returns its list',
    scopes: agent,
    body: costco.CostcoTripPlanRequest,
    response: costco.CostcoTripPlanResponse,
  }),
  costcoTripStatus: route({
    operationId: "setCostcoTripStatus",
    method: "POST",
    path: "/api/costco/trip/{id}/status",
    summary: '"Back from Costco" (done) or "not going" (cancelled)',
    scopes: agent,
    body: costco.CostcoTripStatusRequest,
    response: costco.CostcoTripStatusResponse,
  }),
  itemStorePin: route({
    operationId: "setItemStorePin",
    method: "POST",
    path: "/api/items/{id}/store-pin",
    summary: '"Get X at Costco / Whole Foods": pin the item\'s store (null clears it)',
    scopes: agent,
    body: costco.StorePinRequest,
    response: costco.StorePinResponse,
  }),
  itemsLookup: route({
    operationId: "lookupItems",
    method: "GET",
    path: "/api/items/lookup",
    summary: '"Do we have X?" — matches + estimate + confidence text',
    scopes: agent,
    query: inv.LookupQuery,
    response: inv.LookupResponse,
  }),
  inventoryEvents: route({
    operationId: "postInventoryEvents",
    method: "POST",
    path: "/api/inventory/events",
    summary: "Counts, critical flags, consumed, discarded, moved, text purchases",
    scopes: agent,
    body: inv.InventoryEventsRequest,
    response: inv.InventoryEventsResponse,
  }),
  freezerAging: route({
    operationId: "getFreezerAging",
    method: "GET",
    path: "/api/freezer/aging",
    summary: "Oldest freezer stock",
    scopes: agent,
    query: inv.FreezerAgingQuery,
    response: inv.FreezerAgingResponse,
  }),
  awayPeriods: route({
    operationId: "createAwayPeriod",
    method: "POST",
    path: "/api/away-periods",
    summary: "Create an away period",
    scopes: agent,
    body: inv.AwayPeriodRequest,
    response: inv.AwayPeriodResponse,
  }),
  productReject: route({
    operationId: "rejectProduct",
    method: "POST",
    path: "/api/products/{id}/reject",
    summary: '"Never buy X": product stance → rejected',
    scopes: agent,
    body: inv.ProductRejectRequest,
    response: inv.ProductRejectResponse,
  }),
  receiptsCursor: route({
    operationId: "getReceiptCursor",
    method: "GET",
    path: "/api/receipts/cursor",
    summary: "Last ingested external_order_id / date for a member's account",
    scopes: agent,
    query: receipts.ReceiptCursorQuery,
    response: receipts.ReceiptCursorResponse,
  }),
  receiptsIngest: route({
    operationId: "ingestReceipt",
    method: "POST",
    path: "/api/receipts/ingest",
    summary: "Digital/manual receipt → resolve, apply, EMA (deduped)",
    scopes: agent,
    body: receipts.ReceiptIngestRequest,
    response: receipts.ReceiptIngestResponse,
  }),
  subscriptionsSync: route({
    operationId: "syncSubscriptions",
    method: "POST",
    path: "/api/subscriptions/sync",
    summary: "Replace a member's Subscribe & Save list (the sweep read it completely)",
    scopes: agent,
    body: subs.SubscriptionSyncRequest,
    response: subs.SubscriptionSyncResponse,
  }),
  mediaUploadUrl: route({
    operationId: "createUploadUrl",
    method: "POST",
    path: "/api/media/upload-url",
    summary: "R2 presigned PUT for a new media key",
    scopes: agent,
    body: jobs.UploadUrlRequest,
    response: jobs.UploadUrlResponse,
  }),
  jobsCreate: route({
    operationId: "createJob",
    method: "POST",
    path: "/api/jobs",
    summary: "Create an audit job",
    scopes: agent,
    body: jobs.JobCreateRequest,
    response: jobs.JobResponse,
  }),
  jobsNotifications: route({
    operationId: "getJobNotifications",
    method: "GET",
    path: "/api/jobs/notifications",
    summary: "Completed/failed jobs not yet replied to in Discord",
    scopes: agent,
    response: jobs.JobNotificationsResponse,
  }),
  jobsNotified: route({
    operationId: "markJobNotified",
    method: "POST",
    path: "/api/jobs/{id}/notified",
    summary: "Mark the Discord reply sent",
    scopes: agent,
    body: EmptyRequest,
    response: jobs.JobResponse,
  }),
  mergeSuggestionsRun: route({
    operationId: "runMergeSuggestions",
    method: "POST",
    path: "/api/catalog/merge-suggestions/run",
    summary: "Queue merge_suggest jobs for unverified items (end of a receipt backfill)",
    scopes: agent,
    body: jobs.MergeSuggestRunRequest,
    response: jobs.MergeSuggestRunResponse,
  }),
  jobsClaim: route({
    operationId: "claimJob",
    method: "POST",
    path: "/api/jobs/claim",
    summary: "Lease the next queued job (+ presigned URLs); null when the queue is empty",
    scopes: ["worker"],
    // A claim is a lease, not a create: replaying a stored claim would hand out a stale lease.
    idempotent: false,
    body: jobs.JobClaimRequest,
    response: jobs.JobClaimResponse,
  }),
  jobsComplete: route({
    operationId: "completeJob",
    method: "POST",
    path: "/api/jobs/complete",
    summary: "Result or failure for a claimed job",
    scopes: ["worker"],
    body: jobs.JobCompleteRequest,
    response: jobs.JobCompleteResponse,
  }),
  telemetry: route({
    operationId: "postTelemetry",
    method: "POST",
    path: "/api/telemetry",
    summary: "Telemetry events (batched)",
    scopes: ["agent", "worker"],
    body: platform.TelemetryRequest,
    response: platform.TelemetryResponse,
  }),
  workerHealth: route({
    operationId: "getWorkerHealth",
    method: "GET",
    path: "/api/health/worker",
    summary: "Latest worker heartbeat (time, version, build sha, models, ollama_ok) or null",
    scopes: agent,
    response: platform.WorkerHealthResponse,
  }),
  diagnosticsWeekly: route({
    operationId: "getWeeklyDiagnostics",
    method: "GET",
    path: "/api/diagnostics/weekly",
    summary: "Rendered weekly Markdown + JSONL extracts",
    scopes: agent,
    query: platform.DiagnosticsQuery,
    response: platform.DiagnosticsResponse,
  }),
  cronMaintenance: route({
    operationId: "runMaintenance",
    method: "GET",
    path: "/api/cron/maintenance",
    summary: "Expire reviews, shelf-life discards, release stale leases, purge, open overdue cycle",
    scopes: ["cron"],
    response: platform.MaintenanceResponse,
  }),
} as const;

export type RouteName = keyof typeof ROUTES;
