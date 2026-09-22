# Plan — Variant metafields section (export + update)

Goal: a new app section, **Variant metafields**, that exports every variant
metafield definition, exports the variants those metafields are set on as a
CSV whose cells are readable (`Peach`, not `gid://…/Metaobject/123`), and
imports that same CSV back to change the values.

Target shape of the value export, from the user's example:

| Handle | Title | Variant SKU | Option1 Name | Option1 Value | custom.color_family |
|---|---|---|---|---|---|
| silk-shirt | Silk Shirt | SS-PCH-S | Color | Peach | Peach |

---

## 1. What already exists, and what is actually missing

Reusable as-is:

- `listMetafieldDefinitions(admin, "PRODUCTVARIANT")` — `app/lib/product-metafields.server.ts:172`.
  Already paginates definitions for either owner and already carries
  `metaobjectDefinitionId` (the `metaobject_definition_id` validation), which is
  what lets a cell hold a bare handle instead of `type:handle`.
- `toMetafieldValue(type, cell, metaobjects, defaultMetaobjectType, products)` —
  `app/lib/product-write.server.ts:882`. Converts a CSV cell to an API value for
  every metafield type this app writes, including metaobject and product refs.
- `metaobjectRefsIn` / `resolveMetaobjectHandles` — same file, `:855` / `:643`.
  Handle → gid resolution in batches of 20.
- `setMetafields` + `METAFIELD_BATCH_SIZE` (25) — `app/lib/product-write.server.ts:1162`.
  `metafieldsSet` is owner-agnostic, so a variant gid works unchanged.
- `getEntries(admin, type)` — `app/lib/metaobjects.server.ts:283`. Returns
  `{ id, handle, displayName }` per entry; this is the source for the
  handle ⇄ display-name mapping.
- `parseCsv` / `toCsv` / `rowsToRecords` (`app/lib/csv.ts`), `downloadCsv`
  (`app/lib/download-csv.ts`), the plan/apply fetcher pattern and
  `app/routes/app._index/styles.module.css`.

Missing:

1. **Any variant-scoped read.** `app.product-update.tsx` can *write* variant
   metafields (`metafieldTargets(variantDefs, "PRODUCTVARIANT")`,
   `app/routes/app.product-update.tsx:196`) but only for variants belonging to
   products a file already names. There is no "give me every variant and its
   metafields" query and no per-variant export anywhere in the app.
2. **Readable metaobject cells.** Every existing export writes the stored API
   value or a handle. Nothing resolves a metaobject reference to its
   `displayName`, and nothing resolves a display name back to a gid on import.
3. **A definitions export.** No page exports metafield *definitions* at all.

So the work is: one new server lib, one new CSV lib, one UI route, one export
resource route, one nav entry.

---

## 2. Files

New:

| File | Purpose |
|---|---|
| `app/lib/variant-metafields.server.ts` | Variant reads (all variants; variants by SKU / by product handle), metaobject display-name index |
| `app/lib/variant-metafield-columns.ts` | Column names, plan types, filename — the client-safe half |
| `app/lib/variant-metafield-csv.server.ts` | `variantMetafieldsToCsv`, `variantDefinitionsToCsv`, `planVariantMetafieldImport` |

The CSV lib is split in two because the planner calls `toMetafieldValue` from
`product-write.server.ts`: a route component importing the column names would
otherwise pull server code into the client bundle, which the build rejects
outright (`Server-only module referenced by client`).
| `app/routes/app.variant-metafields.tsx` | The section: download buttons + upload → review → apply |
| `app/routes/app.export-variant-metafields.tsx` | Resource route serving the CSVs (`?kind=values\|template\|definitions`) |

Changed:

| File | Change |
|---|---|
| `app/routes/app.tsx` | Add `<s-link href="/app/variant-metafields">Variant metafields</s-link>` to `<s-app-nav>` |
| `app/routes/app._index/route.tsx` | Add a card describing the new section, matching the existing cards |

Nothing else is touched. In particular `product-write.server.ts` is imported,
not modified — `setMetafields`, `toMetafieldValue` and `resolveMetaobjectHandles`
are already owner-neutral.

---

## 3. `app/lib/variant-metafields.server.ts`

Same structural `Admin` type and `query()` helper as the sibling server modules
(duplicated deliberately, as those files' headers explain).

### 3.1 Types

```ts
export type VariantMetafields = {
  id: string;                 // variant gid — the write target
  sku: string | null;
  title: string;              // variant title, e.g. "Peach / S"
  selectedOptions: { name: string; value: string }[];
  productId: string;
  productHandle: string;
  productTitle: string;
  /** `namespace.key` → stored API value (gid, JSON list, plain string). */
  values: Record<string, string>;
};
```

### 3.2 Reads

Built on the top-level `productVariants` connection rather than paging products
and then their variants — one cursor instead of two, and the same query serves
both export and import lookup.

```graphql
query VariantMetafieldsPage($cursor: String, $pageSize: Int!, $search: String) {
  productVariants(first: $pageSize, after: $cursor, query: $search) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title sku
      selectedOptions { name value }
      product { id handle title }
      mf0: metafield(namespace: "…", key: "…") { value }
      …
    }
  }
}
```

The `mf{n}` aliases are generated exactly as `metafieldSelections` does in
`product-metafields.server.ts:274` — indexed, because a metafield key may
contain characters a GraphQL alias may not.

- `getAllVariantMetafields(admin, definitions)` — pages with `$search: null`.
- `getVariantMetafieldsBySkus(admin, definitions, skus)` — batches SKUs into
  `sku:"A" OR sku:"B" …` searches (20 per query, escaping `"` and `\` as
  `getProductRichTextByTitles` does), then filters to exact case-sensitive SKU
  matches. Shopify's `sku:` is a prefix match, so the post-filter is mandatory.
- `getVariantMetafieldsByProductHandles(admin, definitions, handles)` — same,
  with `product_handle:"…"`; the fallback path for rows with no SKU.

**Page size 50**, matching `PRODUCT_PAGE_SIZE`: the metafield lookups dominate
query cost and a store with a dozen variant definitions blows the cost budget at
250.

**Cap**: `MAX_VARIANTS = 20000` on the full export, so a catalogue that cannot
finish inside nginx's 300s (`deploy/nginx/shopify-app.conf`) fails with a
sentence instead of a gateway timeout.

### 3.3 Metaobject display-name index

```ts
export type MetaobjectIndex = {
  /** gid → { handle, displayName, type } — for rendering a cell on export. */
  byId: Map<string, { handle: string; displayName: string; type: string }>;
  /** `type:normalisedDisplayName` → gid[] — for resolving a cell on import. */
  byDisplayName: Map<string, string[]>;
};

export async function buildMetaobjectIndex(
  admin: Admin,
  definitions: RichTextDefinition[],
): Promise<MetaobjectIndex>;
```

Only definitions whose `type` is in `METAOBJECT_TYPES` matter. For each distinct
`metaobjectDefinitionId`, the metaobject *type string* is looked up
(`node(id:) { ... on MetaobjectDefinition { type } }`, batched) and then
`getEntries(admin, type)` loads its entries. Display names are normalised with
`trim().toLowerCase()` before keying, and the value is an **array** of gids so
that a duplicate display name is detected rather than silently resolved to
whichever entry came back first.

`mixed_reference` columns have no `metaobjectDefinitionId`, so no index can be
built for them — those cells stay `type:handle` in both directions (see §4.2).

---

## 4. `app/lib/variant-metafield-csv.ts`

### 4.1 Columns

```
handle, title, variant sku, variant title, option1 name, option1 value,
option2 name, option2 value, option3 name, option3 value, <namespace.key>…
```

- `handle` and `title` are the product's, as the user asked for.
- `variant sku` is the primary match key; `handle` + option values is the
  fallback for variants with no SKU.
- Everything left of the metafield columns is **read-only on import** — it
  identifies the row, it is never written. The review step says so, and any
  edit to those columns just changes which variant the row matches (or fails to).
- No `variant id` column. It would be the most robust key but it is also the one
  value a merchant cannot sanity-check in a spreadsheet, and a stale or
  hand-mangled gid writes to the wrong variant silently. SKU + handle/options
  fail loudly instead.

### 4.2 Cell rendering — the readability requirement

Per definition type, on export:

| Type | Cell |
|---|---|
| `metaobject_reference` | display name (`Peach`) when the index resolves it, else the handle |
| `list.metaobject_reference` | the same, joined with `;` |
| `mixed_reference`, `list.mixed_reference` | `type:handle` — no single definition, so no unambiguous display name |
| `product_reference`, `list.product_reference` | product handle(s), `;`-joined (via `productRefsIn`'s format) |
| `list.*` scalars | JSON array decoded and `;`-joined |
| everything else | the stored value verbatim |

On import, a metaobject cell is resolved in this order, which is what makes the
round trip work in both directions:

1. exact handle match against the restricted definition (`metaobjectRefsIn` +
   `resolveMetaobjectHandles`, the existing path);
2. `type:handle` if the cell carries a prefix;
3. **display name**, case-insensitively, against `MetaobjectIndex.byDisplayName`.

Ambiguity is an error, never a guess: if a display name maps to more than one
entry the row reports
`"Peach" matches 2 "colour" entries (peach, peach-2) — use the handle instead.`
A handle that also looks like a display name resolves as a handle first, so a
plain round-trip of Shopify's own export (which emits bare handles) is unchanged.

`toMetafieldValue` is reused for every other type; only the metaobject branch
gets the extra display-name attempt, implemented as a pre-pass in the CSV lib
that rewrites a matched display name to its handle before calling
`toMetafieldValue`. That keeps `product-write.server.ts` untouched.

### 4.3 Definitions CSV (`kind=definitions`)

One row per variant metafield definition:

```
name, namespace, key, column, type, pinned, storefront access, metaobject definition
```

Straight from `listMetafieldDefinitions(admin, "PRODUCTVARIANT")`. `pinned` and
`storefront access` are included because both are invisible failure modes the
existing code already comments on: an unpinned definition accepts writes but
never appears on the variant, and a non-public one is unreadable by the theme.
Read-only — this file is documentation, not an import format.

### 4.4 Planner

```ts
export function planVariantMetafieldImport(
  definitions: RichTextDefinition[],
  records: Record<string, string>[],
  variants: VariantMetafields[],
  index: MetaobjectIndex,
  options: { clearEmpty: boolean },
): VariantMetafieldImportPlan;
```

Per row, mirroring `planRichTextImport` (`app/lib/rich-text-csv.ts:99`):

- match by SKU (trimmed, case-sensitive — SKUs are codes); if the row has no
  SKU, match by product handle + all option values; no match → `error`,
  several matches → `error` naming them.
- for each metafield column: blank cell → `skipped` unless `clearEmpty`, in
  which case it becomes a delete; converted value equal to the stored value →
  `unchanged`; otherwise `update`, recording the write.
- unknown columns are collected and reported, not rejected — a Shopify export
  carries plenty of columns this page ignores.
- counts: `{ update, unchanged, skipped, error }` plus `writeCount`
  and `deleteCount`.

Default is blank = leave alone, as everywhere else in this app. `clearEmpty` is
the same single checkbox as `app.product-update.tsx:CLEAR_EMPTY_FIELD`, with the
same justification: the review step shows every clear as a real `value → —`
diff before anything is written.

---

## 5. `app/routes/app.variant-metafields.tsx`

Loader: `listMetafieldDefinitions(admin, "PRODUCTVARIANT")`. If it is empty the
page renders only an explanation pointing at Settings → Custom data → Variants,
the way `app.rich-text.tsx` handles a store with no rich text definitions.

Three sections:

1. **Definitions** — a table of the variant definitions, and
   `Download definitions CSV` (`downloadCsv("/app/export-variant-metafields?kind=definitions")`).
2. **Export values** — `Download all variants` and `Download template`.
   A radio pair, `Metaobject values as: Display name (Peach) / Handle (peach)`,
   passed through as `&refs=name|handle`. Display name is the default because it
   is the readable form the feature exists for; handle is there for anyone
   round-tripping into another tool.
3. **Update from CSV** — file input → `Review changes` → diff table →
   `Update N variants`, with the `Clear empty cells` checkbox.

Actions, following `app.product-update.tsx`'s three-step form exactly, including
**submitting programmatically** from the click handler
(`fetcher.submit(new FormData(form))` with the intent appended) rather than
relying on `s-button type="submit"` — the ordering bug documented at
`app/routes/app.product-update.tsx:60` applies verbatim here.

- `intent=plan`: parse, cap rows, look up the named variants, build the
  metaobject index, return the plan **and the CSV text** in a hidden field.
- `intent=apply`: re-parse the echoed CSV and **re-plan against the store as it
  is now** before writing — same reasoning as every other import page: the plan
  arrived from the client and the store may have moved.

Writes go through `setMetafields` in batches of `METAFIELD_BATCH_SIZE` (25),
sequentially, because these mutations share a leaky-bucket limit and a parallel
burst gets throttled into errors that look like data errors. Deletes (when
`clearEmpty` is on) go through `deleteMetafields` in the same loop. Each pending
write carries a `Row N (SKU) column` label so a failed batch names the rows.

`MAX_ROWS = 5000` (a per-variant file is long, same as `app.product-update.tsx`)
and `MAX_VARIANTS = 500` written per run.

---

## 6. `app/routes/app.export-variant-metafields.tsx`

Resource route, no component — the arrangement `app.export-rich-text.tsx` uses.
`?kind=values|template|definitions`, `?refs=name|handle`. 404 with a sentence if
the store has no variant metafield definitions. Response is prefixed with
`﻿` so Excel does not mangle accented values, and served
`Content-Type: text/csv; charset=utf-8`, `Cache-Control: no-store`.

Filename: `variant-metafields-{kind}-{YYYY-MM-DD}.csv`.

---

## 7. Scopes

`shopify.app.toml` needs `read_products` / `write_products` (already present for
the product pages) and metaobject read access for the display-name index — also
already present, since the metaobject section reads entries. **Verify before
building**; no scope change is expected.

---

## 8. Order of work

1. `variant-metafields.server.ts` — reads + metaobject index.
2. `variant-metafield-csv.ts` — columns, rendering, planner.
3. `app.export-variant-metafields.tsx` — export first, so the format can be
   eyeballed against a real store before anything writes.
4. `app.variant-metafields.tsx` — definitions table, export UI, plan/apply.
5. Nav link + index card.
6. `npm run typecheck` and `npm run lint`.

Manual check on a dev store: export values → change one `color family` cell from
`Peach` to another entry's display name → review shows exactly that one row as
`update` → apply → confirm in the admin, and confirm a re-export of the
untouched file plans as all-`unchanged`.

---

## 9. Open questions

1. **Match key.** Plan assumes SKU first, product handle + options as fallback.
   If this catalogue has variants without unique SKUs, say so and the fallback
   becomes primary.
2. **Display names are not unique.** Ambiguous ones are errors here rather than
   guesses. The alternative — always exporting handles and adding a read-only
   `<column> (name)` companion column — is unambiguous but doubles the column
   count and makes the file less pleasant to edit, which is the opposite of the
   ask.
3. **Scale.** The all-variants export is unfiltered. If the store is large,
   the next increment is a filter (by product type / collection / definition)
   before the export, not a bigger timeout.

---

## 10. Extension — product metafields and expanded entries (built)

Added after the first pass, on request. Three kinds of metafield column now
appear in the export:

| Column | Owner | Import |
|---|---|---|
| `custom.color_family` | variant | written |
| `product.shopify.color-pattern` | product | written **once per product** |
| `custom.color_family > color` | the referenced entry's own field | read and ignored |

- **Product columns** are prefixed `product.` so the two owners cannot be
  confused. The prefix cannot collide: a metafield key may not contain a dot,
  so a variant column has exactly two dot-separated segments and a prefixed
  product column has three.
- **Writing them once** is the planner's reconciliation pass. A file with forty
  rows for one product repeats its product cells forty times; identical repeats
  collapse to one write, and rows that disagree are **all** reported as errors
  rather than letting the last one win. Rows caught in a conflict write nothing
  at all, variant cells included.
- **Expanded columns** resolve references two levels deep: a
  `shopify--color-pattern` entry's `color` field points at a `shopify--color`
  entry, and that one is named rather than left as a gid. A third level stops.
  They are read-only — changing an entry's own fields is what the metaobject
  import on `/app` does, and it changes the value for every product referencing
  it.
- Both groups are **checkboxes on the export**, defaulting on, carried as
  `&product=0|1&expand=0|1`. The import decides for itself: product columns are
  read only when the file actually carries one, so a plain variant file costs
  no extra queries.
- `buildMetaobjectIndex(admin, targets, { entries: false })` skips loading every
  entry of every referenced type. The export only needs the column set; the
  import needs the entries, because that is what turns `Peach` back into a gid.

---

## 11. Fix — query cost (the "Unexpected Server Error")

Turning on **Include product metafields** failed with a bare 500. Cause: the
Admin API enforces a **1,000-point ceiling on a single query**, checked before
execution, and a connection costs `2 + first × (node cost)`.

The original read nested one connection inside another:

```
products(first: 25) { variants(first: 100) { …, metafield ×D } }
```

which is `25 × (2 + 100 × (2 + D))` ≈ **12,550 points** at three variant
definitions — over the limit before a product metafield was added. Adding the
product columns just made it fail every time rather than most of the time.

Two changes:

1. **Flattened.** Every read now goes through the top-level `productVariants`
   connection: one page costs `2 + first × (3 + D)`. The handle lookup resolves
   handles to product ids first (`products(query: "handle:…")`, two scalars per
   node) and then filters variants by `product_id`, so no query nests a
   connection in a connection. `readProducts` and the nested-variant overflow
   pass are gone with it.
2. **Page sizes are derived, not chosen.** `variantPageSize(D)` and
   `productNodeBatchSize(D)` divide an 800-point budget by the per-node cost, so
   a store that adds its thirtieth definition gets smaller pages rather than a
   broken export. Verified across 0–120 definitions: every shape lands between
   302 and 802 points.

Product metafields are read in a pass of their own (`attachProductMetafields`,
by id) for the same reason — selecting them on the nested `product` node
multiplied their cost by the page size.

Separately, the export route now catches its own errors and returns the real
message as a plain-text 500, which `downloadCsv` surfaces in the page's banner.
The generic "Unexpected Server Error" is what made this cost this much to find.
