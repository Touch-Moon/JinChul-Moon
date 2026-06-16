# JinChul-Moon — EcomExperts Hiring Test

Custom Shopify theme built on Dawn for the EcomExperts coding exercise.

## Custom sections

Two new sections implemented from scratch (no Dawn ready-made sections reused):

| Section file | Purpose |
|---|---|
| `sections/gift-banner.liquid` | Full-width banner: logo bar, headline, sub-copy, CTA, bottom strip. All text editable via Theme Customizer. |
| `sections/gift-lookbook.liquid` | Shoppable lookbook (photo grid, 3×2 desktop / 2×3 mobile, up to 6 photos). Each photo carries a positioned "+" marker; a per-photo lifestyle image and tagged product are set via Customizer blocks, and each marker's X/Y percent is editable. Clicking a marker opens the shared quick-view popup. |

The template `templates/page.gift-guide.json` wires both sections into a standalone page.

## Quick-view popup

The lookbook renders `snippets/gift-popup.liquid` once and loads `assets/gift-popup.js`;
marker clicks are delegated from `document`, so one shared modal serves every "+".
A marker carries only the product **handle** — on open, the controller fetches
`/products/<handle>.js` (cached per handle) and fills the popup with the product's
name, price, description, **Color** swatches, **Size** picker, and an Add-to-cart button.
Variants are resolved at runtime by matching the chosen option values; no IDs are hardcoded.

`assets/gift-marker-editor.js` is a Customizer-only marker-placement helper (drag a "+"
to copy its X, Y percent). It is guarded by `{%- if request.design_mode -%}` in
`gift-lookbook.liquid`, so it does **not** load on the live storefront.

## Running locally

Requires [Shopify CLI 3.59+](https://shopify.dev/docs/themes/tools/cli).

```bash
npm install -g @shopify/cli
shopify theme dev --store <your-store.myshopify.com>
```

## Deployment workflow

```bash
# Work on the development branch
git checkout development

# Push changes to the store's connected theme
shopify theme push --theme <theme-id>

# Then open a PR: development → master in GitHub
# and connect master via the Shopify GitHub integration
```

## Special cart rule

When a product variant with **Color = Black AND Size = Medium** (the size also matches
the short form **"M"**) is added to cart, the **"Soft Winter Jacket"**
(`handle: dark-winter-jacket`) is also added automatically in the same `/cart/add.js` request.

`assets/gift-popup.js` resolves the jacket's variant ID at runtime by fetching
`/products/dark-winter-jacket.js` and picking its first available variant — no numeric IDs
are hardcoded. If the jacket is sold out or fails to load, the shopper's own item is still
added (the bonus line is skipped rather than failing the whole batch).
