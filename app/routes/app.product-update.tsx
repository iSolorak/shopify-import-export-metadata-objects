import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import {
  FieldPicker,
  allIds,
  initialSelection,
  type PickerGroup,
  type PickerItem,
  type PickerPreset,
} from "../components/FieldPicker";
import { parseCsv, rowsToRecords } from "../lib/csv";
import { downloadCsv } from "../lib/download-csv";
import {
  STATIC_FIELDS,
  metafieldTargets,
  resolveHeaders,
  type FieldTarget,
} from "../lib/product-import-columns";
import {
  groupRows,
  planProductUpdate,
  type ImportPlan,
  type PlanContext,
  type ProductRow,
} from "../lib/product-import-csv";
import {
  deleteMetafields,
  findCategories,
  getProductsForUpdate,
  getProductsForUpdateBySku,
  getProductsForUpdateByTitle,
  listLocations,
  metaobjectRefsIn,
  productRefsIn,
  resolveMetaobjectHandles,
  resolveProductHandles,
  setInventoryQuantities,
  setMetafields,
  toMetafieldValue,
  updateProductFields,
  updateVariants,
  METAOBJECT_TYPES,
  PRODUCT_REFERENCE_TYPES,
  type ExistingProduct,
  type MetafieldDelete,
  type MetafieldRef,
  type MetafieldWrite,
  type ShopLocation,
} from "../lib/product-write.server";
import { listMetafieldDefinitions } from "../lib/product-metafields.server";
import { listDefinitions } from "../lib/metaobjects.server";
import { Guide } from "../components/ui/Guide";
import {
  Actions,
  CsvDropZone,
  Disclosure,
  readForm,
  useSubmitFeedback,
  Steps,
  TableScroll,
} from "../components/ui/ImportFlow";

// Update products from a CSV without deleting and recreating them.
//
// Shopify's own "overwrite products with the same handle" import replaces the
// product, which discards everything attached to its id: metafields, videos,
// translations, collection memberships. This page changes only the fields the
// file actually names, on the product that is already there.
//
// Three steps:
//
//   no `map:` fields, no `intent`  → read the file, report its columns
//   `map:` fields present          → plan, and show the diff
//   `intent=apply`                 → re-plan against the store, then write
//
// All three post the same form, and every submit is made **programmatically**
// from the button's click handler — `fetcher.submit(new FormData(form))` with
// the intent appended — rather than by letting `s-button type="submit"` fire a
// native submit.
//
// That is the fix for the bug this page shipped with. `s-button` is a custom
// element, so its "submit" is its own click handler calling `requestSubmit()`,
// not a browser default action deferred until after the event has propagated.
// A React `onClick` on the host runs from the delegated root listener, i.e.
// after that — so the old "write the intent into a hidden field on click"
// trick serialised the *previous* click's intent. `Review changes` happened to
// want the empty string it already had, but `Update N products` posted a stale
// `""` and merely re-planned; only a second click ever wrote anything.
// `app.translations.tsx` documents the same race as its reason for not
// mutating an intent field from a click handler. Submitting explicitly removes
// the ordering question altogether instead of betting on it.
//
// The file is re-posted on every step rather than echoed back through a hidden
// field. A product export runs to megabytes and round-tripping it through the
// browser twice is pure waste when the file input is still sitting in the form.
//
// The last two steps are also **windowed**. A whole catalogue cannot be planned
// or written inside one 300-second request, so each of those steps posts the
// same form once per `BATCH_PRODUCTS` products, with `offset` naming where to
// start, and the page stitches the answers together as they arrive. That is
// what replaced the old 200-product ceiling, which made a 243-product export
// into three hand-split files. Nothing else about the step changed: the same
// plan is built from the same rows against the same store, one window at a
// time, and the server holds no state between windows.

const MAPPING_PREFIX = "map:";
const LOCATION_FIELD = "locationId";

/**
 * Which window of the file a request is for.
 *
 * Set on the `FormData` at the moment of submitting rather than kept in a
 * hidden input, for the same reason `intent` is: a value a click handler writes
 * into the DOM is a value the next submit might read stale.
 */
const OFFSET_FIELD = "offset";

/**
 * The one switch that reverses this page's central safety rule.
 *
 * Off, a blank cell is skipped and a half-filled spreadsheet cannot erase
 * anything — the property the whole feature is built around. On, a blank cell
 * in a clearable column means "erase what is there", which is what a merchant
 * ending a sale across the catalogue actually wants: export, delete the
 * Compare At Price column's contents, re-import.
 *
 * It is deliberately one checkbox rather than a per-column choice. The mapping
 * table already decides *which* columns are in play — switching a column off
 * there removes it from the run entirely, blanks included — so a per-column
 * clear flag would be a second, overlapping way to say the same thing. The
 * review step shows every clear as a real `value → —` diff before anything is
 * written, which is where the per-case judgement belongs.
 */
const CLEAR_EMPTY_FIELD = "clearEmpty";

/**
 * Products handled by one request.
 *
 * Each one costs up to four Admin API calls and
 * `deploy/nginx/shopify-app.conf` gives the request 300 seconds, so a whole
 * catalogue cannot be planned or written in a single POST. It is cut into
 * windows of this size instead: the page posts the same form once per window,
 * with `offset` naming where to start, and stitches the answers back together.
 * See `postWindow` in the component for the client half.
 *
 * Fifty is chosen to leave the slowest plausible window — fifty products that
 * each need four writes — a wide margin inside those 300 seconds. It is not a
 * limit anyone has to think about: the file size limit below is what a person
 * sees, and it is the whole file, not one request's worth.
 */
const BATCH_PRODUCTS = 50;

/**
 * Products one file may cover.
 *
 * Far above the old 200 — which is what made a 243-product export into three
 * hand-split files — because a run is no longer one request. This is now only a
 * sanity bound on how long a windowed run may take in total; the file is
 * re-posted per window, so it is also what keeps that traffic finite.
 */
const MAX_PRODUCTS = 2000;

/** Rows read from the file, before grouping. A per-variant export is long. */
const MAX_ROWS = 20000;

type ColumnReport = {
  columns: string[];
  autoMatched: string[];
  ignored: { column: string; reason: string }[];
  unrecognised: string[];
  mapping: Record<string, string>;
  targets: { field: string; label: string; group: string }[];
  locations: ShopLocation[];
  locationId: string;
  /** Echoed back so the checkbox survives the round trip between steps. */
  clearEmpty: boolean;
};

/**
 * Where a windowed answer sits in the file it came from.
 *
 * `nextOffset` is the only thing the client needs to decide whether to ask
 * again, and it is `null` on the last window — the server owns the arithmetic
 * so the page cannot walk off the end of the file by miscounting.
 */
type BatchInfo = {
  /** First product of this window, counting from 0. */
  offset: number;
  /** Products covered by the window. */
  count: number;
  /** Products in the whole file. */
  total: number;
  /** Where the next request should start, or `null` when this was the last. */
  nextOffset: number | null;
};

type ActionData =
  | ({ step: "inspect" } & ColumnReport)
  | ({ step: "plan"; plan: ImportPlan; batch: BatchInfo } & ColumnReport)
  | {
      step: "applied";
      updated: number;
      failures: string[];
      batch: BatchInfo;
    }
  | { step: "error"; message: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  // For the export picker. The same catalogue the mapping dropdown is built
  // from, which is the whole point: a column this page can export is a column
  // it can read back, with no mapping step in between.
  const [targets, locations] = await Promise.all([
    buildTargets(admin),
    listLocations(admin),
  ]);

  return {
    exportFields: targets.map((target) => ({
      field: target.field,
      label: target.label,
      group: groupOf(target),
      scope: target.scope,
    })),
    locations,
  };
};

type Admin = Parameters<typeof getProductsForUpdate>[0];

/** Which dropdown group a target belongs to, for the mapping UI. */
function groupOf(target: FieldTarget): string {
  if (target.metafield) {
    return target.metafield.owner === "PRODUCT"
      ? "Product metafield"
      : "Variant metafield";
  }
  switch (target.scope) {
    case "identity":
      return "Match on";
    case "product":
      return "Product";
    case "variant":
      return "Variant";
    case "inventory":
      return "Inventory";
    case "media":
      return "Images";
    case "option":
      return "Variant options (read only)";
  }
}

function readMapping(formData: FormData): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith(MAPPING_PREFIX)) continue;
    mapping[key.slice(MAPPING_PREFIX.length)] = String(value);
  }
  return mapping;
}

/** Every field a file could be pointed at, including this store's metafields. */
async function buildTargets(admin: Admin): Promise<FieldTarget[]> {
  const [productDefs, variantDefs] = await Promise.all([
    listMetafieldDefinitions(admin, "PRODUCT"),
    listMetafieldDefinitions(admin, "PRODUCTVARIANT"),
  ]);

  return [
    ...STATIC_FIELDS,
    ...metafieldTargets(productDefs, "PRODUCT"),
    ...metafieldTargets(variantDefs, "PRODUCTVARIANT"),
  ];
}

/**
 * Turn CSV text into a plan.
 *
 * Shared by the plan and apply steps so that "apply" re-derives everything from
 * the store as it is now rather than trusting what the browser echoes back —
 * the same reasoning as the other import pages, with the extra weight that a
 * stale plan here would write prices computed against a catalogue that has
 * since moved.
 *
 * Plans one window of `BATCH_PRODUCTS` products starting at `offset`. The file
 * is parsed and grouped in full every time — it has to be, since only the whole
 * file says which product a variant row belongs to — but everything after the
 * grouping, the store reads included, is done for the window alone. That is
 * what bounds a request's work no matter how long the file is.
 */
async function buildPlan(
  admin: Admin,
  csv: string,
  mapping: Record<string, string>,
  locationId: string,
  targets: FieldTarget[],
  clearEmpty: boolean,
  offset: number,
): Promise<
  | {
      ok: true;
      plan: ImportPlan;
      batch: BatchInfo;
      resolved: ReturnType<typeof resolveHeaders>;
      columns: string[];
    }
  | { ok: false; message: string }
> {
  const rows = parseCsv(csv);
  if (rows.length < 2) {
    return {
      ok: false,
      message: "That file has a header row but no data rows.",
    };
  }
  if (rows.length - 1 > MAX_ROWS) {
    return {
      ok: false,
      message: `That file has ${rows.length - 1} rows. Split it into files of at most ${MAX_ROWS}.`,
    };
  }

  const columns = rows[0].map((header) => header.trim());
  const resolved = resolveHeaders(columns, targets, mapping);

  const mapsTo = (field: string) =>
    [...resolved.byColumn.values()].some((target) => target.field === field);

  // Handle, Title or Variant SKU — in that order of preference, matching what
  // `groupRows` picks. SKU counts because it identifies a variant, and the
  // product is whatever that variant belongs to.
  if (
    !mapsTo("identity.handle") &&
    !mapsTo("identity.title") &&
    !mapsTo("variant.sku")
  ) {
    return {
      ok: false,
      message:
        "No column is matching products yet. Point one at Handle, Title or Variant SKU so each row can find the product it updates.",
    };
  }

  const records = rowsToRecords(rows);
  const grouped = groupRows(records, resolved.byColumn, clearEmpty);

  if (grouped.rows.length > MAX_PRODUCTS) {
    return {
      ok: false,
      message: `That file covers ${grouped.rows.length} products. Update at most ${MAX_PRODUCTS} at a time.`,
    };
  }

  // --- The window ---------------------------------------------------------
  const total = grouped.rows.length;
  const start = Math.max(0, Math.min(offset, total));
  const windowRows = grouped.rows.slice(start, start + BATCH_PRODUCTS);
  const batch: BatchInfo = {
    offset: start,
    count: windowRows.length,
    total,
    nextOffset:
      start + windowRows.length < total ? start + windowRows.length : null,
  };

  // --- Read the store -----------------------------------------------------
  const productRefs: MetafieldRef[] = [];
  const variantRefs: MetafieldRef[] = [];
  for (const target of resolved.byColumn.values()) {
    if (!target.metafield) continue;
    const ref = {
      namespace: target.metafield.namespace,
      key: target.metafield.key,
    };
    if (target.metafield.owner === "PRODUCT") productRefs.push(ref);
    else variantRefs.push(ref);
  }

  let products = new Map<string, ExistingProduct>();
  let ambiguous = new Set<string>();

  // `groupRows` has already decided which of the three identifies a row, and
  // recorded it on every row. Reading it back from there rather than
  // re-deriving it is what keeps the lookup and the grouping from disagreeing
  // about what `row.key` holds.
  const matchedBy = grouped.rows[0]?.matchedBy ?? "handle";

  if (matchedBy === "handle") {
    products = await getProductsForUpdate(
      admin,
      windowRows.map((row) => row.handle),
      productRefs,
      variantRefs,
    );
  } else if (matchedBy === "title") {
    const found = await getProductsForUpdateByTitle(
      admin,
      windowRows.map((row) => row.title),
      productRefs,
      variantRefs,
    );
    products = found.products;
    ambiguous = found.ambiguous;
  } else {
    // `row.key` is the lowercased SKU, which is how the lookup keys its map.
    const found = await getProductsForUpdateBySku(
      admin,
      windowRows.map((row) => row.key),
      productRefs,
      variantRefs,
    );
    products = found.products;
    ambiguous = found.ambiguous;
  }

  // --- Resolve the names that need ids ------------------------------------
  // Metaobject definition gid → type, so a reference column restricted to one
  // definition can resolve the bare handles Shopify's export writes. Only
  // fetched when the file actually maps such a column.
  const metaobjectTypes = await metaobjectTypesById(admin, resolved);
  const defaultTypeFor = (target: FieldTarget): string | undefined =>
    target.metafield?.metaobjectDefinitionId
      ? metaobjectTypes.get(target.metafield.metaobjectDefinitionId)
      : undefined;

  const metaobjects = await resolveMetaobjectRefs(
    admin,
    windowRows,
    resolved,
    defaultTypeFor,
  );
  const categories = await resolveCategories(admin, windowRows);
  const referencedProducts = await resolveProductRefs(
    admin,
    windowRows,
    resolved,
  );

  const context: PlanContext = {
    products,
    ambiguous,
    locationId: locationId || null,
    metaobjects,
    categories,
    toMetafieldValue: (target, cell, ctx) =>
      toMetafieldValue(
        target.metafield!.type,
        cell,
        ctx.metaobjects,
        defaultTypeFor(target),
        referencedProducts,
      ),
  };

  return {
    ok: true,
    plan: planProductUpdate(
      windowRows,
      resolved.byColumn,
      context,
      // File-level problems are found by grouping the whole file, so every
      // window would otherwise report the same ones and the review step would
      // list each of them once per window. They belong to the file, so they
      // are carried by the window that starts it.
      start === 0 ? grouped.errors : [],
    ),
    batch,
    resolved,
    columns,
  };
}

/**
 * Resolve every metaobject handle the file mentions, in one pass.
 *
 * Gathered up front rather than looked up inside the planner, which is pure by
 * design and cannot await anything.
 */
async function resolveMetaobjectRefs(
  admin: Admin,
  rows: ProductRow[],
  resolved: ReturnType<typeof resolveHeaders>,
  defaultTypeFor: (target: FieldTarget) => string | undefined,
): Promise<Map<string, string>> {
  // Keyed by field so a cell can be parsed with the same default type the
  // planner will use for it — otherwise a bare handle would be gathered here
  // and looked up under a different key than the one the converter asks for.
  const metaobjectFields = new Map<string, FieldTarget>();
  for (const target of resolved.byColumn.values()) {
    if (target.metafield && METAOBJECT_TYPES.includes(target.metafield.type)) {
      metaobjectFields.set(target.field, target);
    }
  }
  if (!metaobjectFields.size) return new Map();

  const refs: { type: string; handle: string }[] = [];
  const collect = (values: Map<string, string>) => {
    for (const [field, value] of values) {
      const target = metaobjectFields.get(field);
      if (target) refs.push(...metaobjectRefsIn(value, defaultTypeFor(target)));
    }
  };

  for (const row of rows) {
    collect(row.values);
    for (const variant of row.variants) collect(variant.values);
  }

  return refs.length ? resolveMetaobjectHandles(admin, refs) : new Map();
}

/**
 * Resolve every product handle the file's reference columns mention.
 *
 * Same reason as the metaobject pass: gathered up front because the planner is
 * pure and cannot await. `related_products` is the column that needs it — a
 * recommendation names another product by handle, and the API wants its gid.
 *
 * These are handles of products the file points *at*, not the ones it updates,
 * so they are looked up separately from `getProductsForUpdate`.
 */
async function resolveProductRefs(
  admin: Admin,
  rows: ProductRow[],
  resolved: ReturnType<typeof resolveHeaders>,
): Promise<Map<string, string>> {
  const fields = new Set<string>();
  for (const target of resolved.byColumn.values()) {
    if (
      target.metafield &&
      PRODUCT_REFERENCE_TYPES.includes(target.metafield.type)
    ) {
      fields.add(target.field);
    }
  }
  if (!fields.size) return new Map();

  const handles: string[] = [];
  const collect = (values: Map<string, string>) => {
    for (const [field, value] of values) {
      if (fields.has(field)) handles.push(...productRefsIn(value));
    }
  };

  for (const row of rows) {
    collect(row.values);
    for (const variant of row.variants) collect(variant.values);
  }

  return handles.length ? resolveProductHandles(admin, handles) : new Map();
}

/**
 * Metaobject definition gid → its type, for the reference columns in this file.
 *
 * Skipped entirely when nothing maps to a metaobject reference, which is the
 * common case; the definition list is a paged query and not worth running for
 * a price sheet.
 */
async function metaobjectTypesById(
  admin: Admin,
  resolved: ReturnType<typeof resolveHeaders>,
): Promise<Map<string, string>> {
  const needed = [...resolved.byColumn.values()].some(
    (target) => target.metafield?.metaobjectDefinitionId,
  );
  if (!needed) return new Map();

  const definitions = await listDefinitions(admin);
  return new Map(
    definitions.map((definition) => [definition.id, definition.type]),
  );
}

/** Resolve the distinct category names the file uses to taxonomy ids. */
async function resolveCategories(
  admin: Admin,
  rows: ProductRow[],
): Promise<Map<string, string>> {
  const names = rows
    .map((row) => row.values.get("product.category"))
    .filter((name): name is string => Boolean(name));

  return names.length ? findCategories(admin, names) : new Map();
}

/** The mapping the UI should show: what the user chose, or what was detected. */
function effectiveMapping(
  resolved: ReturnType<typeof resolveHeaders>,
  userMapping: Record<string, string>,
): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const [column, target] of resolved.byColumn) {
    mapping[column] = target.field;
  }
  // A column the user explicitly switched off stays off, even though it is
  // absent from `byColumn` and would otherwise fall back to auto-detection.
  for (const [column, field] of Object.entries(userMapping)) {
    if (!field) mapping[column] = "";
  }
  return mapping;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  try {
    const formData = await request.formData();
    const intent = String(formData.get("intent") ?? "");

    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { step: "error", message: "Choose a CSV file first." } as const;
    }
    const csv = await file.text();

    const [targets, locations] = await Promise.all([
      buildTargets(admin),
      listLocations(admin),
    ]);

    const userMapping = readMapping(formData);
    const locationId =
      String(formData.get(LOCATION_FIELD) ?? "") || locations[0]?.id || "";
    // An unchecked checkbox posts nothing at all, so presence is the answer.
    const clearEmpty = formData.get(CLEAR_EMPTY_FIELD) !== null;
    // Which window of the file this request is for. Absent on the first one,
    // and never trusted beyond being a non-negative number — `buildPlan` clamps
    // it to the file it just grouped.
    const offset = Math.max(0, Number(formData.get(OFFSET_FIELD) ?? 0) || 0);

    const report = (
      resolved: ReturnType<typeof resolveHeaders>,
      columns: string[],
    ): ColumnReport => ({
      columns,
      autoMatched: resolved.autoMatched,
      ignored: resolved.ignored,
      unrecognised: resolved.unrecognised,
      mapping: effectiveMapping(resolved, userMapping),
      targets: targets.map((target) => ({
        field: target.field,
        label: target.label,
        group: groupOf(target),
      })),
      locations,
      locationId,
      clearEmpty,
    });

    // --- Step 1: read the file and report what its columns mean -------------
    if (!intent && Object.keys(userMapping).length === 0) {
      const rows = parseCsv(csv);
      if (rows.length < 2) {
        return {
          step: "error",
          message: "That file has a header row but no data rows.",
        } as const;
      }

      const columns = rows[0].map((header) => header.trim());
      const resolved = resolveHeaders(columns, targets);

      return { step: "inspect", ...report(resolved, columns) } as const;
    }

    // --- Step 2: plan -------------------------------------------------------
    const built = await buildPlan(
      admin,
      csv,
      userMapping,
      locationId,
      targets,
      clearEmpty,
      offset,
    );
    if (!built.ok) return { step: "error", message: built.message } as const;

    if (intent !== "apply") {
      return {
        step: "plan",
        plan: built.plan,
        batch: built.batch,
        ...report(built.resolved, built.columns),
      } as const;
    }

    // --- Step 3: write ------------------------------------------------------
    const failures: string[] = [];
    let updated = 0;

    // Sequential, the house style for the leaky bucket. The order within a
    // product matters too: a variant's inventory item must have been updated
    // before its quantity is set, or turning tracking on and setting a
    // quantity in the same run would fail on the second call.
    for (const product of built.plan.products) {
      // A SKU-keyed file has no handle or title to name a row by, so the key
      // stands in — without it every failure would read ": <message>".
      const label =
        product.handle ||
        product.title ||
        (product.matchedBy === "sku" ? `SKU ${product.key}` : product.key);

      for (const error of product.errors) {
        failures.push(`${label}: ${error}`);
      }

      if (product.action !== "update" || !product.productId) continue;
      let wrote = false;

      try {
        if (
          Object.keys(product.productInput).length > 0 ||
          product.media.length > 0
        ) {
          const result = await updateProductFields(
            admin,
            product.productId,
            product.productInput,
            product.media,
          );
          if (result.ok) wrote = true;
          else failures.push(`${label}: ${result.errors.join("; ")}`);
        }

        if (product.variants.length) {
          const result = await updateVariants(
            admin,
            product.productId,
            product.variants.map((variant) => variant.input),
          );
          if (result.ok) wrote = true;
          else failures.push(`${label}: ${result.errors.join("; ")}`);
        }

        const quantities = product.variants
          .map((variant) => variant.inventory)
          .filter((entry): entry is NonNullable<typeof entry> =>
            Boolean(entry),
          );

        if (quantities.length && locationId) {
          const result = await setInventoryQuantities(
            admin,
            locationId,
            quantities,
          );
          if (result.ok) wrote = true;
          else
            failures.push(`${label} (inventory): ${result.errors.join("; ")}`);
        }

        // Values and removals travel in the same plan but through different
        // mutations: a cleared metafield is deleted, because no typed metafield
        // accepts the empty string as a value.
        const writes: MetafieldWrite[] = [];
        const removals: MetafieldDelete[] = [];
        for (const entry of product.metafields) {
          if (entry.remove) {
            removals.push({
              ownerId: entry.ownerId,
              namespace: entry.namespace,
              key: entry.key,
            });
          } else {
            writes.push({
              ownerId: entry.ownerId,
              namespace: entry.namespace,
              key: entry.key,
              type: entry.type,
              value: entry.value,
            });
          }
        }

        if (writes.length) {
          const result = await setMetafields(admin, writes);
          if (result.ok) wrote = true;
          else
            failures.push(`${label} (metafields): ${result.errors.join("; ")}`);
        }

        if (removals.length) {
          const result = await deleteMetafields(admin, removals);
          if (result.ok) wrote = true;
          else {
            failures.push(
              `${label} (cleared metafields): ${result.errors.join("; ")}`,
            );
          }
        }

        if (wrote) updated++;
      } catch (error) {
        failures.push(
          `${label}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { step: "applied", updated, failures, batch: built.batch } as const;
  } catch (error) {
    return {
      step: "error",
      message: error instanceof Error ? error.message : String(error),
    } as const;
  }
};

/** A windowed run in progress, and what has come back from it so far. */
type Run = {
  /** "" for the review pass, "apply" for the writing one. */
  intent: "" | "apply";
  /** The window currently in flight. */
  offset: number;
  /** Products answered for so far. */
  done: number;
  /** Products in the file, once the first answer has said. */
  total: number;
};

/** The review pass, stitched back together from its windows. */
type PlanTotals = ImportPlan & { planned: number; total: number };

/** The writing pass, likewise. */
type ApplyTotals = {
  updated: number;
  failures: string[];
  done: number;
  total: number;
};

/**
 * Products kept from the review pass.
 *
 * The table shows a hundred; a little more is held so the count under it is
 * honest about there being more, without carrying a two-thousand-product diff
 * around in the browser. The counts and `writeCount` are summed over every
 * window regardless, so the summary and the button always speak for the whole
 * file.
 */
const PLAN_ROWS_KEPT = 200;

/** Failures kept from a writing run. The list on screen shows a hundred. */
const FAILURES_KEPT = 500;

/** Fold one window's plan into what the earlier windows already said. */
function mergePlan(
  prev: PlanTotals | null,
  plan: ImportPlan,
  batch: BatchInfo,
): PlanTotals {
  // Offset 0 is a fresh run, not a continuation — pressing "Review changes"
  // again after editing the mapping must not add to the previous answer.
  const base = batch.offset === 0 ? null : prev;
  return {
    products: [...(base?.products ?? []), ...plan.products].slice(
      0,
      PLAN_ROWS_KEPT,
    ),
    counts: {
      update: (base?.counts.update ?? 0) + plan.counts.update,
      unchanged: (base?.counts.unchanged ?? 0) + plan.counts.unchanged,
      error: (base?.counts.error ?? 0) + plan.counts.error,
    },
    writeCount: (base?.writeCount ?? 0) + plan.writeCount,
    errors: [...(base?.errors ?? []), ...plan.errors],
    planned: batch.offset + batch.count,
    total: batch.total,
  };
}

/** The same, for the writing pass. */
function mergeApplied(
  prev: ApplyTotals | null,
  answer: { updated: number; failures: string[]; batch: BatchInfo },
): ApplyTotals {
  const base = answer.batch.offset === 0 ? null : prev;
  return {
    updated: (base?.updated ?? 0) + answer.updated,
    failures: [...(base?.failures ?? []), ...answer.failures].slice(
      0,
      FAILURES_KEPT,
    ),
    done: answer.batch.offset + answer.batch.count,
    total: answer.batch.total,
  };
}

export default function ProductUpdatePage() {
  const { exportFields, locations } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const data = fetcher.data;

  // A run is a sequence of requests, so "busy" cannot just be the fetcher's
  // state: between two windows it is idle for a moment, and a button that
  // un-greys there invites a second run over the top of the first.
  const [run, setRun] = useState<Run | null>(null);
  const [planTotals, setPlanTotals] = useState<PlanTotals | null>(null);
  const [applyTotals, setApplyTotals] = useState<ApplyTotals | null>(null);
  const busy = fetcher.state !== "idle" || run !== null;

  // Held in state rather than read off the latest answer, because the mapping
  // controls it renders are part of the form every window is read from. Taking
  // it from `fetcher.data` unmounted the whole section the moment an "applied"
  // answer arrived — so the second window of a writing run would have posted no
  // mapping, no location and no "clear fields left empty", and the server would
  // have re-guessed all three half way through the file.
  const [report, setReport] = useState<ColumnReport | null>(null);

  // Four beats here rather than the usual three: this page reads the file's
  // columns and lets you correct the guesses before anything is planned.
  const step: number = applyTotals ? 4 : planTotals ? 3 : report ? 2 : 1;

  // Anything that stops a submit, said out loud. This page's failure mode used
  // to be silence: a click that validated wrong, or a request that came back
  // empty, left the screen exactly as it was and the button looking dead.
  const [submitError, setSubmitError] = useSubmitFeedback(
    fetcher.state,
    fetcher.data,
  );

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [exportLocation, setExportLocation] = useState(locations[0]?.id ?? "");

  // The picker's groups are the mapping dropdown's groups, in the same order,
  // because they are built from the same targets by the same `groupOf`.
  const exportGroups: PickerGroup[] = useMemo(() => {
    const groups = new Map<string, PickerItem[]>();
    for (const target of exportFields) {
      const items = groups.get(target.group) ?? [];
      items.push({
        id: target.field,
        label: target.label,
        // Handle is how a row finds its product on the way back in. A file
        // without it matches nothing, and producing one from the page whose
        // job is importing would be a trap.
        ...(target.field === "identity.handle"
          ? {
              locked: true,
              details: "Always exported — rows are matched on it.",
            }
          : {}),
      });
      groups.set(target.group, items);
    }
    return [...groups.entries()].map(([name, items]) => ({ name, items }));
  }, [exportFields]);

  // The answers people actually come here with. Each is a starting point
  // rather than a mode: every one is a normal selection afterwards, and a
  // preset naming a field this store does not have simply drops it.
  const exportPresets: PickerPreset[] = useMemo(() => {
    const metafields = exportFields
      .filter((target) => target.field.startsWith("metafield."))
      .map((target) => target.field);

    return [
      {
        name: "Essentials",
        ids: ["identity.title", "variant.sku", "variant.price"],
      },
      {
        name: "Pricing",
        ids: [
          "identity.title",
          "variant.sku",
          "variant.price",
          "variant.compareAtPrice",
          "variant.cost",
        ],
      },
      {
        name: "Inventory",
        ids: [
          "identity.title",
          "variant.sku",
          "variant.barcode",
          "inventory.available",
          "variant.tracked",
          "variant.inventoryPolicy",
        ],
      },
      {
        name: "Content & SEO",
        ids: [
          "identity.title",
          "product.descriptionHtml",
          "product.vendor",
          "product.productType",
          "product.tags",
          "product.seoTitle",
          "product.seoDescription",
        ],
      },
      { name: "Metafields", ids: ["identity.title", ...metafields] },
      { name: "Everything", ids: allIds(exportGroups) },
    ];
  }, [exportFields, exportGroups]);

  // Opens on Essentials rather than on nothing: a picker whose answer is
  // already reasonable is quicker to correct than one that starts empty.
  const [exportColumns, setExportColumns] = useState<Set<string>>(() =>
    initialSelection(exportGroups, (item) =>
      ["identity.title", "variant.sku", "variant.price"].includes(item.id),
    ),
  );

  const needsLocation = exportColumns.has("inventory.available");

  const runExport = async () => {
    if (exportColumns.size === 0) {
      setExportError("Tick at least one field to export.");
      return;
    }
    setExporting(true);
    setExportError(null);
    try {
      const params = new URLSearchParams({
        fields: [...exportColumns].join(","),
      });
      if (filter.trim()) params.set("query", filter.trim());
      if (needsLocation && exportLocation) {
        params.set("location", exportLocation);
      }
      await downloadCsv(`/app/export-products?${params}`);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(false);
    }
  };

  const plan = planTotals;

  // Both buttons live in the same form — they have to, since the form holds
  // the file and the mapping — and `s-button` accepts no `name`/`value` of its
  // own, so the step cannot ride on the submitter. It is appended here instead,
  // at the moment of submitting, which is the one place it cannot be stale.
  const formRef = useRef<HTMLFormElement>(null);

  /**
   * Post one window of the file.
   *
   * The whole form goes up every time, file included. Round-tripping a
   * multi-megabyte CSV once per window is not free, but it is the only version
   * of this that keeps the server stateless — no half-applied import parked in
   * a session, nothing to expire between two windows, and a run that is
   * abandoned half way leaves nothing behind but the products it already
   * wrote, which re-running the same file brings into line anyway.
   */
  const postWindow = useCallback(
    (intent: "" | "apply", offset: number) => {
      const form = formRef.current;
      if (!form) return false;
      // A programmatic submit skips the constraint validation a native one
      // runs, and the CSV field is `required` — without this, forgetting to
      // choose a file would round-trip to the server just to be told so.
      //
      // `readForm` rather than `reportValidity()` + `new FormData(form)`: the
      // field is an `s-drop-zone`, and neither of those handles a
      // form-associated custom element reliably. See `readForm` in
      // components/ui/ImportFlow.
      const formData = readForm(form);
      if (!formData) {
        setSubmitError("Choose a CSV file first.");
        return false;
      }
      setSubmitError(null);
      if (intent) formData.set("intent", intent);
      if (offset) formData.set(OFFSET_FIELD, String(offset));
      fetcher.submit(formData, {
        method: "post",
        encType: "multipart/form-data",
      });
      return true;
    },
    [fetcher, setSubmitError],
  );

  /** Start a run at the top of the file, discarding what a previous one said. */
  const submitWith = (intent: "" | "apply") => () => {
    setApplyTotals(null);
    if (intent !== "apply") setPlanTotals(null);
    if (!postWindow(intent, 0)) return;
    setRun({ intent, offset: 0, done: 0, total: 0 });
  };

  /**
   * Carry a run on to its next window.
   *
   * Driven from the answer rather than from a timer or a counter on this side:
   * the server says how far it got and where to resume, and this does as it is
   * told until it is told `null`. A window that fails stops the run where it
   * is — the error is on screen, and the products already written stay written.
   */
  const handled = useRef<ActionData | undefined>(undefined);
  useEffect(() => {
    if (fetcher.state !== "idle") return;
    const answer = fetcher.data;
    if (!answer || answer === handled.current) return;
    handled.current = answer;

    if (answer.step === "inspect" || answer.step === "plan") {
      setReport(answer);
    }

    if (answer.step === "plan") {
      setPlanTotals((prev) => mergePlan(prev, answer.plan, answer.batch));
    } else if (answer.step === "applied") {
      setApplyTotals((prev) => mergeApplied(prev, answer));
    }

    const batch =
      answer.step === "plan" || answer.step === "applied" ? answer.batch : null;

    if (!batch || batch.nextOffset === null || !run) {
      setRun(null);
      return;
    }
    setRun({
      intent: run.intent,
      offset: batch.nextOffset,
      done: batch.nextOffset,
      total: batch.total,
    });
    if (!postWindow(run.intent, batch.nextOffset)) setRun(null);
  }, [fetcher.state, fetcher.data, run, postWindow]);

  // Enter in a field still submits natively; treat that as "review", which is
  // the non-destructive step.
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitWith("")();
  };

  // A column is settled when the recogniser already found it a home; the rest
  // are the only ones a person actually has to answer for. `ignored` columns
  // are read and deliberately not written, so they are listed above rather
  // than given a dropdown that would imply a choice exists.
  const ignoredColumns = new Set(
    (report?.ignored ?? []).map((entry) => entry.column),
  );
  const mappableColumns = (report?.columns ?? []).filter(
    (column) => !ignoredColumns.has(column),
  );
  const settled = mappableColumns.filter((column) => report?.mapping[column]);
  const needsAttention = mappableColumns.filter(
    (column) => !report?.mapping[column],
  );

  // Targets grouped for the dropdown, so a forty-column file is browsable.
  const groups = new Map<string, { field: string; label: string }[]>();
  for (const target of report?.targets ?? []) {
    const list = groups.get(target.group) ?? [];
    list.push(target);
    groups.set(target.group, list);
  }

  // One row builder, two tables. Both render real `<s-select name="map:…">`
  // controls, so whichever table a column lands in it posts the same field.
  const mappingTable = (columns: string[]) => (
    <s-table>
      <s-table-header-row>
        <s-table-header>Column in your file</s-table-header>
        <s-table-header>Goes to</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {columns.map((column) => (
          <s-table-row key={column}>
            <s-table-cell>{column}</s-table-cell>
            <s-table-cell>
              <s-select
                name={`${MAPPING_PREFIX}${column}`}
                label=""
                labelAccessibilityVisibility="exclusive"
              >
                {/* The selection lives on the option rather than the select:
                    `s-select` omits `defaultValue`, and a controlled `value`
                    would fight the user's edits between submits. */}
                <s-option
                  value=""
                  {...(report?.mapping[column]
                    ? {}
                    : { defaultSelected: true })}
                >
                  Don&rsquo;t import
                </s-option>
                {[...groups.entries()].map(([group, items]) =>
                  items.map((target) => (
                    <s-option
                      key={target.field}
                      value={target.field}
                      {...(report?.mapping[column] === target.field
                        ? { defaultSelected: true }
                        : {})}
                    >
                      {group} — {target.label}
                    </s-option>
                  )),
                )}
              </s-select>
            </s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );

  return (
    <s-page heading="Update products from CSV">
      <s-section heading="Export products">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Download the products you want to edit, with only the columns you
            want to see, then edit the cells and bring the file back here. The
            headings are Shopify&rsquo;s own, so the file you get{" "}
            <strong>needs no mapping on the way back in</strong> — and
            re-importing one you have not edited plans no changes at all, which
            is the quickest way to check a column means what you think.
          </s-paragraph>

          <s-paragraph>
            One row per variant, with the product&rsquo;s own columns filled on
            its first row only — Shopify&rsquo;s layout, and what this page
            reads natively. <strong>Handle</strong> is always included: it is
            how each row finds its product again.
          </s-paragraph>

          {/* `event.target` rather than `currentTarget`, as the other
              controlled text field in this app does: the change is dispatched
              from the input inside the custom element. */}
          <s-text-field
            label="Only products matching"
            details='Shopify product search, e.g. "status:active", "vendor:Radiant" or "tag:new". Leave blank for the whole catalogue.'
            value={filter}
            onChange={(event: Event) =>
              setFilter((event.target as HTMLInputElement).value)
            }
          />

          <FieldPicker
            groups={exportGroups}
            selected={exportColumns}
            onChange={setExportColumns}
            presets={exportPresets}
          />

          {needsLocation && locations.length > 0 && (
            <s-select
              label="Inventory quantities from"
              details="Shopify exports one column per location; this writes one, because that is what the update step writes back."
              onChange={(event: { currentTarget: { value: string } }) =>
                setExportLocation(event.currentTarget.value)
              }
            >
              {locations.map((location) => (
                <s-option
                  key={location.id}
                  value={location.id}
                  {...(location.id === exportLocation
                    ? { defaultSelected: true }
                    : {})}
                >
                  {location.name}
                </s-option>
              ))}
            </s-select>
          )}

          {exportError && (
            <s-banner tone="critical">
              <s-paragraph>{exportError}</s-paragraph>
            </s-banner>
          )}

          <Actions>
            <s-button
              variant="primary"
              onClick={runExport}
              {...(exporting ? { loading: true, disabled: true } : {})}
            >
              Download {exportColumns.size} column
              {exportColumns.size === 1 ? "" : "s"}
            </s-button>
          </Actions>
        </s-stack>
      </s-section>

      <fetcher.Form
        method="post"
        encType="multipart/form-data"
        ref={formRef}
        onSubmit={onSubmit}
      >
        <s-section heading="Your file">
          <s-stack direction="block" gap="base">
            <Steps
              current={step}
              labels={[
                "Your file",
                "Match the columns",
                "Review changes",
                "Apply",
              ]}
            />

            <Guide
              id="product-update-file"
              title="What this changes, and how rows are matched"
            >
              <s-stack direction="block" gap="small-200">
                <s-paragraph>
                  Updates products that already exist, in place. Shopify&rsquo;s
                  own import with &ldquo;overwrite&rdquo;{" "}
                  <strong>deletes and recreates</strong> each product, which
                  takes its metafields, videos, translations and collection
                  memberships with it. This page never does that: it changes
                  only the fields your file names, on the product that is
                  already there.
                </s-paragraph>

                <s-paragraph>
                  An <strong>empty cell is skipped</strong>, never written as a
                  blank, so a partly-filled spreadsheet cannot erase anything —
                  unless you turn on <strong>Clear fields left empty</strong> in
                  the next step, which reverses that for this run only. A value
                  that already matches is not written at all, so re-running the
                  same file is free and a run that times out is safe to repeat.
                </s-paragraph>

                <s-paragraph>
                  Rows are matched by <strong>Handle</strong>, then{" "}
                  <strong>Title</strong>, then <strong>Variant SKU</strong> —
                  whichever your file has, in that order. A SKU-only file is
                  enough on its own: the product is whatever variant carries
                  that SKU, so a supplier price list of just SKU and price works
                  without pasting handles into it first. A row matching no
                  product is reported as an error — products are never created.
                </s-paragraph>

                <s-paragraph>
                  Within a product, variants are matched by{" "}
                  <s-text>Variant SKU</s-text>, then by their option values.
                  Variants your file does not mention are left untouched, and
                  none are ever created or deleted.
                </s-paragraph>

                <s-paragraph>
                  A whole catalogue can go in one file — up to{" "}
                  {MAX_PRODUCTS.toLocaleString()} products and{" "}
                  {MAX_ROWS.toLocaleString()} rows. Long files are reviewed and
                  written in batches of {BATCH_PRODUCTS}, one after another,
                  with the progress shown as it goes;{" "}
                  <strong>leave this page open</strong> until it finishes. If it
                  stops part way, everything before that point is already
                  written and re-running the same file finishes the rest.
                </s-paragraph>

                <s-paragraph>
                  A Shopify product export needs no setup — its columns are
                  recognised automatically, and so are the everyday spellings a
                  hand-made sheet uses (<s-text>Price</s-text>,{" "}
                  <s-text>SKU</s-text>, <s-text>Quantity</s-text>,{" "}
                  <s-text>Description</s-text>). Anything else can be pointed at
                  a field by hand below, and every guess can be changed or
                  switched off there.
                </s-paragraph>
              </s-stack>
            </Guide>

            {/* Choosing the file runs the first step on its own. Reading a
                file's column names writes nothing, so there is no reason to
                make someone pick a file and then hunt for a button to say
                "yes, really" — and a page that sits still after an upload is
                indistinguishable from a broken one. The button stays for
                re-running it, and for anyone who arrives by keyboard. */}
            <CsvDropZone
              name="file"
              label="CSV file"
              accept=".csv,text/csv"
              onFiles={(files) => {
                if (!files.length) return;
                setSubmitError(null);
                // Only before a report exists: once the mapping controls are on
                // screen they are part of this form, and re-submitting with them
                // would plan the new file against the old file's mapping.
                if (!report) submitWith("")();
              }}
            />

            {submitError && (
              <s-banner tone="critical" heading="That did not go through">
                <s-paragraph>{submitError}</s-paragraph>
              </s-banner>
            )}

            {!report && (
              <Actions>
                <s-button
                  type="button"
                  variant="primary"
                  icon="import"
                  onClick={submitWith("")}
                  {...(busy ? { loading: true } : {})}
                >
                  Read columns
                </s-button>
              </Actions>
            )}
          </s-stack>
        </s-section>

        {report && (
          <s-section heading="Match the columns">
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="small-300">
                <s-badge tone="info">
                  {report.autoMatched.length} recognised
                </s-badge>
                {report.unrecognised.length > 0 && (
                  <s-badge tone="warning">
                    {report.unrecognised.length} unrecognised
                  </s-badge>
                )}
                {report.ignored.length > 0 && (
                  <s-badge tone="neutral">
                    {report.ignored.length} ignored
                  </s-badge>
                )}
              </s-stack>

              {/* The same action as the one at the foot of the section, put
                  where it can be reached without reading the section first.
                  When the recogniser has matched everything there is nothing
                  below this worth scrolling through, and the honest next step
                  is simply "carry on". */}
              <Actions>
                <s-button
                  type="button"
                  variant="primary"
                  icon="import"
                  onClick={submitWith("")}
                  {...(busy ? { loading: true } : {})}
                >
                  Review changes
                </s-button>
              </Actions>

              {needsAttention.length === 0 ? (
                <s-paragraph color="subdued">
                  Every column was recognised, so there is nothing to match by
                  hand. Press <s-text type="strong">Review changes</s-text> to
                  see what the file would do.
                </s-paragraph>
              ) : (
                <s-paragraph color="subdued">
                  {needsAttention.length} column
                  {needsAttention.length === 1 ? " was" : "s were"} not
                  recognised. You can set{" "}
                  {needsAttention.length === 1 ? "it" : "them"} below, or carry
                  on and leave {needsAttention.length === 1 ? "it" : "them"}{" "}
                  out.
                </s-paragraph>
              )}

              {report.ignored.length > 0 && (
                <s-stack direction="block" gap="small-300">
                  <s-paragraph>Read and deliberately not written:</s-paragraph>
                  <s-unordered-list>
                    {report.ignored.slice(0, 20).map((entry) => (
                      <s-list-item key={entry.column}>
                        <s-text>{entry.column}</s-text> — {entry.reason}
                      </s-list-item>
                    ))}
                  </s-unordered-list>
                </s-stack>
              )}

              {/* Placed above the mapping table on purpose: it changes what
                  every row of that table means, so reading it afterwards would
                  be reading it too late. */}
              <s-checkbox
                name={CLEAR_EMPTY_FIELD}
                label="Clear fields left empty"
                details="Off, an empty cell is skipped and nothing is erased. On, an empty cell erases what the product currently holds — for Body, Vendor, Type, Tags, Template Suffix, SEO, Category, Compare At Price, Cost, Barcode, Country of Origin, HS Code and any metafield column. Title, Handle, Status, SKU, Price and Inventory Qty are never cleared, and images are never removed. Every clear is shown in the review step before anything is written."
                {...(report.clearEmpty ? { defaultChecked: true } : {})}
              />

              {report.locations.length > 0 && (
                <s-select
                  name={LOCATION_FIELD}
                  label="Location for inventory quantities"
                  details="Shopify's product CSV has no location column, so every Variant Inventory Qty is set at this location."
                >
                  {report.locations.map((location) => (
                    <s-option
                      key={location.id}
                      value={location.id}
                      {...(report.locationId === location.id
                        ? { defaultSelected: true }
                        : {})}
                    >
                      {location.name}
                    </s-option>
                  ))}
                </s-select>
              )}

              {/* Two tables, not one.

                  A Shopify product export is sixty-odd columns, and this page
                  used to list every one of them above the only button that
                  moves you forward — so continuing meant scrolling past forty
                  dropdowns you had no intention of touching, and it read as if
                  each one wanted a decision.

                  Almost none of them do: the recogniser has already matched
                  them, and the answer is simply "yes". So the ones that need a
                  choice are shown, and the ones already settled are folded
                  away behind a summary. They are still in the form and still
                  submit — see `Disclosure` for why that has to be a
                  `<details>` rather than a conditional render. */}
              {needsAttention.length > 0 && (
                <s-stack direction="block" gap="small-200">
                  <s-heading>Columns that need a decision</s-heading>
                  <s-paragraph color="subdued">
                    These were not recognised. Point each one at a field, or
                    leave it as &ldquo;Don&rsquo;t import&rdquo; — leaving it
                    out changes nothing in the store.
                  </s-paragraph>
                  <TableScroll>{mappingTable(needsAttention)}</TableScroll>
                </s-stack>
              )}

              {settled.length > 0 && (
                <Disclosure
                  summary={`${settled.length} column${settled.length === 1 ? "" : "s"} already matched`}
                >
                  <TableScroll>{mappingTable(settled)}</TableScroll>
                </Disclosure>
              )}

              {/* Repeated at the foot for anyone who did come down here to
                  change something — having to scroll back up to act on an
                  edit you just made is the same complaint in reverse. */}
              <Actions>
                <s-button
                  type="button"
                  variant="primary"
                  icon="import"
                  onClick={submitWith("")}
                  {...(busy ? { loading: true } : {})}
                >
                  Review changes
                </s-button>
              </Actions>
            </s-stack>
          </s-section>
        )}

        {plan && (
          <s-section heading="Review">
            <s-stack direction="block" gap="base">
              <Steps current={3} />

              <s-banner tone="info">
                <s-paragraph>
                  Nothing has been written yet. This is what the file would do —
                  the store changes only when you press the button at the
                  bottom.
                </s-paragraph>
              </s-banner>

              {/* A long file is reviewed a window at a time, and the numbers
                  below grow as the windows land. Saying so is the difference
                  between "still working" and a summary that looks final while
                  it is still half the story. */}
              {run?.intent === "" && (
                <s-banner tone="info">
                  <s-paragraph>
                    Reviewing… {plan.planned} of {plan.total} products so far.
                    The counts below are still growing.
                  </s-paragraph>
                </s-banner>
              )}

              {/* Stopped short — an error window ended the run. The counts
                  describe part of the file, so they are not something to act
                  on, and the button below stays disabled until the review is
                  run again. */}
              {run === null && plan.planned < plan.total && (
                <s-banner tone="warning">
                  <s-paragraph>
                    The review stopped after {plan.planned} of {plan.total}{" "}
                    products, so these counts cover only that much of the file.
                    Press <s-text type="strong">Review changes</s-text> again to
                    start over.
                  </s-paragraph>
                </s-banner>
              )}

              <s-stack direction="inline" gap="small-300">
                <s-badge tone="info">{plan.counts.update} to update</s-badge>
                <s-badge tone="neutral">
                  {plan.counts.unchanged} already up to date
                </s-badge>
                {plan.counts.error > 0 && (
                  <s-badge tone="critical">
                    {plan.counts.error} with errors
                  </s-badge>
                )}
              </s-stack>

              {report?.clearEmpty && (
                <s-banner tone="warning">
                  <s-paragraph>
                    <strong>Clear fields left empty</strong> is on. Every change
                    ending in &ldquo;&mdash;&rdquo; below erases what the
                    product currently holds. Check those before applying.
                  </s-paragraph>
                </s-banner>
              )}

              {plan.errors.length > 0 && (
                <s-banner tone="warning">
                  <s-stack direction="block" gap="small-300">
                    <s-paragraph>Problems with the file itself:</s-paragraph>
                    <s-unordered-list>
                      {plan.errors.slice(0, 20).map((error) => (
                        <s-list-item key={error}>{error}</s-list-item>
                      ))}
                    </s-unordered-list>
                  </s-stack>
                </s-banner>
              )}

              <TableScroll>
                <s-table>
                  <s-table-header-row>
                    <s-table-header>Product</s-table-header>
                    <s-table-header>Action</s-table-header>
                    <s-table-header>Changes</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {plan.products.slice(0, 100).map((product) => (
                      <s-table-row key={product.key}>
                        <s-table-cell>
                          {/* A SKU-keyed file carries neither handle nor
                              title, so the key is the only name the row has
                              until the product is found. */}
                          {product.handle ||
                            product.title ||
                            (product.matchedBy === "sku"
                              ? `SKU ${product.key}`
                              : "—")}
                        </s-table-cell>
                        <s-table-cell>
                          <s-badge
                            tone={
                              product.action === "error"
                                ? "critical"
                                : product.action === "update"
                                  ? "info"
                                  : "neutral"
                            }
                          >
                            {product.action}
                          </s-badge>
                        </s-table-cell>
                        <s-table-cell>
                          <s-stack direction="block" gap="small-500">
                            {product.changes
                              .slice(0, 8)
                              .map((change, index) => (
                                <s-text key={`${change.field}-${index}`}>
                                  {change.label}: {change.from || "—"} →{" "}
                                  {change.to || "—"}
                                </s-text>
                              ))}
                            {product.changes.length > 8 && (
                              <s-text>
                                …and {product.changes.length - 8} more
                              </s-text>
                            )}
                            {product.errors.map((error) => (
                              <s-text key={error} tone="critical">
                                {error}
                              </s-text>
                            ))}
                          </s-stack>
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              </TableScroll>

              {plan.total > 100 && (
                <s-paragraph>
                  Showing the first 100 of {plan.total} products. All of them
                  will be updated.
                </s-paragraph>
              )}

              <Actions>
                {/* Disabled until the review has covered the whole file —
                    while it is still running, and also if it stopped short.
                    A part-reviewed file has a `writeCount` that is only the
                    part of the answer that arrived, and a button offering to
                    update forty products when the file holds four hundred
                    would be lying about what it is about to do. */}
                <s-button
                  type="button"
                  variant="primary"
                  onClick={submitWith("apply")}
                  {...(busy ? { loading: true } : {})}
                  {...(plan.writeCount === 0 ||
                  run !== null ||
                  plan.planned < plan.total
                    ? { disabled: true }
                    : {})}
                >
                  Update {plan.writeCount} product(s)
                </s-button>
              </Actions>
            </s-stack>
          </s-section>
        )}
      </fetcher.Form>

      {data?.step === "error" && (
        <s-section
          heading={
            // A run that fails part way through is not a file that could not
            // be read, and saying so would send someone off to check a file
            // that is fine.
            planTotals || applyTotals
              ? "The run stopped part way"
              : "Could not read that file"
          }
        >
          <s-stack direction="block" gap="base">
            <s-banner tone="critical">
              <s-paragraph>{data.message}</s-paragraph>
            </s-banner>
            {applyTotals && (
              <s-paragraph color="subdued">
                The {applyTotals.done} products before this point were written
                and are unaffected. Running the same file again picks up what is
                left: a value that already matches is never written twice.
              </s-paragraph>
            )}
          </s-stack>
        </s-section>
      )}

      {applyTotals && (
        <s-section
          heading={run?.intent === "apply" ? "Updating…" : "Update finished"}
        >
          <s-stack direction="block" gap="base">
            <Steps current={4} />

            {/* Live while the run is still going: the writing pass is windowed
                too, and a merchant watching a four-hundred-product file needs
                to see it move. Leaving the page here stops the run — what was
                written stays written, and re-running the file finishes it. */}
            {run?.intent === "apply" && (
              <s-banner tone="info">
                <s-paragraph>
                  {applyTotals.done} of {applyTotals.total} products done. Keep
                  this page open until it finishes.
                </s-paragraph>
              </s-banner>
            )}

            <s-banner
              tone={
                run?.intent === "apply"
                  ? "info"
                  : applyTotals.failures.length
                    ? "warning"
                    : "success"
              }
            >
              <s-paragraph>
                {applyTotals.updated} product(s) updated,{" "}
                {applyTotals.failures.length} problem(s). Nothing was deleted or
                recreated — every product kept its metafields, media and
                collections.
              </s-paragraph>
            </s-banner>

            {applyTotals.failures.length > 0 && (
              <s-unordered-list>
                {applyTotals.failures.slice(0, 100).map((failure, index) => (
                  <s-list-item key={`${failure}-${index}`}>
                    {failure}
                  </s-list-item>
                ))}
              </s-unordered-list>
            )}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}
