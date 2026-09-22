# Plan — export products and variant metafields with the fields the user picks

> **Built.** `app/components/FieldPicker.tsx`, `app/lib/product-export-csv.ts`,
> `app/routes/app.export-products.tsx`, `getAllProductsForExport` in
> `product-write.server.ts`, `selectedColumns` in
> `variant-metafield-csv.server.ts`, and the panels on both pages.
>
> Two things the plan did not foresee:
>
> * **Reference metafields had to be resolved to handles.** A stored
>   `metaobject_reference` is a gid, and `metaobjectRefsIn` splits a cell on the
>   first `:` — so a gid exported verbatim reads as the type `["gid` and fails,
>   taking the whole cell with it. The route now resolves gids to handles in one
>   pass (`collectReferenceGids` + `resolveMetaobjectIds`/`resolveProductIds`),
>   the way the variant export already did. The round-trip check caught this;
>   nothing else would have.
> * **No test runner exists in this repo**, so step 6 was run as a standalone
>   harness against the real modules rather than committed as a test. Adding
>   vitest was out of scope for the ask.
>
> **Picker revised.** The first version was one flat column of every checkbox,
> which is what a forty-field catalogue is worst served by. Now: presets, a
> search that scopes "add all matches", groups collapsed behind counts, and the
> selection shown back as removable chips in column order. The reasoning, and
> the patterns each part comes from, are in `app/components/FieldPicker.tsx`.

Two asks, one shared picker:

1. **Update products** gains a way to export products, with the user choosing
   which fields become columns.
2. **Variant metafields** already exports, but always exports *every*
   definition. The user picks which ones.

Both are possible. Ask 2 is small — the export exists and works off a target
list that just needs filtering. Ask 1 is a real feature, but the hard half is
already built.

---

## Why ask 1 is cheaper than it looks

The import side already owns the exact field catalogue an export needs, and the
exact column spellings.

| Piece | Where | What it gives the export |
| --- | --- | --- |
| `STATIC_FIELDS` | `product-import-columns.ts:168` | Every non-metafield target: identity, product, variant, inventory, media, options |
| `metafieldTargets(defs, owner)` | `product-import-columns.ts:296` | The store's own metafields as targets |
| `FieldTarget.label` | same | `Variant Price`, `Claims (product.metafields.custom.claims)` — Shopify's own column spelling |
| `ExistingProduct` / `ExistingVariant` | `product-write.server.ts:93,116` | Every value those targets name, already shaped |
| `productSelection(productRefs, variantRefs)` | `product-write.server.ts:223` | The GraphQL selection that fills them |

The consequence worth designing around: **if the export writes `target.label` as
its heading, the file re-imports through Update products with no mapping step.**
`resolveHeaders` auto-matches on exactly those strings. Export → edit in a
spreadsheet → Update products becomes a closed loop, which is the whole point of
putting the button on that page.

### The one missing piece

There is no "read all products" fetcher. The three that exist are all keyed:
`getProductsForUpdate` (by handle, `:355`), `getProductsForUpdateByTitle`
(`:422`), `getProductsForUpdateBySku` (`:516`). They share `productSelection`
and `toExistingProduct`, so a pager is a thin addition rather than a new query.

---

## Ask 1 — product export

### 1. `getAllProductsForExport` — `app/lib/product-write.server.ts`

```
getAllProductsForExport(admin, {
  productRefs, variantRefs,   // MetafieldRef[], from the chosen metafield targets
  query,                      // optional Shopify search filter, e.g. "status:active"
}): AsyncGenerator<ExistingProduct>
```

`products(first: N, after: $cursor, query: $query)` with the existing
`productSelection(productRefs, variantRefs)` body, each node through the
existing `toExistingProduct`. Yields rather than accumulates so a large
catalogue is not held in memory twice.

**Page size is the risk.** The selection grows with every chosen metafield, and
a query cost limit is what broke the variant export before (see the comment at
`app.export-variant-metafields.tsx:34`). Start at 25 and derive it from the
number of selected metafield refs rather than fixing it.

### 2. `app/lib/product-export-csv.ts` — new, pure

```
productExportColumns(targets): string[]            // target.label, in catalogue order
productExportRows(targets, product): string[][]    // one row per variant
```

No Admin API import, so it unit-tests with hand-built `ExistingProduct`
objects — the arrangement `variant-metafield-csv.server.ts` already uses.

**Row shape:** one row per variant; product-level columns filled only on the
product's first row. That is Shopify's own convention and what the importer's
`groupRows` reads back, so the loop closes.

Per-scope cell rules, from `FieldTarget.scope`:

- `identity` / `product` — first row only
- `variant` — every row
- `inventory` — `quantities.get(locationId)`; needs a chosen location
- `option` — `selectedOptions[optionIndex]`
- `media` — see the caveat below
- metafield — `product.metafields.get("ns.key")` or the variant's

### 3. `app/routes/app.export-products.tsx` — new resource route

No component, loader returns the Response — same arrangement as the three
existing export routes. Reads:

- `fields` — comma-separated `FieldTarget.field` ids
- `query` — optional Shopify product filter
- `location` — inventory location gid, when an inventory field is selected

Then: load definitions → build the full target list → keep the ones named in
`fields` → derive `productRefs`/`variantRefs` from the metafield targets among
them → page → stream. BOM + `Content-Disposition` exactly as the others do.

### 4. The picker, on `app.product-update.tsx`

A collapsible **Export products** panel above the file input, with checkboxes
grouped by scope: Identity, Product, Variant, Inventory, Media, Options,
Product metafields, Variant metafields. Select-all per group. A text box for the
optional Shopify filter, and a location select that appears only when an
inventory field is ticked (`listLocations` already exists, `:615`).

Download through `downloadCsv` (`app/lib/download-csv.ts:40`), the same helper
the variant page uses, so failures surface as text instead of a broken file.

**`identity.handle` is forced on and not unticked.** It is the importer's match
key; a file without it cannot be read back, and silently producing one from the
page whose job is importing would be a trap.

---

## Ask 2 — variant metafields, filtered

Far smaller. The export already reduces everything to a `targets` array:

```
metafieldColumns(definitions, includeProduct)   // variant-metafield-csv.server.ts:77
```

Everything downstream — `variantMetafieldsToCsv`, `expandedColumns`,
`collectReferenceIds`, `variantDefinitionsToCsv` — already works off that array.

**Change:** accept `fields` (comma-separated `definition.column`, product ones
prefixed as `productColumnName` already spells them) on
`app.export-variant-metafields.tsx`, and filter `targets` right after
`metafieldColumns`. Nothing else in that file moves.

**UI:** on `app.variant-metafields.tsx:374-396`, replace the single
`withProduct` toggle with the same grouped checkbox component as ask 1 — two
groups, the store's variant definitions and its product definitions. `refs` and
`expand` stay as they are.

Side benefit: unselected product metafields are no longer read, and reading a
product metafield costs a lookup per product (`app.export-variant-metafields.tsx:72`).
The picker makes the export cheaper, not just narrower.

---

## Shared

Both pages want the same thing: grouped checkboxes over labelled items with
select-all. One `app/components/FieldPicker.tsx`, driven by
`{ group, items: { id, label, checked }[] }`, used twice.

---

## Caveats to settle before building

- **Media.** `ExistingProduct.images` is product-level and a row carries one
  `Image Src`. Shopify's export emits extra image-only rows. Simplest first cut:
  first image on the first row, and say so in the panel. Extra rows can follow
  once the rest is proven.
- **Inventory needs a location.** One column per location is how Shopify does
  it; one chosen location is simpler and matches what the importer writes
  (`setInventoryQuantities`, `:1109`). Recommend the single select.
- **Price/market columns are out of scope**, as they are on import
  (`IGNORED_PREFIXES`, `product-import-columns.ts:~225`). Keep them out of the
  picker rather than exporting columns the importer then refuses.
- **Catalogue size.** 4,955 rows in the last Shopify export of this store. The
  generator handles memory; the open question is the Admin API cost ceiling, so
  the page size needs to be measured against a real store before this ships.

---

## Order of work

1. `FieldPicker` component.
2. Ask 2 end to end — smallest, proves the picker and the `fields` param shape.
3. `getAllProductsForExport` + its page-size measurement.
4. `product-export-csv.ts` with unit tests.
5. `app.export-products.tsx` + the panel on Update products.
6. Round-trip test: export with every field ticked, re-import unchanged through
   Update products, assert the plan reports no changes. That single test is what
   proves the loop is closed.
