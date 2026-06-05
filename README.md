# JinChul-Moon — EcomExperts Hiring Test

Custom Shopify theme built on Dawn for the EcomExperts coding exercise.

## Custom sections

Two new sections implemented from scratch (no Dawn ready-made sections reused):

| Section file | Purpose |
|---|---|
| `sections/gift-banner.liquid` | Full-width banner: logo bar, headline, sub-copy, CTA, bottom strip. All text editable via Theme Customizer. |
| `sections/gift-grid.liquid` | 2×3 product grid. Each of the 6 products is selectable via Customizer product pickers. Clicking "+" on a card opens the quick-view popup. |

The template `templates/page.gift-guide.json` wires both sections into a standalone page.

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

When a product variant with **Color = Black AND Size = Medium** is added to cart,
the **"Soft Winter Jacket"** (`handle: dark-winter-jacket`) is also added automatically.

`assets/gift-grid.js` resolves the jacket's variant ID at runtime via
`GET /products/dark-winter-jacket.js` — no numeric IDs are hardcoded.
