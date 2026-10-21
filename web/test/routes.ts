// Every route handler keyed by its contract route name (for table-driven tests).
import type { RouteName } from "@/lib/contracts";
import * as awayPeriods from "@/app/api/away-periods/route";
import * as mergeSuggestionsRun from "@/app/api/catalog/merge-suggestions/run/route";
import * as cronMaintenance from "@/app/api/cron/maintenance/route";
import * as diagnosticsWeekly from "@/app/api/diagnostics/weekly/route";
import * as freezerAging from "@/app/api/freezer/aging/route";
import * as checkin from "@/app/api/grocery/checkin/route";
import * as cycleCart from "@/app/api/grocery/cycle/[id]/cart/route";
import * as cycleCartResult from "@/app/api/grocery/cycle/[id]/cart-result/route";
import * as cycleOverrides from "@/app/api/grocery/cycle/[id]/overrides/route";
import * as cycleStatus from "@/app/api/grocery/cycle/[id]/status/route";
import * as cycleCurrent from "@/app/api/grocery/cycle/current/route";
import * as cycleOpen from "@/app/api/grocery/cycle/open/route";
import * as priceQuotes from "@/app/api/grocery/price-quotes/route";
import * as inventoryEvents from "@/app/api/inventory/events/route";
import * as itemsLookup from "@/app/api/items/lookup/route";
import * as jobsNotified from "@/app/api/jobs/[id]/notified/route";
import * as jobsClaim from "@/app/api/jobs/claim/route";
import * as jobsComplete from "@/app/api/jobs/complete/route";
import * as jobsNotifications from "@/app/api/jobs/notifications/route";
import * as jobsCreate from "@/app/api/jobs/route";
import * as mediaUploadUrl from "@/app/api/media/upload-url/route";
import * as predictions from "@/app/api/predictions/route";
import * as productReject from "@/app/api/products/[id]/reject/route";
import * as receiptsCursor from "@/app/api/receipts/cursor/route";
import * as receiptsIngest from "@/app/api/receipts/ingest/route";
import * as telemetry from "@/app/api/telemetry/route";

export const HANDLERS: Record<RouteName, Record<string, unknown>> = {
  awayPeriods,
  mergeSuggestionsRun,
  cronMaintenance,
  diagnosticsWeekly,
  freezerAging,
  checkin,
  cycleCart,
  cycleCartResult,
  cycleOverrides,
  cycleStatus,
  cycleCurrent,
  cycleOpen,
  priceQuotes,
  inventoryEvents,
  itemsLookup,
  jobsNotified,
  jobsClaim,
  jobsComplete,
  jobsNotifications,
  jobsCreate,
  mediaUploadUrl,
  predictions,
  productReject,
  receiptsCursor,
  receiptsIngest,
  telemetry,
};
