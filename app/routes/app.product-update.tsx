import { useRef } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher } from "react-router";

import { authenticate } from "../shopify.server";
import { parseCsv, rowsToRecords } from "../lib/csv";
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
  findCategories,
  getProductsForUpdate,
  getProductsForUpdateByTitle,
  listLocations,
  metaobjectRefsIn,
  resolveMetaobjectHandles,
  setInventoryQuantities,
  setMetafields,
  toMetafieldValue,
  updateProductFields,
  updateVariants,
  METAOBJECT_TYPES,
  type ExistingProduct,
  type MetafieldRef,
  type MetafieldWrite,
  type ShopLocation,
} from "../lib/product-write.server";
import { listMetafieldDefinitions } from "../lib/product-metafields.server";
import styles from "./app._index/styles.module.css";

// Update products from a CSV without deleting and recreating them.
//
// Shopify's own "overwrite products with the same handle" import replaces the
// product, which discards everything attached to its id: metafields, videos,
// translations, collection memberships. This page changes only the fields the
// file actually names, on the product that is already there.
//
// Three steps, and which one is running is inferred from the form rather than
// declared — the same trick `app.translations.tsx` uses, and for the same
// reason: mutating a hidden intent field from a click handler loses the race
// against the native submit.
//
//   no `map:` fields, no `intent`  → read the file, report its columns
//   `map:` fields present          → plan, and show the diff
//   `intent=apply`                 → re-plan against the store, then write
//
// The file is re-posted on every step rather than echoed back through a hidden
// field. A product export runs to megabytes and round-tripping it through the
// browser twice is pure waste when the file input is still sitting in the form.

const MAPPING_PREFIX = "map:";
const LOCATION_FIELD = "locationId";

/**
 * Products per run.
 *
 * Each one costs up to four Admin API calls, and
 * `deploy/nginx/shopify-app.conf` gives the request 300 seconds. Because a
 * blank cell is skipped and an unchanged value is not a write, running the same
 * file again after a timeout is free for everything that already landed — which
 * is the documented answer to a catalogue larger than this.
 */
const MAX_PRODUCTS = 200;

/** Rows read from the file, before grouping. A per-variant export is long. */
const MAX_ROWS = 5000;

type ColumnReport = {
  columns: string[];
  autoMatched: string[];
  ignored: { column: string; reason: string }[];
  unrecognised: string[];
  mapping: Record<string, string>;
  targets: { field: string; label: string; group: string }[];
  locations: ShopLocation[];
  locationId: string;
};

type ActionData =
  | ({ step: "inspect" } & ColumnReport)
  | ({ step: "plan"; plan: ImportPlan } & ColumnReport)
  | {
      step: "applied";
      updated: number;
      failures: string[];
    }
  | { step: "error"; message: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
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
 */
async function buildPlan(
  admin: Admin,
  csv: string,
  mapping: Record<string, string>,
  locationId: string,
  targets: FieldTarget[],
): Promise<
  | {
      ok: true;
      plan: ImportPlan;
      resolved: ReturnType<typeof resolveHeaders>;
      columns: string[];
    }
  | { ok: false; message: string }
> {
  const rows = parseCsv(csv);
  if (rows.length < 2) {
    return { ok: false, message: "That file has a header row but no data rows." };
  }
  if (rows.length - 1 > MAX_ROWS) {
    return {
      ok: false,
      message: `That file has ${rows.length - 1} rows. Split it into files of at most ${MAX_ROWS}.`,
    };
  }

  const columns = rows[0].map((header) => header.trim());
  const resolved = resolveHeaders(columns, targets, mapping);

  const identifies = [...resolved.byColumn.values()].some(
    (target) =>
      target.field === "identity.handle" || target.field === "identity.title",
  );
  if (!identifies) {
    return {
      ok: false,
      message:
        "No column is matching products yet. Point one at Handle (or Title) so each row can find the product it updates.",
    };
  }

  const records = rowsToRecords(rows);
  const grouped = groupRows(records, resolved.byColumn);

  if (grouped.rows.length > MAX_PRODUCTS) {
    return {
      ok: false,
      message: `That file covers ${grouped.rows.length} products. Update at most ${MAX_PRODUCTS} at a time.`,
    };
  }

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

  const usesHandle = [...resolved.byColumn.values()].some(
    (target) => target.field === "identity.handle",
  );

  let products = new Map<string, ExistingProduct>();
  let ambiguous = new Set<string>();

  if (usesHandle) {
    products = await getProductsForUpdate(
      admin,
      grouped.rows.map((row) => row.handle),
      productRefs,
      variantRefs,
    );
  } else {
    const found = await getProductsForUpdateByTitle(
      admin,
      grouped.rows.map((row) => row.title),
      productRefs,
      variantRefs,
    );
    products = found.products;
    ambiguous = found.ambiguous;
  }

  // --- Resolve the names that need ids ------------------------------------
  const metaobjects = await resolveMetaobjectRefs(admin, grouped.rows, resolved);
  const categories = await resolveCategories(admin, grouped.rows);

  const context: PlanContext = {
    products,
    ambiguous,
    locationId: locationId || null,
    metaobjects,
    categories,
    toMetafieldValue: (type, cell, ctx) =>
      toMetafieldValue(type, cell, ctx.metaobjects),
  };

  return {
    ok: true,
    plan: planProductUpdate(
      grouped.rows,
      resolved.byColumn,
      context,
      grouped.errors,
    ),
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
): Promise<Map<string, string>> {
  const metaobjectFields = new Set<string>();
  for (const target of resolved.byColumn.values()) {
    if (target.metafield && METAOBJECT_TYPES.includes(target.metafield.type)) {
      metaobjectFields.add(target.field);
    }
  }
  if (!metaobjectFields.size) return new Map();

  const refs: { type: string; handle: string }[] = [];
  for (const row of rows) {
    for (const [field, value] of row.values) {
      if (metaobjectFields.has(field)) refs.push(...metaobjectRefsIn(value));
    }
    for (const variant of row.variants) {
      for (const [field, value] of variant.values) {
        if (metaobjectFields.has(field)) refs.push(...metaobjectRefsIn(value));
      }
    }
  }

  return refs.length ? resolveMetaobjectHandles(admin, refs) : new Map();
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
    const built = await buildPlan(admin, csv, userMapping, locationId, targets);
    if (!built.ok) return { step: "error", message: built.message } as const;

    if (intent !== "apply") {
      return {
        step: "plan",
        plan: built.plan,
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
      for (const error of product.errors) {
        failures.push(`${product.handle || product.title}: ${error}`);
      }

      if (product.action !== "update" || !product.productId) continue;

      const label = product.handle || product.title;
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
          .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

        if (quantities.length && locationId) {
          const result = await setInventoryQuantities(
            admin,
            locationId,
            quantities,
          );
          if (result.ok) wrote = true;
          else failures.push(`${label} (inventory): ${result.errors.join("; ")}`);
        }

        if (product.metafields.length) {
          const writes: MetafieldWrite[] = product.metafields.map((entry) => ({
            ownerId: entry.ownerId,
            namespace: entry.namespace,
            key: entry.key,
            type: entry.type,
            value: entry.value,
          }));
          const result = await setMetafields(admin, writes);
          if (result.ok) wrote = true;
          else failures.push(`${label} (metafields): ${result.errors.join("; ")}`);
        }

        if (wrote) updated++;
      } catch (error) {
        failures.push(
          `${label}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { step: "applied", updated, failures } as const;
  } catch (error) {
    return {
      step: "error",
      message: error instanceof Error ? error.message : String(error),
    } as const;
  }
};

export default function ProductUpdatePage() {
  const fetcher = useFetcher<ActionData>();
  const data = fetcher.data;
  const busy = fetcher.state !== "idle";

  const report =
    data && (data.step === "inspect" || data.step === "plan") ? data : null;
  const plan = data?.step === "plan" ? data.plan : null;

  // Which step a submit means is carried in a hidden field written straight to
  // the DOM on click. Both buttons live in the same form — they have to, since
  // the form holds the file and the mapping — and `s-button` accepts no
  // `name`/`value` of its own. A React state update here would lose the race
  // against the native submit; a ref mutation is synchronous and cannot.
  const intentRef = useRef<HTMLInputElement>(null);
  const setIntent = (value: string) => () => {
    if (intentRef.current) intentRef.current.value = value;
  };

  // Targets grouped for the dropdown, so a forty-column file is browsable.
  const groups = new Map<string, { field: string; label: string }[]>();
  for (const target of report?.targets ?? []) {
    const list = groups.get(target.group) ?? [];
    list.push(target);
    groups.set(target.group, list);
  }

  return (
    <s-page heading="Update products from CSV">
      <fetcher.Form method="post" encType="multipart/form-data">
        <input type="hidden" name="intent" defaultValue="" ref={intentRef} />

        <s-section heading="Your file">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Updates products that already exist, in place. Shopify&rsquo;s own
              import with &ldquo;overwrite&rdquo; <strong>deletes and
              recreates</strong> each product, which takes its metafields,
              videos, translations and collection memberships with it. This page
              never does that: it changes only the fields your file names, on the
              product that is already there.
            </s-paragraph>

            <s-paragraph>
              An <strong>empty cell is skipped</strong>, never written as a
              blank, so a partly-filled spreadsheet cannot erase anything. A
              value that already matches is not written at all, so re-running the
              same file is free and a run that times out is safe to repeat.
            </s-paragraph>

            <s-paragraph>
              Rows are matched by <strong>Handle</strong>, or by{" "}
              <strong>Title</strong> if there is no handle column. A row matching
              no product is reported as an error — products are never created.
              Variants are matched by <s-text>Variant SKU</s-text>, then by their
              option values; variants your file does not mention are left
              untouched, and none are ever created or deleted.
            </s-paragraph>

            <s-paragraph>
              A Shopify product export needs no setup — its columns are
              recognised automatically. Any other CSV can be mapped by hand
              below.
            </s-paragraph>

            <label className={styles.fileField}>
              <span className={styles.fileLabel}>CSV file</span>
              <input
                className={styles.fileInput}
                type="file"
                name="file"
                accept=".csv,text/csv"
                required
              />
            </label>

            {!report && (
              <div className={styles.actions}>
                <s-button type="submit" {...(busy ? { loading: true } : {})}>
                  Read columns
                </s-button>
              </div>
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

              {report.ignored.length > 0 && (
                <s-stack direction="block" gap="small-300">
                  <s-paragraph>
                    Read and deliberately not written:
                  </s-paragraph>
                  <s-unordered-list>
                    {report.ignored.slice(0, 20).map((entry) => (
                      <s-list-item key={entry.column}>
                        <s-text>{entry.column}</s-text> — {entry.reason}
                      </s-list-item>
                    ))}
                  </s-unordered-list>
                </s-stack>
              )}

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

              {/* A wide mapping table would otherwise push the whole embedded
                  page sideways on a narrow screen. */}
              <div className={styles.tableScroll}>
                <s-table>
                  <s-table-header-row>
                    <s-table-header>Column in your file</s-table-header>
                    <s-table-header>Goes to</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {report.columns.map((column) => (
                      <s-table-row key={column}>
                        <s-table-cell>{column}</s-table-cell>
                        <s-table-cell>
                          <s-select
                            name={`${MAPPING_PREFIX}${column}`}
                            label=""
                            labelAccessibilityVisibility="exclusive"
                          >
                            {/* The selection lives on the option rather than
                                the select: `s-select` omits `defaultValue`,
                                and a controlled `value` would fight the
                                user's edits between submits. */}
                            <s-option
                              value=""
                              {...(report.mapping[column]
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
                                  {...(report.mapping[column] === target.field
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
              </div>

              <div className={styles.actions}>
                {/* Resets the intent: without it, reviewing again after an
                    apply would write straight away. */}
                <s-button
                  type="submit"
                  onClick={setIntent("")}
                  {...(busy ? { loading: true } : {})}
                >
                  Review changes
                </s-button>
              </div>
            </s-stack>
          </s-section>
        )}

        {plan && (
          <s-section heading="Review — nothing has been written yet">
            <s-stack direction="block" gap="base">
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

              <div className={styles.tableScroll}>
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
                          {product.handle || product.title || "—"}
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
                            {product.changes.slice(0, 8).map((change, index) => (
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
              </div>

              {plan.products.length > 100 && (
                <s-paragraph>
                  Showing the first 100 of {plan.products.length} products. All
                  of them will be updated.
                </s-paragraph>
              )}

              <div className={styles.actions}>
                <s-button
                  type="submit"
                  variant="primary"
                  onClick={setIntent("apply")}
                  {...(busy ? { loading: true } : {})}
                  {...(plan.writeCount === 0 ? { disabled: true } : {})}
                >
                  Update {plan.writeCount} product(s)
                </s-button>
              </div>
            </s-stack>
          </s-section>
        )}
      </fetcher.Form>

      {data?.step === "error" && (
        <s-section heading="Could not read that file">
          <s-banner tone="critical">
            <s-paragraph>{data.message}</s-paragraph>
          </s-banner>
        </s-section>
      )}

      {data?.step === "applied" && (
        <s-section heading="Update finished">
          <s-stack direction="block" gap="base">
            <s-banner tone={data.failures.length ? "warning" : "success"}>
              <s-paragraph>
                {data.updated} product(s) updated, {data.failures.length}{" "}
                problem(s). Nothing was deleted or recreated — every product kept
                its metafields, media and collections.
              </s-paragraph>
            </s-banner>

            {data.failures.length > 0 && (
              <s-unordered-list>
                {data.failures.slice(0, 100).map((failure, index) => (
                  <s-list-item key={`${failure}-${index}`}>{failure}</s-list-item>
                ))}
              </s-unordered-list>
            )}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}
