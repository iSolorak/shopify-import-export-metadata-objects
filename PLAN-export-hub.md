# Plan — one dashboard URL for every export

Replace the scattered export endpoints with a single page where the user picks
what to export, sets whatever options that export takes, and downloads the file.

---

## What exists today

Twenty-four import/export endpoints, mounted four different ways.

### 1. `shopify_export.dashboard` — `/dashboard/shopify-export/`

| URL | Produces |
| --- | --- |
| `products/` | ZIP: products + inventory per locale, videos |
| `shade-metaobjects/` | `shopify--color-pattern-entries.csv` |
| `claim-metaobjects/` | `claim-entries.csv` |
| `product-metaobjects/` | ZIP: definitions + 5 per-field entries CSVs |
| `metaobject-definitions/` | `shopify-metaobject-definitions.csv` |

### 2. `import_export.dashboard` — `/dashboard/import-export/`

Five exports (`export_competition`, `export_jewellery_attributes`,
`export_sku_xlsx`, `export_tolstoy_csv`, `export_stores`) and five imports
(`import_products_erp`, `import_product_attributes_xlsx`,
`import_description_el`, `import_stores`, `upload_stocks`).

### 3. Ad-hoc in `project/core/urls.py`

Seven exports and one import wired straight into the root URLconf, most
registered twice (with and without a trailing slash):
`export_all_public_products`, `export_product_textfields`,
`export_all_products_title_upc_claims`, `export_parent_child_claims_relationships`,
`export_product_prices`, `export_upc_title`, `no_upc_products_xlsx`,
`import_parent_child_claims_relationships`.

### 4. `dashboard_csv_import` — `/dashboard/erp/erp_import/`

### And a hub that already half-exists

`/dashboard/dev/` (`dashboard_dev_index`) renders a link list by walking
`get_resolver().reverse_dict` and keeping paths containing "import" or "export".

It is worth knowing why that approach is being replaced rather than extended:
**the root resolver's `reverse_dict` does not contain namespaced URLs**, so the
page silently misses everything in groups 1, 2 and 4 — all five Shopify exports
included. It lists 8 of 24. A link list also cannot carry the query parameters
several exports need, so even the ones it finds are only reachable in their
default configuration.

---

## The design

One URL, one view, one registry. **No export logic moves.** Every existing view
function is reused exactly as it is; the registry only describes them.

### The registry — `project/shopify_export/exports.py` (new module, see note)

```python
@dataclass(frozen=True)
class ExportOption:
    key: str                      # "shopify-products", used in the form
    label: str                    # "Export products for Shopify"
    group: str                    # "Shopify migration"
    description: str              # one sentence, shown under the label
    view: Callable                # the existing view, called unchanged
    params: tuple[Param, ...] = ()
```

and a `Param` describing one form field — `name`, `label`, `kind`
(`text` / `choice` / `checkbox`), `choices`, `default`, `help`.

A declarative registry rather than a `dict[str, callable]` because the
parameters are the point: `products/` alone takes an inventory location and a
`link_options` toggle, and today the only way to discover either is to read
`exporters.py`.

### The view

```
GET  /dashboard/exports/            → the page: every option, grouped
POST /dashboard/exports/            → run the chosen export, return its file
```

The POST handler resolves `key` to an `ExportOption`, rebuilds a `GET`-style
`QueryDict` from the submitted params, assigns it to `request.GET`, and calls
`option.view(request)`. The existing views all read their options from
`request.GET`, so they need no change at all — this is the seam that makes the
whole plan cheap.

POST rather than GET-with-querystring so the option form is a real form, and so
a long parameter list does not have to be hand-assembled into a URL.

### The template — `project/templates/dashboard/exports/index.html`

Sections per `group`, each option a card with its label, description, its
parameter fields, and a download button. Extends the Oscar dashboard layout the
other dashboard pages use.

Groups, in the order a migration actually needs them:

1. **Shopify — schema** — metaobject definitions
2. **Shopify — data** — products ZIP, shades, claims, product metaobjects
3. **Catalogue** — public products, product text fields, prices, UPC/title
4. **Operations** — stores, competition, SKU, Tolstoy, jewellery attributes

That ordering is itself documentation: the Shopify import fails in confusing
ways when run out of order, and a page that lists definitions above data makes
the order obvious without a paragraph explaining it.

### Parameters to expose

| Export | Params |
| --- | --- |
| `shopify-products` | `location` (text, default "Shop location"), `link_options` (checkbox, default on) |
| `shopify-product-metaobjects` | `lang` (choice from `configured_languages()`), `include_empty` (checkbox, default off) |
| `shopify-shade-metaobjects` | `lang` |
| `shopify-claim-metaobjects` | `lang` |
| everything else | none today |

---

## Where the module lives

`shopify_export` is the wrong home for a registry that lists `export_stores` and
`export_tolstoy_csv` — that app is about Shopify. Two options:

**(a) A new `project/exports/` app.** Correct, and the registry is then owned by
nobody in particular, which is what it is. Costs an entry in `INSTALLED_APPS`.

**(b) Put it in `import_export`,** which already owns half the endpoints and is
already mounted as a dashboard app.

**(b) is the recommendation** — it needs no new app, the dashboard config and
permissions already exist, and the URL becomes
`/dashboard/import-export/exports/` with no root URLconf change. The one cost is
that the module imports from `shopify_export`, so `import_export` starts
depending on it; that is a one-way dependency and an acceptable one.

If a plain `/dashboard/exports/` is wanted instead, it is a single `path()` in
`core/urls.py` pointing at the same view.

---

## Backwards compatibility

Every existing URL **keeps working**, unchanged, in the first pass. They are
bookmarked, some are referenced from other dashboard templates, and there is no
benefit to breaking them on the same day the hub arrives.

What changes:

- `/dashboard/dev/` is repointed at the new page — it is the crude version of
  exactly this, and leaving two hubs invites the wrong one being used.
- The duplicate no-trailing-slash routes in `core/urls.py` (eight of them) can
  go whenever; `APPEND_SLASH` already handles that case.

A later pass can collapse the old routes to redirects once the hub has been
used in anger. Doing it now would mean changing URLs and introducing a new page
in one step, and if anything breaks it would not be obvious which half did it.

---

## Imports are out of scope for this pass

Nine of the twenty-four endpoints are imports. They need file upload, their own
validation and their own result reporting — `import_products_erp` and
`catalogue_import_stocks` each have a form class already. Folding those into the
same page would make it a different, much larger job, and the export half is
what was asked for.

The registry is shaped so an `ImportOption` can sit beside `ExportOption` later
without rework.

---

## Files touched

| File | Change |
| --- | --- |
| `project/import_export/exports.py` | **new** — `ExportOption`, `Param`, the registry |
| `project/import_export/dashboard/views.py` | **new view** — `exports_index` (GET + POST) |
| `project/import_export/dashboard/apps.py` | one `url()` for `exports/` |
| `project/templates/dashboard/exports/index.html` | **new** |
| `project/dashboard/views.py` | `dashboard_dev_index` → redirect to the hub |
| `project/import_export/dashboard/tests.py` | **new** — see below |

No export function is modified. `shopify_export/exporters.py` is untouched.

---

## Tests

`shopify_export` has 63 tests that run without a database; the same style
applies here.

- Every `ExportOption.view` is callable and every `key` is unique.
- Every option in the registry is reachable: POST with its key returns a
  response, with the view patched out.
- Params round-trip: posting `location=Warehouse` reaches the view as
  `request.GET["location"]`.
- An unknown key is a 400, not a 500.
- The registry covers every export currently reachable from the root URLconf —
  the test that stops an endpoint being quietly dropped in the move.

---

## Order of work

1. `exports.py` — the dataclasses and the registry, Shopify group first.
2. The view and the template; verify against the Shopify exports end to end.
3. Add the catalogue and operations groups.
4. Repoint `/dashboard/dev/`.
5. Tests.
6. *Optional, later:* collapse the old routes to redirects.

---

## Open questions

- **Is `export_product_textfields` still used?** It is mounted under
  `/dashboard/catalogue/`, unlike its siblings, which suggests it was added
  separately. Worth confirming before it earns a card.
- **`no_upc_products_xlsx` and `export_upc_title`** look like one-off diagnostics
  rather than exports a merchant runs. They may belong in a "Reports" group, or
  not on the page at all.
- **Permissions.** Everything currently sits behind `is_staff` via
  `OscarDashboardConfig.default_permissions`. If any export should be narrower
  than that, the registry is where a `permission` field would go — but nothing
  today suggests it is needed.
- **Locale.** The hub lives under the language prefix like every other dashboard
  URL, and `?lang=` selects the *content* language of an export. Those are two
  different things and the page copy has to be careful not to imply otherwise.
