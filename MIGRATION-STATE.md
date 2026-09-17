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
| **Django Oscar** | `/home/solorak/monreve` | A second catalogue, same `shopify_export` app ported across. |
| **Django Oscar** | `/home/solorak/Documents/projects/seventeen` | A third. |
| **Shopify app** | `/home/solorak/shopifydev/shopify-import-export-metadata-objects` | Consumes them. React Router 7, embedded admin app. |

The three Django sides are **siblings, not a fork to be merged**: they share the
shape of `shopify_export` almost line for line and differ in what their
catalogues carry (`PRODUCT_METAFIELDS` is different in each). Work done on one
does not land on the others by itself. All three run Python 3.8 with `project/`
on the path in its own right, so a settings module reads `multisite.settings`,
not `project.multisite.settings`.

Their country-code env vars differ: `DJANGO_OSCAR_RADIANT_COUNTRY_CODE`,
`DJANGO_OSCAR_MONREVE_COUNTRY_CODE`, `DJANGO_OSCAR_SEVENTEEN_COUNTRY_CODE`.

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
| `claim-metaobjects/` | `claim-entries.csv` (5 — see below) |
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
| `claim` | 5 | `name`, `image`. **Built by hand in the store**, so the export matches it rather than creating entries. See below. |

### The claim export matches the store, it does not add to it

The merchant created the claim badges in the admin. The catalogue carries 15,
the store has 5, and the store's 5 are the set that is wanted — so the Django
export is a **match**, not a create:

- The entries CSV carries the live definition's field keys, `name` and `image`.
  It used to carry `title, description, image, display_order`. That file could
  not import at all: `name` is required and had no column, so every row errored,
  and the other three were dropped as unknown columns.
- Claim handles carry **no site suffix**. The live entries are `paraben-free`,
  not `paraben-free-radiant`, and the handle is the upsert key — a suffix means
  a duplicate rather than an update. Shade handles keep theirs; a shade belongs
  to one catalogue, a claim badge does not.
- Which claims are exported comes from
  `shopify_export/data/claim_entries.csv` — this app's own entries export,
  saved there. A catalogue claim not in that file is skipped. Override the path
  with `OSCAR_SHOPIFY_EXPORT['CLAIM_ENTRIES']`. **With no such file every claim
  is exported**, which is what a store with no claims yet needs.
- An image already on a live entry is carried through as its gid. Exporting the
  catalogue URL instead would make the importer re-upload the artwork and
  replace the badge the merchant picked. Entries with no image still get the
  catalogue's, so gaps fill without choices being overwritten.

The net effect: re-importing the file reports every row **unchanged**. That is
the point — it is the proof the two sides agree.

Refresh `data/claim_entries.csv` from `/app` whenever the claims change in the
store. It is a copy of store state, and stale is the one way it misleads.

### Claims are linked through `custom.claim`

The entries put the badges *in* the store; this is what puts them *on a
product*. **In all three Django repos**, identical code.

- The metafield is `custom.claim`, `list.metaobject_reference`, pinned,
  restricted to the `claim` metaobject definition. `list.` because a product
  carries up to seven. The key is singular because that is what the app's "Show
  these on the product page" step derives from the metaobject type — the two
  routes to this definition have to agree or the second silently creates a
  second metafield.
- Both halves ride in **`product-metafields`**: a row in
  `product-metafield-definitions.csv` and a
  `Claims (product.metafields.custom.claim)` column in `product-metafields.csv`.
  That heading is exactly the label `metafieldTargets()` builds, so
  `/app/product-update` auto-matches it with nothing to map.
- Cells are **bare handles** joined with `;` —
  `dermatologically-tested;paraben-free;…`. Bare works only because the
  definition is restricted; unrestricted, every cell would need `claim:` in
  front of each handle.
- The definitions CSV gained a **`metaobject_type`** column carrying `claim`,
  and the app's CSV importer resolves it to a definition gid. Before this, the
  CSV route could only make unrestricted reference metafields — which import
  cleanly and then reject every row. A row naming a type the store does not
  have is a reported failure, not a definition pointing at nothing.
- Handles come out in the **store's** order, not the m2m's. The m2m has no
  ordering, so without this every product reads as changed on re-import.
- A catalogue claim the store has no entry for is **dropped from the cell**, not
  exported. The importer rejects a whole cell on one unknown handle, so keeping
  it would cost the product every badge it does have.
- A product with no matched claim gets **no cell at all**. Blank means "leave it
  alone" to the importer, so removing every claim in Oscar does not remove them
  in Shopify. That is the safe direction and matches the rest of this app.

⚠️ **The two sides disagree on plurals.** Oscar says `PARABENS FREE`, the badge
is `paraben-free`. `LiveClaims` now tries a singular fallback (a trailing `s`
dropped from words of five letters or more) *after* every exact spelling has
been indexed, so a store carrying both forms still keeps them apart. Without it
53 products lost that badge silently — an unmatched claim is not an error, it is
simply absent.

Measured against each intl database:

| Repo | Exportable | With claims | Catalogue claims matched |
| --- | --- | --- | --- |
| radiant-new | 142 | **142** | 4 of 15 |
| monreve | 110 | 64 | 5 of 17 |
| seventeen | 223 | 206 | 3 of 17 |

**The store has only five badges, and every catalogue has far more claims than
that.** Most of what the catalogues carry has nowhere to go and is dropped. Two
cases are worth a merchant's decision rather than a matcher's guess:

- seventeen has `Waterproof` and `Water and Sweat Resistant`; the store badge is
  `water-resistant`. Not folded — in cosmetics those are different claims.
- radiant-new and seventeen have no paraben claim at all, so the store's
  `paraben-free` badge goes unused there. monreve's `PARABENS FREE` is the one
  that needed the singular fallback.

To use more of them, build the badges in the store first, then refresh every
repo's `data/claim_entries.csv` from `/app`.

⚠️ The definitions CSV still contains a `claim` row. The store already has the
type, so importing it fails — `metaobjectDefinitionCreate` cannot update, and
this app has no update path. It is for a fresh store only.

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

### The source file's handles do not have to be spelled Shopify's way

`matchSource` tries the **exact** handle, then the **folded** handle
(`normalizeHandle`: accents stripped, case folded, every run of punctuation to a
single `-`), then the title.

The folded step exists because a shop's own export writes slugs its own way.
One Romanian catalogue (Nica Beauty) exports `EXQUISITE_PRIMER` where Shopify
has `exquisite-primer`, and on exact matching alone that dropped **38 of its
110 matchable products** from the built file — silently, because a product that
matches nothing is simply one the builder never sees. Matched went 72 → 110 and
filled rows 144 → 220 once folded.

Folding is a **fallback and never a replacement**, so it can only add matches.
That matters: that same file contains both `lip-balm-pod` and `LIP_BALM_POD`,
which fold together — the exact lookup runs first, so neither can take the
other's match.

### A value identical to the source is never written

`buildTranslationCsv` skips any row whose formatted value equals that row's
`Default content`, and reports the count as `unchanged`.

This is the structural version of the "do not map `Title`" guidance above.
Shopify **rejects** such rows outright — one Nica Beauty import came back
`Failed: 72`, and all 72 were `handle` rows whose "translation" was the handle —
and where it does accept one, it marks the product translated when nothing was.
On that catalogue only **22 of 110** titles are genuinely different in Romanian;
the other 88 used to be written as translations of themselves.

`handle` also has `format: "handle"` now, so a mapped slug column is run through
`normalizeHandle` before comparison. A shop's slug column reads `DEWY_SKIN`, and
writing that verbatim gave 38 products a Romanian URL handle of `DEWY_SKIN`.
Normalised it becomes `dewy-skin`, which equals the default and is skipped — so
mapping a slug column to `handle` is now inert rather than destructive.

⚠️ **The title fallback is inert unless the title column is called `title`.**
`findColumn` matches exactly, so the Nica Beauty export's `Titlu [en]` is not
found, `byTitle` is empty, and mapping a title column changes nothing about
*matching* — it only chooses what gets written. If a file matches nothing and
its title column is named in another language, that is why.

`shopify_products_el.csv` is **correct as a translation source** and
**dangerous as a product import** — feeding it to the product importer
overwrites the English products with Greek text.

---

## Bugs found and fixed

**Django**

- **Recommended products are exported.** Oscar's upsell block
  (`ProductRecommendation`) now fills
  `shopify--discovery--product_recommendation.related_products` — the column
  `SHOPIFY_HEADERS` has always carried and nothing ever filled. Written as
  product **handles** joined by `;`, the spelling Shopify's own export uses for
  a `list.product_reference`.

  **Only products the same export writes.** A recommendation pointing at
  something unexported would name a handle the store has never heard of, and an
  unresolvable product reference fails the row rather than being skipped — so
  the export takes the intersection. Ordering is `ranking` first, then position
  in the export; ranking is 0 on almost every row in these catalogues, so the
  second key is what actually decides, and without it the cell would come out
  in a different order each time and every product would read as changed.

  **A recommendation may name a variant, and a variant is not a product in
  Shopify** — it has no handle and cannot be the target of a product reference.
  Those resolve to the parent, which is the page the link would land on anyway.
  Not an edge case: radiant recommends `Loose Powder (10 Pink)` and
  `Touch of Blush (03 Rosy)` from "Natural Fix All Day Matt Foundation", and
  46 of its 346 recommendations are shade-level. Dropping them lost real links
  to products that were in the export all along, under another handle. Two
  shades of one product collapse to one reference, and a product recommending
  its own shade — which resolves to itself — is left out.

  | | Products with recommendations | References | Variant targets recovered | Self-refs dropped |
  | --- | --- | --- | --- | --- |
  | monreve | 92 of 110 | 279 | 0 | 0 |
  | radiant-new | 83 of 142 | 314 (+44) | 46 | 2 |
  | seventeen | 131 of 223 | 399 (+28) | 29 | 0 |

  Zero dangling references in all three, checked against the handles each file
  itself carries. monreve is unchanged because it has no shade-level
  recommendations at all.

  **The app side needed the other half.** `list.product_reference` was falling
  through to the generic list branch, which JSON-encodes the cell as written —
  so handles went to the API where gids were required. `resolveProductHandles()`
  now resolves them in one batched `productByIdentifier` pass (not
  `products(query:)` — a loose handle match would silently recommend the wrong
  product), and `toMetafieldValue` converts both `product_reference` and
  `list.product_reference`. An unknown handle is a per-row error, not a silent
  drop.

- **A category metafield on an uncategorised product killed the whole product.**
  `shopify.color-pattern` is a Shopify **category metafield**: its definition is
  scoped by *owner subtype*, the product's taxonomy category. A product whose
  `Product Category` is empty satisfies no such constraint, and Shopify rejects
  every row of it — `Validation failed: Owner subtype does not match the
  metafield definition's constraints`, naming no column. In one monreve import
  that was 14 products, and the predicate matched the failures exactly: of 46
  products carrying the metafield, the **14 with no category failed and the 32
  with one imported**.

  `_carries_category_metafields()` is now the gate. No category means no
  `shopify.color-pattern` cell *and* no linked shade option — linking writes the
  same metafield, so it fails the same way. The product still exports, with its
  shades as plain option values.

  That is the guard. The **fix** is a category, so nine catalogue names that
  carry shades were mapped: `blusher`, `eyeliner`, `liquid lipstick`,
  `lip gloss`, `lip oil`, `lip balm`, `french manicure`,
  `highlighting & contouring`, `glitter gel`. All nine reuse a path already
  present in the table — an unverified deeper guess would trade this failure for
  a rejected category — so `lip gloss` and `lip oil` stop at `Lip Makeup` and
  `glitter gel` at `Makeup`. All 14 products now export with a real category
  **and** keep their swatches.

  After this: **0** products carry the metafield without a category in any of
  the three, and **nothing lost swatches** — radiant's 49 uncategorised products
  have no shades at all, and seventeen has none uncategorised.

- **Tools were exporting as the cosmetic they apply.** `Product Category` takes
  the deepest catalogue category that has a taxonomy path, and a foundation
  brush sits in `Brushes` *and* `Face` — `Face` is deeper, so every brush went
  out as makeup. `SHOPIFY_TOOL_CATEGORIES` (`tools`, `brushes`,
  `brushes & tools`, `makeup sponges`) is now checked **first** and wins
  outright, and `_TOOL_TITLE_RE` catches the rest by title: `151 EYEBROW BRUSH`
  is filed only under `Eyebrows`, so no category could tell it from a brow
  pencil. `_TOOL_TITLE_EXCLUDE_RE` then takes back the things sold *for* tools —
  `BRUSH CLEANSER & CONDITIONER` is a liquid, and it is filed under
  `Brushes & Tools`, so the exclusion has to beat the category too. Whole-word
  matching is what keeps `10 FACIAL CLEANSING GLOVE SPONGE` a tool: "cleansing"
  is not "cleanser".

  Tool names are deliberately **not** in `SHOPIFY_PRODUCT_CATEGORIES`. A name in
  both tables comes back through the second one after the first has ruled it
  out — which is exactly how the brush cleanser slipped through the first cut.

  `Accessories` is deliberately not a tool category: it holds sponges, but
  mirrors and beauty cases too. Those stay uncategorised, which beats
  confidently wrong.

- **`Brows` was unmapped while `Eyebrows` was mapped.** Both names are in use.
  The result was backwards: brow *makeup* (in `Brows`) exported with no category
  at all, while a brow *brush* (in `Eyebrows`) exported as Eyebrow Enhancers.
  `brows` now maps alongside `eyebrows`.

  Measured effect: **monreve 44 of 110** products change (40 to Makeup Tools, 4
  to Eyebrow Enhancers), **radiant-new 22 of 142** (16 / 6), **seventeen 2 of
  223** (2 / 0) — seventeen was already mostly right because its `Αξεσουάρ`
  category carries the English name `Tools`. Every changed row was read by hand;
  no cosmetic was dragged into Makeup Tools.

  Two judgement calls worth knowing: brush **sets** move from `Cosmetic Sets` to
  `Makeup Tools` (5 in monreve), and seventeen's `Sonic To Glow Facial Brush`
  moves from `Facial Cleansers` to `Makeup Tools`. Both are defensible and
  neither was asked for; say so and either can be carved out.

- **The option columns now match Shopify's own export exactly.** `Option1 Name`
  and `Option1 Linked To` describe the option, which belongs to the product, so
  Shopify writes them on the product's **first row only** and leaves them blank
  on the remaining variant rows; only `Option1 Value` repeats. We were
  repeating all three. Both shapes import correctly — this was verified against
  a real store export of `lip-mousse`, which our file had created — so the cost
  was the round trip, not the import. All three repos now emit the first-row
  form, and a regenerated `lip-mousse` is byte-identical to Shopify's export of
  it across all three option columns, 41 rows each.

  The values themselves were already right and are now confirmed against that
  export: `Option1 Value` is the **metaobject handle** (`01-madrid-780f1a-monreve`),
  not the display name, and `Option1 Linked To` is
  `product.metafields.shopify.color-pattern` — exactly `SHADE_OPTION_LINKED_TO`.
  Neither had ever been checked against a real Shopify file; the test asserted
  the constant against itself.

  The **inventory** CSV is a different format and legitimately repeats
  `Option1 Name` on every row. It was deliberately left alone.

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

- **`-2`, `-3` … on a shade handle is not a duplicate.** The store holds 335 of
  them and they look exactly like a botched repeat import. They are not: shade
  labels collide constantly across products — a dozen products each have a
  "No.01" — so `_unique_handle()` disambiguates, and the display name carries
  the product in brackets (`No.01 (Clear Skin Spot Control Compact Powder
  SPF20)`). Checked: of the 335 numbered handles whose base also exists,
  **0** share a colour with their base; all 335 are distinct shades. Before
  "cleaning up" any of these, compare the `color` column — that is what tells a
  disambiguated shade from a real duplicate.
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

1. **Shades are still not linked from products.** Claims now are — see
   "Claims are linked through `custom.claim`" below. The same treatment for
   `shopify--color-pattern` is unbuilt; it is also less needed, because a shade
   reaches the product through its option value rather than a metafield.
2. **`product_video_poster`** (5 products) has no home. It is a file, and the
   product importer writes metafield cells verbatim, so a URL would land in a
   `file_reference` expecting a gid.
3. **`related_products_display`** is still unfilled — the settings metafield
   beside `related_products`, which controls how the storefront renders the
   block. `related_products` itself is now exported and imported; see "Bugs
   found and fixed".
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
8. **Pre-existing `Vendor` test failures in two repos.** Of the 121 no-database
   tests, radiant-new fails 3 and seventeen fails 2, all in `VendorTests` /
   `test_excludes_unpublished_and_includes_zero_stock_items`. `configured_vendor()`
   returns the site's real name where the test expects the overridden
   `OSCAR_SHOP_NAME`, so `@override_settings` is not reaching it. Confirmed
   unrelated to recent work by A/B — the same failures appear with the changes
   reverted. monreve passes all 121. radiant-new's file also asserts
   `"Seventeen Cosmetics"` in one place, a copy-paste artifact of the port.
   So does seventeen's `_shade_metaobjects` docstring, which says `-radiant`.
   Harmless, but a reminder that the three files were copied, not generated:
   grep for a sibling's brand name before trusting any string in them.
9. **`studio-3-step-manicure-system` (seventeen, id 436) exports 294 media**,
   over Shopify's limit of 250. The exporter warns; Shopify rejects the whole
   product. It needs splitting or fewer variant images.

---

## Companion documents

- `PLAN-oscar-import.md` — the original migration design. **Partly superseded**:
  its `translationsRegister` section is not the route taken (Translate & Adapt
  CSV is), and its collections work is unbuilt.
- `PLAN-export-hub.md` — the export hub plan. Built, but scoped down to Shopify
  exports only; the wider consolidation across `import_export` and the ad-hoc
  `core/urls.py` endpoints was not done.
- `PLAN-metaobject-image-import.md` — the file/image import design. Fully built.
