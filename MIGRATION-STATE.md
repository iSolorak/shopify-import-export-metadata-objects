# Oscar → Shopify migration — state of play

Read this first. It is the standing record of what exists across both
repositories, what it is for, and what is still open. It describes the system as
built, not a plan.

Last updated: 2026-09-11.

---

## The two repositories

| | Path | Role |
| --- | --- | --- |
| **Django Oscar** | `/home/solorak/radiant-new` | Produces CSVs. Django 3.2 + Oscar 3.2 + Wagtail. |
| **Shopify app** | `/home/solorak/shopifydev/shopify-import-export-metadata-objects` | Consumes them. React Router 7, embedded admin app. |

**The contract between them is CSV files carried by hand.** Nothing is wired
API-to-API: the Django app holds no Shopify credentials, the Shopify app holds
the OAuth session, and every import goes through a review step before it writes.
Do not "simplify" this into a direct integration without saying so first.

### Running them

```bash
# Django (this is what serves 127.0.0.1:8000)
cd /home/solorak/radiant-new
source virtualenv/bin/activate
python ./manage_intl.py runserver          # settings: project.multisite.intl.settings

# Shopify app
cd /home/solorak/shopifydev/shopify-import-export-metadata-objects
npm run typecheck && npm run lint          # both must stay clean
```

The running site is the **intl** multisite (`LANGUAGES = en, el`). `manage.py`
is gitignored and absent; use `manage_intl.py`.

### Testing the Oscar side

`manage.py test` **cannot run** — it dies building a test database on
`ValueError: Related model 'order.billingaddress' cannot be resolved`, a
pre-existing project problem unrelated to this work. The `shopify_export` suites
are `SimpleTestCase` and need no database, so run them directly:

```python
# Boot django with project.multisite.intl.settings, then unittest the
# SimpleTestCase subclasses in shopify_export.dashboard.tests, skipping the
# TestCase ones (they need a DB). ~61 tests, all passing.
```

---

## Catalogue facts (intl site, as measured)

| | |
| --- | --- |
| Public products | 575 |
| **Exportable** (public **and** has a public variant) | **142** |
| Variants | 520 |
| Distinct shades | 455 |
| Claims | 15 |
| Locales | `en`, `el` |

Only five Oscar product attributes carry any data: `shade_description` (472),
`shade_hex` (457), `oz` (326), `ml` (307), `gram` (263).

Product text fields, filled of 142: `short_description` 142, `usage` 133,
`facts`/Ingredients 115, `warnings` 5, `specifications` **0**,
`video_title` **0**, `video_url` **0**.

**Titles are not translated.** All 142 are byte-identical in `en` and `el`.
Descriptions and SEO descriptions are fully translated.

---

## Django side — `project/shopify_export/`

```
exporters.py          all export logic
exports.py            the registry behind the dashboard hub
dashboard/views.py    one view per URL, plus the hub
dashboard/apps.py     OscarDashboardConfig, is_staff, the URLs
dashboard/tests.py    ~61 no-database tests
templates/dashboard/shopify_export/index.html
```

### URLs — all under `/dashboard/shopify-export/`

| Path | Produces |
| --- | --- |
| `` (the hub) | The page listing every export with its options |
| `products/` | ZIP: products + inventory per locale, videos |
| `shade-metaobjects/` | `shopify--color-pattern-entries.csv` (455) |
| `claim-metaobjects/` | `claim-entries.csv` (15) |
| `metaobject-definitions/` | `shopify-metaobject-definitions.csv` |

The hub is the app root — that path used to 404, so adding it broke nothing and
every sub-URL still works standalone. Exports are grouped in **import order**
(schema → metaobject data → products), which is itself the instruction.

`product-metafields` is reachable **only from the hub** (it has no standalone
URL) and returns `shopify_product_metafields.zip`.

### The registry

`exports.py` describes each export: key, label, group, description, filename,
content type, params, and a note for the things that bite. The hub's POST
handler rebuilds a `QueryDict` from the form and assigns it to `request.GET`,
then calls the builder unchanged — **that seam is why no export logic lives in
the hub**. Keep it that way.

---

## Shopify app side

Nav (`app/routes/app.tsx`):

| Page | Route | Does |
| --- | --- | --- |
| Import & export | `/app` | Metaobject definitions + entries |
| **Metaobject fields** | `/app/metaobject-fields` | Create definitions and metafields |
| Import & export rich text | `/app/rich-text` | Product rich text metafields as HTML |
| Translation CSV builder | `/app/translations` | Fills a Translate & Adapt export |
| Add product videos | `/app/product-videos` | Attaches hosted videos |
| Update products | `/app/product-update` | Non-destructive product/metafield update |

Scopes: `write_products, write_metaobjects, write_metaobject_definitions,
read_inventory, write_inventory, read_locations, write_files`.

API version **2026-07**, pinned in `app/shopify.server.ts` and `.graphqlrc.ts`.
Every GraphQL document in the app has been validated against that schema with
the Shopify Dev MCP. `shopify.app.toml` sets `[webhooks] api_version = 2026-10`
— a deliberate-looking mismatch that is legal but undocumented.

### Client IDs

| Config | client_id | `automatically_update_urls_on_dev` |
| --- | --- | --- |
| `shopify.app.toml` | `0035a3a7a4b32139c1b552815c23f537` | false |
| `shopify.app.test-app.toml` | `0035a3a7a4b32139c1b552815c23f537` | **true** |

⚠️ Both now point at the **same live app**, and the test config permits URL
rewriting. `shopify app config use test-app && shopify app dev` will rewrite the
live app's `application_url` and redirect URLs to a tunnel address. The user was
warned and chose this. The other dev app is
`ab6e8005f4791aae2959d1e31c42bbd9` (store `solodev-ifttyxih.myshopify.com`).

---

## The pipeline, in order

```
1. Metaobject definitions   Django: metaobject-definitions/  → App: /app (definition CSV)
2. Shade swatches           Django: shade-metaobjects/       → App: /app (pick shopify--color-pattern)
3. Claim badges             Django: claim-metaobjects/       → App: /app (pick claim)
4. Product metafields       Django: hub → product-metafields
                              4a. definitions CSV → /app/metaobject-fields
                              4b. values CSV      → /app/product-update
5. Products                 Django: products/                → Shopify admin Products → Import (first time)
                                                             → /app/product-update (thereafter)
6. Videos                   from the products ZIP            → /app/product-videos
7. Translations             see below
```

Order is not advisory. A definition must exist before its entries; the shade
entries must exist before the products CSV, whose option values are shade
handles; a metafield must be defined before it can be filled.

**The app cannot create products.** `/app/product-update` errors with
`No product with the handle "…"` for anything not already in the store — by
design, so an import cannot destroy metafields, videos and collection
memberships the way Shopify's "overwrite" import does. First load is Shopify's
own Products → Import.

---

## What is a metaobject and what is a metafield

Settled after several rounds; do not re-litigate without reason.

**Metaobjects** — a record reused across many products:

| Definition | Entries | Notes |
| --- | --- | --- |
| `shopify--color-pattern` | 455 | Shopify **standard**; enable in admin, cannot be created. Excluded from the definitions CSV on purpose, with a test pinning that. |
| `claim` | 15 | title, description, image (URL → uploaded), display_order |

**Metafields** — one value per product, `rich_text_field`, pinned, storefront
readable:

`custom.short_description`, `custom.usage`, `custom.ingredients`,
`custom.warnings` (+ `custom.specifications` only with `include_empty`).

These were **briefly** modelled as per-field metaobjects
(`product_usage`, `product_ingredients`, …). That approach was removed — 245
lines deleted — because the content belongs to one product and is read by one
product, so the indirection cost three steps and bought nothing. If you find
references to `product_usage` metaobjects anywhere, they are stale.

Everything the products CSV already carries is excluded from the metafield
export, enforced by `PRODUCT_FIELDS_ALREADY_EXPORTED` in `exporters.py` and a
test.

---

## Translations

The user has **Shopify Translate & Adapt**. Use the CSV round trip, not
`translationsRegister`.

1. Add Greek in Translate & Adapt.
2. Export from T&A (one locale at a time — the builder assumes a single locale).
3. In `/app/translations`, upload the T&A export **plus**
   `shopify_products_el.csv` as the source.
4. Map columns, download, import back into T&A.

**Map `Body (HTML)` → body_html, `SEO Description` → meta_description,
`Type` → product_type. Do NOT map `Title`** — titles are untranslated, and
mapping it writes English into `Translated content`, marking a product
translated when it is not.

The join works because handles are identical across locales
(`WAGTAILMODELTRANSLATION_TRANSLATE_SLUGS = False`), and the app recovers each
handle from the `handle` row's `Default content` in the T&A export itself.

`shopify_products_el.csv` is **correct as a translation source** and
**dangerous as a product import** — feeding it to the product importer
overwrites the English products with Greek text.

---

## Bugs found and fixed

**Django**

- `Vendor` was the literal string `"Oscar"` on every product. `OSCAR_SHOP_NAME`
  is unset project-wide, so Oscar's placeholder default reached the CSV. Now
  `configured_vendor()` treats it as unset and falls back to the site name.
- All 37 SEO descriptions carried HTML into a plain-text field. `strip_html()`
  removes tags and decodes entities.
- Every non-shade variant was exported as option name `"Color"`, so fragrances
  sold in 30/50/100 ml became colour swatches labelled `ml: 100`. Now `Size` /
  `30 ml`, via `size_option_value()`; shades still win over sizes.
- **Handle collisions.** Three slugs collide (`de-puffing-eye-cream` ×2,
  `lift-renew-eye-cream` ×2, `sun-defense-fluid-moisturizing-cream` ×4). The
  products CSV disambiguates with the product id; the metafield export did not,
  so five products would have received another product's copy. All exports now
  derive handles through the shared `build_product_handles()`, which takes the
  **whole set** — the handle is not a property of a single product.
- `configured_languages()` falls back to `settings.LANGUAGES`, which is unset in
  `project/core/settings.py` → Django's ~100-language default. Harmless on the
  intl site (which sets it), latent elsewhere. **Not yet fixed.**

**Shopify app**

- The metaobject entries import reported "N to create" for rows that could never
  succeed when the definition had a required field the file had no column for.
  Now a per-row error at plan time. Creates only; updates may omit a required
  field, since upsert leaves out what it is not given.
- Added `definitionMismatch`: when **no** column maps to the chosen definition,
  the review step now says so outright instead of burying it in an "ignored
  columns" note beside hundreds of identical row errors.
- Rich text cells are converted HTML → Shopify JSON **before** the diff, and
  compared as rendered HTML, so an unedited re-import reports `unchanged`.
- `Option1/2/3 Linked To` and the four `Unit Price` columns were reported as
  unrecognised on every import; now listed as deliberately ignored with reasons.

---

## Gotchas that cost time

- **Pinning.** `MetafieldDefinitionInput.pin` defaults to `false`, and an
  unpinned definition never appears in the product page's metafields card — it
  looks exactly like the import having done nothing. The app pins by default and
  sets `access: { storefront: PUBLIC_READ }`, without which a theme cannot read
  the value.
- **`Key is in use`** from `metafieldDefinitionCreate` means the definition
  already exists; it refuses to overwrite. The app now reports these as skipped
  rather than failed. Check the existing one is `rich_text_field`, pinned, and
  storefront-readable — an earlier metaobject-reference definition on the same
  key would be the wrong type.
- **Reserved prefixes.** `shopify--` and `app--` cannot be created;
  `shopify--color-pattern` is enabled in the admin. The form rejects them with
  an explanation.
- **`collectionAddProducts` and `collectionByHandle` are deprecated on 2026-07**,
  but their replacement (`collectionUpdate` with `inclusion.selectionsToAdd`)
  **does not exist on that version**. The deprecated call is the pragmatic path.
- Image URLs in the export are real public `radiant-professional.com` URLs, not
  `127.0.0.1` — `MEDIA_URL` is absolute. Earlier worry was unfounded.

---

## Open items

1. **Nothing links products to metaobjects.** Claims and shades have entries,
   but no product references them. Needs `custom.claim`
   (`list.metaobject_reference`) and columns in the products CSV holding the
   entry handles. The app can create the metafield (Metaobject fields → "Show
   these on the product page"); the Django products CSV columns do not exist yet.
2. **`product_video_poster`** (5 products) has no home. It is a file, and the
   product importer writes metafield cells verbatim, so a URL would land in a
   `file_reference` expecting a gid.
3. **`recommended_products`** (85 products) is unexported. Belongs in Shopify's
   `shopify--discovery--product_recommendation.related_products`, a column the
   products CSV already emits but never fills.
4. **`configured_languages()`** fallback bug above.
5. **Multi-store question, unresolved.** `bg` and `ro` are separate Django
   databases with separate catalogues, not translations of the GR one. That may
   mean several Shopify stores rather than one multi-locale store. Shade handles
   are suffixed from `WAGTAIL_SITE_NAME` (`-radiant`), so importing two sites
   into one store would collide unless the suffix differs.
6. **`/dashboard/dev/`** still auto-discovers export links and still misses every
   namespaced one, including all five Shopify exports — it lists 8 of 24. It is
   now a second, worse hub.
7. **No JS test runner** in the Shopify app. `package.json` has no `test`
   script; verification is `typecheck` + `lint` + ad-hoc harnesses.

---

## Companion documents

- `PLAN-oscar-import.md` — the original migration design. **Partly superseded**:
  its `translationsRegister` section is not the route taken (Translate & Adapt
  CSV is), and its collections work is unbuilt.
- `PLAN-export-hub.md` — the export hub plan. Built, but scoped down to Shopify
  exports only; the wider consolidation across `import_export` and the ad-hoc
  `core/urls.py` endpoints was not done.
- `PLAN-metaobject-image-import.md` — the file/image import design. Fully built.
