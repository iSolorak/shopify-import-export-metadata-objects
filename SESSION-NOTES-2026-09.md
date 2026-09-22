# Export/import work, September 2026 — the spotlights

Companion to `MIGRATION-STATE.md`. That file says **what the system is**; this
one says **what we changed, what we got wrong on the way, and the traps that
cost the most time**. Read it before debugging an import that "should work".

---

## The shape of the work

Three sibling Django repos, one Shopify app, one store.

| Repo | Catalogue | Country-code env var |
| --- | --- | --- |
| `/home/solorak/radiant-new` | radiant | `DJANGO_OSCAR_RADIANT_COUNTRY_CODE` |
| `/home/solorak/monreve` | monreve | `DJANGO_OSCAR_MONREVE_COUNTRY_CODE` |
| `/home/solorak/Documents/projects/seventeen` | seventeen | `DJANGO_OSCAR_SEVENTEEN_COUNTRY_CODE` |

`project/shopify_export/` is near-identical in all three — copied, not shared.
Every change below was written once and ported twice, by exact-match patch with
an abort on any anchor that did not match exactly once.

Running their tests (no `manage.py test` — it dies on an unrelated model
resolution error):

```
cd <repo> && ./virtualenv/bin/python <runner>.py <repo> <ENV_VAR>
```

…where the runner boots Django with `project.multisite.intl.settings` and
unittest-loads the `SimpleTestCase` subclasses in
`shopify_export.dashboard.tests`, skipping the DB-bound ones.

**141 tests in each.** 2–3 fail everywhere on `VendorTests` /
`test_excludes_unpublished_and_includes_zero_stock_items` — `configured_vendor()`
returns the site's real name where the test overrode `OSCAR_SHOP_NAME`. They are
**pre-existing and environmental**: confirmed by A/B, reverting every change and
getting the identical failures, and on monreve they come and go between runs on
the same code. Do not chase them as a regression.

---

## What shipped

1. **Claims linked to products** — `custom.claim`, `list.metaobject_reference`,
   restricted to the `claim` metaobject definition. Both halves ride in the
   `product-metafields` export. The app's metafield-definition CSV importer
   gained a `metaobject_type` column so the restriction survives the CSV route;
   without it the definition is created unrestricted and then rejects every bare
   handle at import time.
2. **Option columns match Shopify's own export** — `Option1 Name` and
   `Option1 Linked To` on the product's first row only. Verified byte-identical
   against a real store export of `lip-mousse`, 41 rows.
3. **Tools stopped exporting as the cosmetic they apply** —
   `SHOPIFY_TOOL_CATEGORIES` wins over the deepest-category rule, plus a title
   fallback and an exclusion for things sold *for* tools.
4. **Category metafields gated on having a category** —
   `_carries_category_metafields()`.
5. **Recommended products exported and imported** — the Oscar upsell block into
   `shopify--discovery--product_recommendation.related_products`, plus
   `resolveProductHandles()` on the app side.
6. **Translation builder: folded handle matching, and never writing a value
   identical to the source.**

Details and measurements for each are in `MIGRATION-STATE.md`.

---

## The traps, in the order they bit

### A metaobject/product reference that does not resolve fails the whole row

Not the cell — the row. This is why every reference export takes the
**intersection** with what the same export writes, rather than emitting the
catalogue's full list and hoping. One unexported claim would cost a product all
its badges.

### "The colour exists" is three different claims

When an import says a handle is invalid, separate these before theorising:

1. the **definition** exists (the metaobject type, or the metafield);
2. the **entries** exist (the individual records);
3. this **specific handle** exists.

A whole round of debugging went into (3) when the answer was (2) — and then a
later round assumed (2) again when the entries were present all along.

### A file exported *after* a failed import proves nothing about it

The single most expensive mistake here. A live entries export taken at 11:53
was used to argue about an import run at 10:36. Always compare timestamps
before concluding the store's state.

### Export format ≠ import requirement

Shopify's own product export writes `Option1 Linked To` on the first row only.
That it *exports* that way is not proof the importer accepts it. It does — but
that was verified by watching a real product import, not assumed.

### Owner subtype

`shopify.color-pattern` and its siblings are scoped to a product **category**.
On an uncategorised product Shopify rejects **every row of the product**, naming
no column: `Owner subtype does not match the metafield definition's
constraints`. 14 products, and the predicate matched the failures exactly —
of 46 carrying the metafield, the 14 with no category failed and the 32 with one
imported.

### A variant is not a product

It has no handle and cannot be the target of a product reference. A
recommendation naming a shade must resolve to its parent. 46 of radiant's 346
recommendations are shade-level; dropping them lost real links to products that
were in the export all along, under another handle.

### Restart the app

Two separate rounds of "it still fails" were a running instance serving a build
from before the edit. The tell: an error Shopify could only produce from input
the current source cannot generate.

### `-2` on a shade handle is not a duplicate

335 of them, and **zero** share a colour with their base. Shade labels collide
across products (a dozen "No.01"s), so `_unique_handle()` disambiguates. Compare
the `color` column before "cleaning up" any of them.

---

## Two corrections worth remembering

Both were stated confidently and were wrong.

- **"seventeen has 312 duplicate colour entries needing a cleanup pass."** No.
  They are distinct shades, correctly disambiguated. The check that settles it
  is comparing hex values, which was not done before asserting it.
- **"121 tests pass in each."** They did not; radiant and seventeen were already
  failing 3 and 2. The runner's summary line was read too quickly.

The habit that caught both: when a number looks like evidence, re-derive it from
the data rather than from a previous summary — including one's own.

---

## How things were verified, since there is no JS test runner

`package.json` still has no `test` script. The app side was checked with
`typecheck` + `lint` + **ad-hoc esbuild harnesses** run against the user's real
files and deleted afterwards:

```
./node_modules/.bin/esbuild ./harness.mts --bundle --platform=node \
  --format=esm --outfile=<scratch>/h.mjs --external:@shopify/* && node <scratch>/h.mjs
```

That is how the product-reference conversion, the handle folding and the
identical-value skip were all confirmed — including the before/after numbers
(translations matched 72 → 110; filled rows 144 → 220).

The Django side was verified the same way it always is: unit tests, plus the
export run against all three live databases with the result cross-checked
against the file's own handles.

---

## Still open

- `related_products_display` — the settings metafield beside `related_products`.
- The `VendorTests` failures above.
- `studio-3-step-manicure-system` (seventeen) exports 294 media, over Shopify's
  250 limit; Shopify rejects the whole product.
- The translation builder's **title fallback is inert** unless the source's
  title column is literally named `title`. Nica Beauty's is `Titlu [en]`.
- 38 Romanian `handle` translations were written to the store before the fix.
  `/home/solorak/Downloads/ro-handles-to-clear.csv` blanks them — needs the
  overwrite checkbox ticked, or Shopify skips instead of clearing.
