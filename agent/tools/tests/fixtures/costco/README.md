# Synthetic Costco pages

Synthetic HTML for the Costco receipt importer (PLAN M10.3, DESIGN §4.8). **No real order data**
(CLAUDE.md privacy rule): member, card, order and item numbers, barcodes, names, addresses, prices
and the account id in URLs are invented. The structure (element nesting, `id`, `automation-id`,
`aria-*`, `role`, `data-private`, link shapes, visible wording) was copied from pages the owner
saved from costco.com in November 2026. CSS class names are random (`r7-…`): live classes are
hashed MUI names (`css-1k9ek97`) that change between builds, so the parsers must not use them.
`tests/test_costco_fixtures.py` keeps the fixtures internally consistent.

| File | Page |
|---|---|
| `orders_warehouse.html` | Orders & Purchases → **Warehouse** tab: 3 in-store receipt cards (`viewRecieptBtn_<barcode>`, sic), the period picker, the hidden generic `#costcoModal` every page carries, header/footer links (Grocery, Same-Day, Kirkland Signature) that are not purchases |
| `orders_warehouse_receipt.html` | the same page after "View Receipt" on the first card: the **In-Warehouse Receipt** dialog (`aria-labelledby="alert-dialog-title"`) with the receipt table (`aria-label="spanning table"`) |
| `orders_online.html` | Orders & Purchases → **Online** tab: 2 delivered costco.com 2-Day Delivery orders, one non-grocery |
| `order_details_delivered.html` | `…/orderdetails/<order number>`: a delivered online order with 2 items (one quantity 2) |

## What the live pages showed (2026-11)

- **One URL, two tabs.** `https://www.costco.com/myaccount/#/app/<account id>/ordersandpurchases`
  opens on Online; Warehouse is a click on `automation-id="myWarehouseOrdersTab"`. Both tabs have
  the same period picker (`select#Showing`: "Last 3 Months", then quarters back ~2 years), which a
  backfill walks.
- **Warehouse cards:** `div#viewRecieptBtn_<23-digit barcode>` holding `automation-id="In-Warehouse"`,
  a "MM/DD/YYYY - h:mmam" date, the warehouse name, `automation-id="totalPrice"`, and the
  `automation-id="ViewInWareHouseReciept"` button. "Your receipts will appear within 24 hours of
  the transaction."
- **Barcode = receipt key:** `2` `1` + warehouse (4) + register (3) + transaction (4) + `YYMMDD` +
  `HHMM`, e.g. `21 0999 201 0042 261107 1815` (the receipt footer repeats the same numbers).
- **Receipt table rows** (`tbody tr`): item lines are 4 cells — a flag (`E` on most lines, empty on
  others; meaning unknown, ignore it), the **item number**, the abbreviated description, and
  `"<amount> <tax flag Y|N>"`. A multi-buy is a separate 1-cell row `"N @ unit"` **before** its item,
  whose amount is the line total. Then `SUBTOTAL`, `TAX`, `Total`, card/approval rows, tax
  breakdown, and `TOTAL NUMBER OF ITEMS SOLD = N` (counts units, so a 2 @ line counts 2).
  Close with `automation-id="closePopup"`.
- **Instant savings** (first live sweep, 2026-11-16): a row under the item reading
  `<coupon number> / <item number> <amount>-` (the tests build it into the receipt; no fixture
  file carries one).
- **Online cards:** `a#orderNumber_<n>` (`automation-id="OnlineOrdersViewOrchangeOrder"`) links to
  `…/orderdetails/<n>`; `#orderDate_<n>`, `#totalPrice_<n>`, "Delivered on MM/DD/YYYY", tracking,
  and product links `…/<slug>.product.<item number>.html`.
- **Order details:** `automation-id` `orderNumber`, `orderDate`, `orderTotalOutput` (subtotal,
  shipping, `taxOutput`), `orderTotal`; "2-Day Delivery"; "Delivered on …"; per item a product
  link, `automation-id="itemNumber"` ("Item N"), the unit price, "Quantity N", then the line total.
  Quantity > 1 is invented here (the saved order had only quantity 1). Live (2026-11-16), an
  item's fee is printed inside the item's block after its total — "CA BEP FEE PERCENT", its price,
  "Quantity N", "Total", its total — and `orderTotalOutput` can carry "Discount on Order"
  (`automation-id="totalDiscountOutput"`, `-$x`); the tests add both to a one-item copy of the
  order. Everything under
  `data-private="true"` (addresses, contact, payment, membership number) is never read.
- **Item numbers are shared:** the same product carries the same item number on warehouse
  receipts and online orders (live: a bath tissue at $29.99 in the warehouse, $34.99 delivered).
  In these fixtures `9000201` is on both, at $23.99 and $27.99.
- **Cards render late.** The frame (`myOrderHistory`, the tabs, the period picker) is there before
  a tab's cards: read the list only once `a#orderNumber_…` / `#viewRecieptBtn_…` has rendered
  (first live sweep, 2026-11-15, read the frame alone). Card texts are inline, so a date can run
  straight into the next text ("Delivered on 11/10/2026Order …"): no `\b` after a date.
- Costco Same-Day delivery goes through Instacart and is not on these pages; the household doesn't
  use it.
