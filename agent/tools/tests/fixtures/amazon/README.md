# Synthetic Amazon / Whole Foods pages

Hand-written, synthetic HTML for the tool tests — **no real order data** (CLAUDE.md privacy rule).
Order ids, ASINs (`B0SYNTH…`), products and prices are invented. Class names are deliberately
random (`x7f-…`): the parsers must not depend on them. Each file mimics only the structure the
tools rely on (DESIGN §6): `/dp/` and `/gp/product/` links, `orderID=` links, the add-to-cart
form's `action`, `ASIN.n` inputs, and visible text.

| File | Page |
|---|---|
| `cart_add_confirm.html` | tier-1 add-to-cart confirm page (one ASIN unavailable, one not listed) |
| `cart_added.html` | result after the confirm click |
| `cart_add_layout_changed.html` | "layout changed": no add form, no "added" message |
| `orders_list_p1.html`, `orders_list_p2.html` | order history, two pages |
| `order_details_delivery.html` | delivered Amazon order (+ a recommendations carousel) |
| `order_details_pickup.html` | Whole Foods pickup (slugged `/Name/dp/` links) |
| `order_details_instore.html` | Whole Foods in-store purchase (`/gp/product/` links) |
| `order_details_arriving.html` | order still in flight |
| `order_details_layout_changed.html` | final order with zero ASIN links (agent fallback) |
| `product_jsonld.html`, `product_offscreen.html`, `product_no_price.html` | price checks |
