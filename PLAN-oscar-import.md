# Plan — import the Django Oscar catalogue into Shopify

Two repositories, one pipeline:

- **Producer** — `/home/solorak/radiant-new/project/shopify_export/` (Django 3.2 + Oscar 3.2)
- **Consumer** — this app (`shopify-import-export-metadata-objects`)

The contract between them stays what it is today: **CSV files carried by hand**.
The Django app holds no Shopify credentials and the Shopify app holds the OAuth
session; coupling them directly would mean putting an access token in a Django
settings file, and the merchant would lose the review step that every import in
this app currently offers. Nothing below changes that.

---

## The headline: translations do not work the way the current export implies

**Yes, translations are possible — but not through the products CSV.**

`ShopifyProductExporter.build_zip()` writes one *complete* products CSV per
language: `shopify_products_en.csv`, `shopify_products_el.csv`, and so on. The
implication is that importing both gives you an English store with Greek
translations. It does not.

Shopify's product CSV importer **has no concept of a locale**. It matches rows on
`Handle` and writes them to the primary locale. Importing `shopify_products_el.csv`
after `shopify_products_en.csv` therefore does not add Greek translations — it
**overwrites the English titles, descriptions and SEO fields with Greek ones**, on
the same single set of products. The second file silently destroys the first.

Real translations go through the Admin API instead:

| Step | Operation | Notes |
| --- | --- | --- |
| 1 | `shopLocaleEnable(locale:)` | `el`, `bg`, `ro` must exist before anything can be written to them. Max 20 locales per shop; new locales are unpublished by default. |
| 2 | `translatableResources(resourceType: PRODUCT)` | Returns `resourceId` + `translatableContent { key value digest locale }`. |
| 3 | `translationsRegister(resourceId:, translations:)` | Each `TranslationInput` needs `locale`, `key`, `value` **and `translatableContentDigest`**. |

All five operations were validated against the 2026-07 schema this app pins.

**The digest is what forces the design.** A translation cannot be written without
the digest of the *source* content it translates, and that digest only exists once
the product is in Shopify. So translations are unavoidably a **second pass, after
the products land** — they cannot ride along in the products CSV, and there is no
ordering trick that avoids this. The digest also changes whenever the source
content changes, and a stale digest is rejected, so digests must be re-read on
every run rather than cached between runs.

Consequence for the Django side: writing a full products CSV per language is not
just wasteful, it is actively dangerous. It should be replaced by **one products
CSV in the primary locale, plus a thin translations file per additional locale**.

### What can be translated

Oscar's `ProductTranslationOptions` covers `title`, `description`, `meta_title`,
`meta_description`, `specifications`, `short_description`, `usage`, `facts`,
`warnings`. Those map onto Shopify as:

| Oscar field | Shopify translation key | Resource |
| --- | --- | --- |
| `title` | `title` | PRODUCT |
| `description` | `body_html` | PRODUCT |
| `meta_title` | `meta_title` | PRODUCT |
| `meta_description` | `meta_description` | PRODUCT |
| `specifications`, `usage`, `facts`, `warnings`, `short_description` | the metafield's own key | METAFIELD |
| Category `name`, `description`, `meta_*` | `title`, `body_html`, `meta_*` | COLLECTION |
| shade label | `label`, `display_name` | METAOBJECT |

Metafield and metaobject translations are registered exactly the same way — a
metafield is a translatable resource in its own right, with its own `resourceId`
and digest. This app already has half of the metafield story in
`translation-metafields.server.ts` (`resolveMetafieldOwners`), which exists
because Shopify's translations *export* identifies a metafield row by bare ID.

---

## Data inventory — what exists in Oscar and where it lands

| Oscar | Shopify | Status today |
| --- | --- | --- |
| `Product` (standalone/parent) + children | Product + variants | ✅ products CSV |
| `StockRecord` | price, compare-at, SKU, qty, cost | ✅ |
| `ProductImage` | `Image Src` | ⚠️ absolute URLs — `127.0.0.1:8000` when exported locally |
| `upload_video` | product media video | ✅ separate CSV → `app.product-videos` |
| `shade_hex` attribute | `shopify--color-pattern` metaobject | ✅ shade metaobject CSV |
| `Category` (treebeard tree) | `Product Category` taxonomy + `Type` | ⚠️ mapped to the taxonomy only — **the tree itself is discarded** |
| `Category` | **Collections** | ❌ missing entirely |
| `specifications`, `usage`, `facts`, `warnings`, `short_description` | product metafields | ❌ missing entirely |
| Claims (parent/child claim relationships) | metaobjects | ❌ missing |
| Tags | `Tags` | ❌ hardcoded `""` at `exporters.py:478` |
| Translations (`el` / `bg` / `ro`) | Shopify translations | ❌ see above — the per-language CSVs are harmful, not helpful |
| `meta_title` / `meta_description` | SEO Title / SEO Description | ✅ |

---

## A bug to fix first

`configured_languages()` (`exporters.py:187`) falls back to `settings.LANGUAGES`.
**`LANGUAGES` is never set in `project/core/settings.py`**, and there is no
`settings_local.py` — so on the main (GR) site the value is Django's own
`global_settings.LANGUAGES`, the built-in list of roughly a hundred languages.

`build_zip()` therefore loops that list and writes **two CSVs per language, ~200
files**, walking the whole catalogue each time. The multisite settings
(`project/multisite/bg/settings_base.py:25`, `ro/settings_base.py:26`) *do* set
`LANGUAGES` correctly, which is presumably why this has never been noticed — the
bug only bites on the site that is running locally right now.

Fix: prefer `MODELTRANSLATION_LANGUAGES`, then `OSCAR_SHOPIFY_EXPORT["LANGUAGES"]`,
then `LANGUAGES`, and refuse to run against more than a handful of locales rather
than quietly producing a 200-file archive.

---

## The shape of the pipeline

Four phases, in dependency order. Each is separately runnable and separately
re-runnable, because a migration of this size is never one clean shot.

```
1. Metaobjects   shades, claims          → app._index (exists)
2. Collections   category tree           → app.collections (new)
3. Products      + variants + metafields → app.product-update (exists)
4. Translations  el / bg / ro            → app.translations-import (new)
```

Phase 4 depends on phase 3 for digests. Phase 3 depends on phase 1 for the
`color-pattern` metaobject handles (the products CSV writes bare handles, and this
app's `metaobjectRefsIn` resolves them). Phase 2 is independent of 1 but depends on
3 for membership, so collections are created empty and populated after products.

---

## Changes — Django side (`radiant-new/project/shopify_export/`)

### 1. `exporters.py` — fix `configured_languages()`

As above. Small, and everything else in this section assumes it.

### 2. `exporters.py` — stop writing one products CSV per language

`build_zip()` becomes:

- `shopify_products.csv` — primary locale only.
- `shopify_inventory.csv` — primary locale only (the option values are the same
  metaobject handles in every locale, so the per-language copies were already
  redundant).
- `shopify_videos.csv` — unchanged.
- `shopify_translations_<locale>.csv` — **new**, one per additional locale.
- `shopify_collections.csv` + `shopify_collection_products.csv` — **new**.
- `shopify_metaobjects_<type>.csv` — **new**, generalising the shade export.

### 3. New — `ShopifyTranslationExporter`

Emits a flat, handle-keyed file that says nothing about Shopify IDs, because the
Django side does not know them:

```csv
resource,handle,locale,key,value
product,ultra-matte-foundation,el,title,Ματ Μεικ Απ
product,ultra-matte-foundation,el,body_html,<p>…</p>
metafield,ultra-matte-foundation,el,custom.usage,<p>…</p>
collection,foundations,el,title,Μεικ Απ
metaobject,04-true-beige-radiant,el,label,Αληθινό Μπεζ
```

`resource` + `handle` is the join key; the Shopify app resolves it to a
`resourceId` at import time. Values are exported with `fallback=False` — the
existing `_localized()` already does this, and it is what keeps an untranslated
field blank instead of leaking the base language into a Greek file.

### 4. New — `ShopifyCollectionExporter`

Oscar's `Category` tree is currently reduced to a taxonomy string and a `Type`
label, then thrown away. Shopify collections are flat, so the tree flattens: one
collection per category, handle from the category slug, `title` / `descriptionHtml`
/ SEO from the translated fields, and the ancestry preserved as a `parent_handle`
column the Shopify side can turn into a metafield or a tag.

`shopify_collection_products.csv` is `collection_handle,product_handle`, taken from
`Product.categories`.

### 5. New — product metafield columns in the products CSV

`specifications`, `usage`, `facts`, `warnings` and `short_description` are
translated HTML fields with no Shopify home today. Export them as
`Label (product.metafields.custom.<key>)` columns — the exact spelling Shopify's
own export uses, which means **this app's existing product importer already reads
them** (`METAFIELD_COLUMN` in `shopify-export-csv.ts`) and the rich text page
already converts HTML into `rich_text_field` JSON. No new consumer code needed for
this one.

### 6. Generalise the shade metaobject exporter

`ShopifyShadeMetaobjectExporter` is one concrete case of "turn an Oscar thing into
metaobject entry rows". Extract a base class with `headers` / `get_rows()` so
`claim` and future types drop in, and emit a `type` column so several types can
share one file.

### 7. Smaller items

- **Tags** (`exporters.py:478`) — populate from category names and product class
  instead of `""`.
- **Media base URL** — `_file_url()` uses `request.build_absolute_uri`, which
  yields `http://127.0.0.1:8000/...` on a local run. Shopify cannot fetch those, so
  every image silently fails. Add `OSCAR_SHOPIFY_EXPORT["MEDIA_BASE_URL"]`.
- **Dashboard UI** — there is no link to the export anywhere in
  `project/templates/`; both URLs are typed by hand. Add a small dashboard index
  page with the options (locale, inventory location, `link_options`) as form fields.

---

## Changes — Shopify app side (this repo)

### 1. New — `app/lib/translations.server.ts`

House conventions throughout: structural `Admin` type, private `query` that throws
on transport and `errors[]`, `#graphql` documents, mutations returning `userErrors`.

- `listShopLocales(admin)` — `shopLocales { locale name primary published }`.
- `enableLocale(admin, locale)` — `shopLocaleEnable`.
- `getTranslatableContent(admin, resourceIds)` — `translatableResourcesByIds`,
  batched at 100, returning `Map<resourceId, Map<key, digest>>`.
- `registerTranslations(admin, resourceId, translations)` — `translationsRegister`.

All four validated against 2026-07. Required scope: **`write_translations`**
(implies `read_translations`), plus **`write_locales`** only if the app enables
locales itself rather than asking the merchant to.

### 2. New page — `app.translations-import`

Distinct from the existing `app.translations`, which is a *builder* that fills in
Shopify's own translations export CSV. This one consumes the Django file directly
and writes through the API.

Plan step (read-only, as everywhere else in this app):

1. Parse `shopify_translations_<locale>.csv`.
2. Resolve `handle → resourceId` per resource type — products via
   `productByIdentifier`, collections via `collectionByIdentifier`, metaobjects via
   `metaobjectByHandle`, metafields via the product's metafield of that
   `namespace.key`.
3. Read digests for every resolved resource.
4. Diff: compare each incoming value against the translation already registered,
   so an unedited re-run reports `unchanged` — the same property `planEntryImport`
   protects, and for the same reason.
5. Report: *N to register, M unchanged, K with no matching handle.*

Apply registers sequentially, one `translationsRegister` per resource with all its
keys batched into the one call.

**The subtlety worth stating:** digests must be read during *apply*, not carried
over from *plan*. A digest read at plan time and used at apply time is a digest
that may have gone stale in between, and Shopify rejects it. This mirrors what
`app._index` already does when it re-plans against the store on apply rather than
trusting the echoed plan.

### 3. New — `app/lib/collections.server.ts` + `app.collections` page

- `collectionByIdentifier(identifier: { handle: })` — note `collectionByHandle` is
  **deprecated** on 2026-07.
- `collectionCreate(collection: CollectionCreateInput!)` — note the `input:`
  argument is deprecated; the modern argument is `collection:`.
- `collectionUpdate(collection: CollectionUpdateInput!)`.
- Membership: `collectionAddProducts(id:, productIds:)` still works on 2026-07 but
  is deprecated in favour of `collectionUpdate` with `inclusion.selectionsToAdd` —
  **which does not exist on 2026-07** (`CollectionInclusionInput` is not in this
  schema). So on the pinned version the deprecated mutation is the pragmatic path;
  the alternative is `CollectionInput.products`, valid only on create.

This is worth a comment in the file, because it is exactly the kind of thing that
looks like an oversight to the next reader.

### 4. Extend the metaobject entries importer

`planEntryImport` currently takes the target type from the UI dropdown. Add support
for an optional `type` column so one file can carry several metaobject types
(shades *and* claims) in one import. When the column is absent, behaviour is
unchanged.

### 5. `shopify.app.toml` — scopes

Add `write_translations`, and `write_locales` if the app enables locales itself.
Both re-prompt merchants for consent on next load, exactly as the note on the
inventory and `write_files` scopes already records.

`read_products` / `write_products` already cover collections.

---

## Order of work

1. Django: fix `configured_languages()`. Nothing else is safe to run until this is
   done.
2. Django: `MEDIA_BASE_URL`, tags, metafield columns in the products CSV. These
   three need no new consumer code — this app already reads all of them.
3. Shopify: `translations.server.ts` + `app.translations-import`. The largest and
   most valuable piece.
4. Django: `ShopifyTranslationExporter`.
5. Shopify: `collections.server.ts` + `app.collections`.
6. Django: `ShopifyCollectionExporter`.
7. Django: generalise the metaobject exporter; Shopify: `type` column.
8. Django: dashboard index page.
9. `npm run typecheck` && `npm run lint` on this side; the Oscar side has 45 tests
   in `dashboard/tests.py` that run without a database and should be extended
   alongside each exporter.

Steps 3 and 5 are independent of 4 and 6 — the API side can be built and tested
against hand-written CSVs before the Django side emits them.

---

## Open items to confirm

- **Which locales does the main site actually carry?** `project/locale/` has `bg`,
  `el`, `ro`, and the catalogue migrations show `title_en` / `title_el`. The
  multisite settings are per-country with their own databases, so a full migration
  may be *four* Shopify stores rather than one store with four locales. This
  changes the shape of phase 4 completely and is the first thing to settle.
- **One store or several?** Related to the above. `bg` and `ro` are separate Django
  databases with separate catalogues, not translations of the GR catalogue.
- **Shade handle collisions across sites.** `configured_shade_handle_suffix()`
  defaults to `WAGTAIL_SITE_NAME` (`radiant`), which is why the acceptance file in
  `PLAN-metaobject-image-import.md` shows `04-true-beige-radiant`. If several sites
  import into one store, the suffix has to differ per site or the entries collide.
- **Metaobject and metafield translation resource types.** Products and collections
  are confirmed translatable. `METAOBJECT` and `METAFIELD` need one real
  `translatableResources` call against the dev store to confirm which keys they
  expose before the exporter commits to a key naming scheme.
- **Claims.** Referenced in this repo's git history and in the acceptance file, but
  I have not yet read the Oscar-side model. Needs a look before item 7.
- **Catalogue size.** Decides whether phase 3 can use the existing 1000-row cap or
  needs chunking, and whether phase 4 fits inside nginx's 300-second window.
