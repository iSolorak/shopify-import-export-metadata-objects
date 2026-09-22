import { useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { parseCsv, rowsToRecords } from "../lib/csv";
import { downloadCsv } from "../lib/download-csv";
import { listMetafieldDefinitions } from "../lib/product-metafields.server";
import {
  METAFIELD_BATCH_SIZE,
  deleteMetafields,
  resolveMetaobjectHandles,
  resolveProductHandles,
  setMetafields,
  type MetafieldDelete,
  type MetafieldWrite,
} from "../lib/product-write.server";
import {
  buildMetaobjectIndex,
  getVariantMetafieldsByProductHandles,
  getVariantMetafieldsBySkus,
  type VariantMetafields,
} from "../lib/variant-metafields.server";
import {
  HANDLE_COLUMN,
  SKU_COLUMN,
  type VariantImportPlan,
} from "../lib/variant-metafield-columns";
import {
  collectImportRefs,
  planVariantMetafieldImport,
} from "../lib/variant-metafield-csv.server";
import styles from "./app._index/styles.module.css";

// Export and update the metafields that live on product **variants**.
//
// The rest of this app works a product at a time. A variant metafield does not
// fit that shape: a colour family belongs to the Peach variant, not to the
// shirt, so a per-product row has nowhere to put it. This page is therefore one
// row per variant, and the cells are written the way a person reads them — a
// metaobject reference comes out as `Peach`, not as a gid or a
// `01-peach-radiant` handle — because a file nobody can read is a file nobody
// can edit.
//
// `app.product-update.tsx` can already *write* variant metafields, but only as
// part of a wider product import and only for products a file already names.
// Nothing in the app could read them back out, which made the round trip this
// page exists for impossible.
//
// Two steps, both posting the same form:
//
//   intent=plan   → read the file, report what would change, write nothing
//   intent=apply  → re-plan against the store as it is now, then write
//
// Every submit is made **programmatically** from the button's click handler, as
// `app.product-update.tsx:60` explains at length: `s-button` is a custom
// element whose submit runs before React's delegated click handler, so writing
// an intent into a hidden field on click serialises the *previous* click's
// value. The file is re-posted rather than echoed back through a hidden field —
// a per-variant export runs to megabytes, and the file input is still sitting
// in the form.

/** See `PlanContext.clearEmpty`. Off, a blank cell cannot erase anything. */
const CLEAR_EMPTY_FIELD = "clearEmpty";

/**
 * Rows read from a file. One row per variant, so a modest catalogue is long.
 * Matches `app.product-update.tsx`, which reads the same shape of file.
 */
const MAX_ROWS = 5000;

type ActionData =
  | { step: "plan"; plan: VariantImportPlan; clearEmpty: boolean }
  | {
      step: "applied";
      variants: number;
      written: number;
      cleared: number;
      failures: string[];
    }
  | { step: "error"; message: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  return { definitions: await listMetafieldDefinitions(admin, "PRODUCTVARIANT") };
};

type Admin = Parameters<typeof resolveProductHandles>[0];

/**
 * Turn CSV text into a plan.
 *
 * Shared by both steps so that "apply" re-derives everything from the store as
 * it is now rather than trusting what the browser echoes back — the same
 * reasoning as every other import page here, and the reason the plan is not
 * round-tripped through the client at all.
 */
async function buildPlan(
  admin: Admin,
  definitions: Awaited<ReturnType<typeof listMetafieldDefinitions>>,
  csv: string,
  clearEmpty: boolean,
): Promise<
  { ok: true; plan: VariantImportPlan } | { ok: false; message: string }
> {
  const rows = parseCsv(csv);
  if (rows.length < 2) {
    return { ok: false, message: "That file has a header row but no data rows." };
  }

  const records = rowsToRecords(rows);
  if (records.length > MAX_ROWS) {
    return {
      ok: false,
      message: `That file has ${records.length} rows. Import at most ${MAX_ROWS} at a time.`,
    };
  }

  const headers = Object.keys(records[0] ?? {});
  if (!headers.includes(SKU_COLUMN) && !headers.includes(HANDLE_COLUMN)) {
    return {
      ok: false,
      message: `This file has neither a "${SKU_COLUMN}" nor a "${HANDLE_COLUMN}" column, so its rows cannot be matched to variants. Download the export or the template to see the expected columns.`,
    };
  }

  const index = await buildMetaobjectIndex(admin, definitions);

  // Rows with a SKU are looked up by SKU; the rest fall back to their product's
  // handle plus the option columns, which is what a file for a store that does
  // not use SKUs has to rely on.
  const skus: string[] = [];
  const handles: string[] = [];
  for (const record of records) {
    const sku = (record[SKU_COLUMN] ?? "").trim();
    if (sku) skus.push(sku);
    else if ((record[HANDLE_COLUMN] ?? "").trim()) {
      handles.push((record[HANDLE_COLUMN] ?? "").trim());
    }
  }

  const [bySku, byHandle] = await Promise.all([
    getVariantMetafieldsBySkus(admin, definitions, skus),
    getVariantMetafieldsByProductHandles(admin, definitions, handles),
  ]);

  const variants: VariantMetafields[] = [];
  const seen = new Set<string>();
  for (const variant of [...bySku, ...byHandle]) {
    if (seen.has(variant.id)) continue;
    seen.add(variant.id);
    variants.push(variant);
  }

  // References are resolved in one pass before planning rather than one query
  // at a time inside it. Handles the entry index already knows cost nothing;
  // only the leftovers — a `mixed_reference` column, or a definition this
  // store restricts to nothing — reach the API.
  const refs = collectImportRefs(definitions, records, index);
  const metaobjects = new Map(index.idByHandle);
  const missing = refs.metaobjects.filter(
    (ref) => !metaobjects.has(`${ref.type}:${ref.handle}`),
  );
  if (missing.length) {
    for (const [key, id] of await resolveMetaobjectHandles(admin, missing)) {
      metaobjects.set(key, id);
    }
  }

  const products = refs.productHandles.length
    ? await resolveProductHandles(admin, refs.productHandles)
    : new Map<string, string>();

  return {
    ok: true,
    plan: planVariantMetafieldImport(definitions, records, variants, {
      metaobjects,
      products,
      index,
      clearEmpty,
    }),
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const clearEmpty = formData.get(CLEAR_EMPTY_FIELD) != null;

  try {
    const definitions = await listMetafieldDefinitions(admin, "PRODUCTVARIANT");
    if (definitions.length === 0) {
      return {
        step: "error",
        message:
          "This store has no metafield definitions on variants. Create one in Settings → Custom data → Variants first.",
      } as const;
    }

    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { step: "error", message: "Choose a CSV file first." } as const;
    }

    const result = await buildPlan(admin, definitions, await file.text(), clearEmpty);
    if (!result.ok) {
      return { step: "error", message: result.message } as const;
    }

    if (intent !== "apply") {
      return { step: "plan", plan: result.plan, clearEmpty } as const;
    }

    // --- Write --------------------------------------------------------------
    // Each pending change carries the row it came from, so a failed batch names
    // the rows involved rather than just the batch.
    const writes: { write: MetafieldWrite; label: string }[] = [];
    const removals: { remove: MetafieldDelete; label: string }[] = [];
    const failures: string[] = [];
    let variants = 0;

    for (const row of result.plan.rows) {
      if (row.action === "error") {
        failures.push(`Row ${row.rowNumber}: ${row.message}`);
        continue;
      }
      if (!row.variantId || row.action !== "update") continue;
      variants++;

      for (const write of row.writes) {
        writes.push({
          write: {
            ownerId: row.variantId,
            namespace: write.namespace,
            key: write.key,
            type: write.type,
            value: write.value,
          },
          label: `Row ${row.rowNumber} (${row.label}) ${write.column}`,
        });
      }
      for (const remove of row.deletes) {
        removals.push({
          remove: {
            ownerId: row.variantId,
            namespace: remove.namespace,
            key: remove.key,
          },
          label: `Row ${row.rowNumber} (${row.label}) ${remove.column}`,
        });
      }
    }

    // Batched, then sequential. `metafieldsSet` takes 25 per call and these
    // mutations share a leaky-bucket rate limit — a burst of parallel calls
    // gets throttled into failures that read like data errors.
    let written = 0;
    for (let start = 0; start < writes.length; start += METAFIELD_BATCH_SIZE) {
      const batch = writes.slice(start, start + METAFIELD_BATCH_SIZE);
      const outcome = await setMetafields(
        admin,
        batch.map((item) => item.write),
      );

      if (outcome.ok) {
        written += batch.length;
      } else {
        // The API reports errors against a position in the input array, so the
        // batch is named as a whole rather than mis-attributing them.
        failures.push(
          `${batch[0].label}${batch.length > 1 ? ` and ${batch.length - 1} more` : ""}: ${outcome.errors.join("; ")}`,
        );
      }
    }

    let cleared = 0;
    for (let start = 0; start < removals.length; start += METAFIELD_BATCH_SIZE) {
      const batch = removals.slice(start, start + METAFIELD_BATCH_SIZE);
      const outcome = await deleteMetafields(
        admin,
        batch.map((item) => item.remove),
      );

      if (outcome.ok) {
        cleared += batch.length;
      } else {
        failures.push(
          `${batch[0].label}${batch.length > 1 ? ` and ${batch.length - 1} more` : ""}: ${outcome.errors.join("; ")}`,
        );
      }
    }

    return { step: "applied", variants, written, cleared, failures } as const;
  } catch (error) {
    return {
      step: "error",
      message: error instanceof Error ? error.message : String(error),
    } as const;
  }
};

export default function VariantMetafieldsPage() {
  const { definitions } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const formRef = useRef<HTMLFormElement>(null);

  const [exporting, setExporting] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [refs, setRefs] = useState<"name" | "handle">("name");

  const data = fetcher.data;
  const busy = fetcher.state !== "idle";
  const plan = data?.step === "plan" ? data.plan : null;

  const runExport = async (kind: string) => {
    setExporting(kind);
    setExportError(null);
    try {
      await downloadCsv(
        `/app/export-variant-metafields?kind=${kind}&refs=${refs}`,
      );
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(null);
    }
  };

  const submitWith = (intent: string) => () => {
    const form = formRef.current;
    if (!form) return;
    // A programmatic submit skips the constraint validation a native one runs,
    // and the file input is `required` — without this, forgetting to choose a
    // file would round-trip to the server just to be told so.
    if (!form.reportValidity()) return;

    const formData = new FormData(form);
    formData.set("intent", intent);
    fetcher.submit(formData, {
      method: "post",
      encType: "multipart/form-data",
    });
  };

  // Enter in a field still submits natively; treat that as "review", which is
  // the step that writes nothing.
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitWith("plan")();
  };

  if (definitions.length === 0) {
    return (
      <s-page heading="Variant metafields">
        <s-section heading="No variant metafields yet">
          <s-paragraph>
            This store has no metafield definitions on variants. Create one in
            Settings → Custom data → Variants, then come back here to export
            what is in it and fill it in from a spreadsheet.
          </s-paragraph>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Variant metafields">
      <s-section heading="Definitions">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            The {definitions.length} metafield definition(s) this store has on
            variants. <strong>Pinned</strong> is worth checking: an unpinned
            definition accepts values but never appears on the variant, which
            looks exactly like an import that did nothing.
          </s-paragraph>

          <div className={styles.tableScroll}>
            <s-table>
              <s-table-header-row>
                <s-table-header>Name</s-table-header>
                <s-table-header>Column</s-table-header>
                <s-table-header>Type</s-table-header>
                <s-table-header>Pinned</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {definitions.map((definition) => (
                  <s-table-row key={definition.id}>
                    <s-table-cell>{definition.name}</s-table-cell>
                    <s-table-cell>{definition.column}</s-table-cell>
                    <s-table-cell>{definition.type}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={definition.pinned ? "success" : "warning"}>
                        {definition.pinned ? "pinned" : "not pinned"}
                      </s-badge>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </div>

          <div className={styles.actions}>
            <s-button
              onClick={() => runExport("definitions")}
              {...(exporting === "definitions" ? { loading: true } : {})}
              {...(exporting ? { disabled: true } : {})}
            >
              Download definitions CSV
            </s-button>
          </div>
        </s-stack>
      </s-section>

      <s-section heading="Export">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Every variant, one row each, with the product&rsquo;s{" "}
            <s-text>handle</s-text> and <s-text>title</s-text>, the variant
            SKU and its options, then one column per metafield named{" "}
            <s-text>namespace.key</s-text>. Edit the cells in a spreadsheet and
            import the file back here.
          </s-paragraph>

          <s-paragraph>
            A metaobject reference is written as its{" "}
            <strong>display name</strong> — a colour family entry comes out as{" "}
            <s-text>Peach</s-text> rather than <s-text>01-peach-radiant</s-text>{" "}
            or a gid — and typing a display name back into the cell resolves to
            the same entry. Handles still work, and win when a value is both. A
            name shared by two entries is reported as an error rather than
            resolved by guessing, so switch to handles if this store has
            duplicates.
          </s-paragraph>

          <s-select
            name="refs"
            label="Write metaobject references as"
            onChange={(event: { currentTarget: { value: string } }) =>
              setRefs(event.currentTarget.value === "handle" ? "handle" : "name")
            }
          >
            {/* The selection lives on the option rather than the select, for
                the reason `app.product-update.tsx` documents. */}
            <s-option value="name" defaultSelected>
              Display name (Peach)
            </s-option>
            <s-option value="handle">Handle (01-peach-radiant)</s-option>
          </s-select>

          {exportError && (
            <s-banner tone="critical">
              <s-paragraph>{exportError}</s-paragraph>
            </s-banner>
          )}

          <div className={styles.actions}>
            <s-button
              variant="primary"
              onClick={() => runExport("values")}
              {...(exporting === "values" ? { loading: true } : {})}
              {...(exporting ? { disabled: true } : {})}
            >
              Download variants CSV
            </s-button>
            <s-button
              onClick={() => runExport("template")}
              {...(exporting === "template" ? { loading: true } : {})}
              {...(exporting ? { disabled: true } : {})}
            >
              Download empty template
            </s-button>
          </div>
        </s-stack>
      </s-section>

      <fetcher.Form
        method="post"
        encType="multipart/form-data"
        ref={formRef}
        onSubmit={onSubmit}
      >
        <s-section heading="Update from CSV">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Rows are matched by <strong>{SKU_COLUMN}</strong>, and rows
              without one by <strong>{HANDLE_COLUMN}</strong> plus their option
              columns. The identifying columns are never written — editing{" "}
              <s-text>title</s-text> here does not rename anything, it just
              changes which variant the row finds. Variants your file does not
              mention are left alone, and none are ever created or deleted.
            </s-paragraph>

            <s-paragraph>
              An <strong>empty cell is skipped</strong>, never written as a
              blank, so a partly-filled spreadsheet cannot erase anything. A
              value that already matches is not written at all, so re-running
              the same file is free and a run that times out is safe to repeat.
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

            <s-checkbox
              name={CLEAR_EMPTY_FIELD}
              label="Clear metafields left empty"
              details="Off, an empty cell is skipped and nothing is erased. On, an empty cell deletes the metafield on that variant — which is how you clear a discontinued value across a catalogue. Every clear is shown in the review step as a value → — change before anything is written."
              {...(data?.step === "plan" && data.clearEmpty
                ? { defaultChecked: true }
                : {})}
            />

            <div className={styles.actions}>
              <s-button
                type="button"
                onClick={submitWith("plan")}
                {...(busy ? { loading: true } : {})}
              >
                Review changes
              </s-button>
            </div>
          </s-stack>
        </s-section>

        {data?.step === "error" && (
          <s-section heading="Could not read that file">
            <s-banner tone="critical">
              <s-paragraph>{data.message}</s-paragraph>
            </s-banner>
          </s-section>
        )}

        {plan && (
          <s-section heading="Review — nothing has been written yet">
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="small-300">
                <s-badge tone="info">{plan.counts.update} to update</s-badge>
                <s-badge tone="neutral">
                  {plan.counts.unchanged} unchanged
                </s-badge>
                {plan.counts.error > 0 && (
                  <s-badge tone="critical">
                    {plan.counts.error} with errors
                  </s-badge>
                )}
              </s-stack>

              {plan.unknownColumns.length > 0 && (
                <s-banner tone="warning">
                  <s-paragraph>
                    Ignored column(s) that are not a metafield on variants:{" "}
                    {plan.unknownColumns.join(", ")}
                  </s-paragraph>
                </s-banner>
              )}

              {/* A wide plan table would otherwise push the whole embedded page
                  sideways on a narrow screen. */}
              <div className={styles.tableScroll}>
                <s-table>
                  <s-table-header-row>
                    <s-table-header>Row</s-table-header>
                    <s-table-header>Variant</s-table-header>
                    <s-table-header>SKU</s-table-header>
                    <s-table-header>Action</s-table-header>
                    <s-table-header>Changes</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {plan.rows.slice(0, 100).map((row) => (
                      <s-table-row key={row.rowNumber}>
                        <s-table-cell>{row.rowNumber}</s-table-cell>
                        <s-table-cell>{row.label || "—"}</s-table-cell>
                        <s-table-cell>{row.sku || "—"}</s-table-cell>
                        <s-table-cell>
                          <s-badge
                            tone={
                              row.action === "error"
                                ? "critical"
                                : row.action === "update"
                                  ? "info"
                                  : "neutral"
                            }
                          >
                            {row.action}
                          </s-badge>
                        </s-table-cell>
                        <s-table-cell>
                          {row.message ?? row.changes.join("; ")}
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              </div>

              {plan.rows.length > 100 && (
                <s-paragraph>
                  Showing the first 100 of {plan.rows.length} rows. All of them
                  will be imported.
                </s-paragraph>
              )}

              <div className={styles.actions}>
                <s-button
                  type="button"
                  variant="primary"
                  onClick={submitWith("apply")}
                  {...(busy ? { loading: true } : {})}
                  {...(plan.writeCount + plan.deleteCount === 0
                    ? { disabled: true }
                    : {})}
                >
                  Update {plan.counts.update} variant(s)
                </s-button>
              </div>
            </s-stack>
          </s-section>
        )}

        {data?.step === "applied" && (
          <s-section heading="Update finished">
            <s-stack direction="block" gap="base">
              <s-banner tone={data.failures.length ? "warning" : "success"}>
                <s-paragraph>
                  {data.variants} variant(s): {data.written} field(s) written,{" "}
                  {data.cleared} cleared, {data.failures.length} failed.
                </s-paragraph>
              </s-banner>

              {data.failures.length > 0 && (
                <s-unordered-list>
                  {data.failures.map((failure) => (
                    <s-list-item key={failure}>{failure}</s-list-item>
                  ))}
                </s-unordered-list>
              )}
            </s-stack>
          </s-section>
        )}
      </fetcher.Form>
    </s-page>
  );
}
