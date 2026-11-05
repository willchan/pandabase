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
| `cart_add_confirm_one.html` | tier-2 single-ASIN confirm page with a Buy Now control inside the form |
| `cart_add_buy_now_only.html` | an add form whose only submit is Buy Now / 1-Click (never clicked) |
| `cart_view.html`, `cart_view_after.html` | cart page before / after a tier-2 add (active, saved-for-later, recommendations) |
| `search_results.html` | tier-2 search results: sponsored, size swatch, unavailable, an injection-style title, a legacy row |
| `cart_view_recs.html` | where `/gp/aws/cart/add.html` lands now: the cart, unchanged, with recommendation add forms |
| `product_add_form.html` | product page with the add-to-cart form (Buy Now inside it) and a related-item form |
| `product_wholefoods.html` | Whole Foods product page: buy-box widget (no form), sponsored `spAddToCart` ads (one for the same item), another item's widget outside the buy box |
| `product_wholefoods_pickup.html` | Whole Foods pickup offer as seen live: widget ids without the ASIN inside `#buybox`, an `<input type=submit>` add control, an unnamed quantity input, the cart flyout's checkout forms |
| `product_bundle_ad.html` | Amazon page as seen live: buy-box form posting to `handle-buy-box`, a sponsored `sspa` bundle form with this ASIN and two others, a comparison-table form |
| `product_buy_box.html` | Amazon buy box as seen live: three `handle-buy-box` forms (hidden subscription first, one-time with Buy Now and a hidden `isBuyNow`, wishlist) + a sponsored bundle; only the one-time "Add to cart", whose `formaction` is `/cart/add-to-cart`, may be clicked |
| `cart_localmarket.html` | Whole Foods cart: active rows in a `data-name="Active Items"` block, not in a form; saved and recommended items outside it |
| `product_unavailable.html` | product page with no add form for its own ASIN |
| `search_no_results.html` | tier-2 search with no results |
| `orders_list_p1.html`, `orders_list_p2.html` | order history, two pages |
| `order_details_delivery.html` | delivered Amazon order (+ a recommendations carousel) |
| `order_details_pickup.html` | Whole Foods pickup (slugged `/Name/dp/` links) |
| `order_details_instore.html` | Whole Foods in-store purchase (`/gp/product/` links) |
| `order_details_arriving.html` | order still in flight |
| `order_details_layout_changed.html` | final order with zero ASIN links (agent fallback) |
| `product_jsonld.html`, `product_offscreen.html`, `product_no_price.html` | price checks |
