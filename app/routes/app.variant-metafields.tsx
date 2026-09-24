import { useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import {
  FieldPicker,
  allIds,
  initialSelection,
  type PickerGroup,
  type PickerPreset,
} from "../components/FieldPicker";
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
  type DefinitionSet,
  type VariantMetafields,
} from "../lib/variant-metafields.server";
import {
  HANDLE_COLUMN,
  PRODUCT_COLUMN_PREFIX,
  SKU_COLUMN,
  type VariantImportPlan,
} from "../lib/variant-metafield-columns";
import {
  collectImportRefs,
  metafieldColumns,
  planVariantMetafieldImport,
} from "../lib/variant-metafield-csv.server";
import { Guide } from "../components/ui/Guide";
import {
  Actions,
  CsvDropZone,
  readForm,
  useSubmitFeedback,
  Steps,
  TableScroll,
} from "../components/ui/ImportFlow";

// Export and update the metafields that live on product **variants**, together
// with the product metafields that give them context.
//
// The rest of this app works a product at a time. A variant metafield does not
// fit that shape: a colour family belongs to the Peach variant, not to the
// shirt, so a per-product row has nowhere to put it. This page is therefore one
// row per variant, and the cells are written the way a person reads them — a
// metaobject reference comes out as `Peach`, not as a gid or a
// `01-peach-radiant` handle — because a file nobody can read is a file nobody
// can edit.
//
// Product metafields ride along in `product.`-prefixed columns, because the
// values a merchant wants beside a variant — `shopify.color-pattern`, a size
// chart — are usually defined on the product. They are writable, but only once
// per product: see the planner's reconciliation step.
//
// `app.product-update.tsx` can already write variant metafields, but only as
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
      products: number;
      written: number;
      cleared: number;
      failures: string[];
    }
  | { step: "error"; message: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const [variant, product] = await Promise.all([
    listMetafieldDefinitions(admin, "PRODUCTVARIANT"),
    listMetafieldDefinitions(admin, "PRODUCT"),
  ]);

  return { variant, product };
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
  definitions: DefinitionSet,
  csv: string,
  clearEmpty: boolean,
): Promise<
  { ok: true; plan: VariantImportPlan } | { ok: false; message: string }
> {
  const rows = parseCsv(csv);
  if (rows.length < 2) {
    return {
      ok: false,
      message: "That file has a header row but no data rows.",
    };
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

  // The product columns are only read — and only written — when the file
  // actually carries one, so a plain variant file costs nothing extra.
  const wantsProduct = headers.some((header) =>
    header.startsWith(PRODUCT_COLUMN_PREFIX),
  );
  const targets = metafieldColumns(definitions, wantsProduct);
  const reads: DefinitionSet = {
    variant: definitions.variant,
    product: wantsProduct ? definitions.product : [],
  };

  const index = await buildMetaobjectIndex(admin, targets);

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
    getVariantMetafieldsBySkus(admin, reads, skus),
    getVariantMetafieldsByProductHandles(admin, reads, handles),
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
  const refs = collectImportRefs(targets, records, index);
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
    plan: planVariantMetafieldImport(targets, records, variants, {
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
    const [variant, product] = await Promise.all([
      listMetafieldDefinitions(admin, "PRODUCTVARIANT"),
      listMetafieldDefinitions(admin, "PRODUCT"),
    ]);
    if (variant.length === 0 && product.length === 0) {
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

    const result = await buildPlan(
      admin,
      { variant, product },
      await file.text(),
      clearEmpty,
    );
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
      if (!row.variantId) continue;
      if (row.writes.length || row.deletes.length) variants++;

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

    // One write per product, not one per row that named it — the planner has
    // already collapsed the repeats and errored out any disagreement.
    for (const change of result.plan.products) {
      for (const write of change.writes) {
        writes.push({
          write: {
            ownerId: change.productId,
            namespace: write.namespace,
            key: write.key,
            type: write.type,
            value: write.value,
          },
          label: `Product ${change.label} ${write.column}`,
        });
      }
      for (const remove of change.deletes) {
        removals.push({
          remove: {
            ownerId: change.productId,
            namespace: remove.namespace,
            key: remove.key,
          },
          label: `Product ${change.label} ${remove.column}`,
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
    for (
      let start = 0;
      start < removals.length;
      start += METAFIELD_BATCH_SIZE
    ) {
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

    return {
      step: "applied",
      variants,
      products: result.plan.products.length,
      written,
      cleared,
      failures,
    } as const;
  } catch (error) {
    return {
      step: "error",
      message: error instanceof Error ? error.message : String(error),
    } as const;
  }
};

export default function VariantMetafieldsPage() {
  const { variant, product } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const formRef = useRef<HTMLFormElement>(null);

  const [exporting, setExporting] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [refs, setRefs] = useState<"name" | "handle">("name");
  const [withExpanded, setWithExpanded] = useState(true);

  // The picker's groups are the store's own definitions, named by the column
  // they produce — the same strings the export route filters on, so nothing has
  // to be translated between the two.
  const columnGroups: PickerGroup[] = useMemo(
    () => [
      {
        name: "Variant metafields",
        items: variant.map((definition) => ({
          id: definition.column,
          label: `${definition.name} (${definition.column})`,
          details: definition.type,
        })),
      },
      {
        name: "Product metafields",
        items: product.map((definition) => ({
          id: `${PRODUCT_COLUMN_PREFIX}${definition.column}`,
          label: `${definition.name} (${PRODUCT_COLUMN_PREFIX}${definition.column})`,
          details: definition.type,
        })),
      },
    ],
    [variant, product],
  );

  // Everything on to begin with: the old behaviour, so a user who ignores the
  // picker gets the file they got before it existed.
  const [columns, setColumns] = useState<Set<string>>(() =>
    initialSelection(columnGroups, () => true),
  );

  const columnPresets: PickerPreset[] = useMemo(
    () => [
      { name: "Everything", ids: allIds(columnGroups) },
      {
        name: "Variant metafields only",
        ids: variant.map((definition) => definition.column),
      },
      {
        name: "Product metafields only",
        ids: product.map(
          (definition) => `${PRODUCT_COLUMN_PREFIX}${definition.column}`,
        ),
      },
      {
        name: "Pinned only",
        ids: [
          ...variant
            .filter((definition) => definition.pinned)
            .map((definition) => definition.column),
          ...product
            .filter((definition) => definition.pinned)
            .map(
              (definition) => `${PRODUCT_COLUMN_PREFIX}${definition.column}`,
            ),
        ],
      },
    ],
    [columnGroups, variant, product],
  );

  const data = fetcher.data;
  const busy = fetcher.state !== "idle";

  // Derived from the response rather than kept in state, so back-navigation and
  // a re-submitted form cannot leave the indicator out of step with the page.
  const step: 1 | 2 | 3 =
    data?.step === "applied" ? 3 : data?.step === "plan" ? 2 : 1;
  const plan = data?.step === "plan" ? data.plan : null;

  // Whether any product metafield survived the picker. The export route reads
  // this separately because it decides whether to *fetch* product metafields at
  // all, and fetching one costs a lookup per product.
  const withProduct = [...columns].some((column) =>
    column.startsWith(PRODUCT_COLUMN_PREFIX),
  );

  const runExport = async (kind: string) => {
    if (columns.size === 0) {
      setExportError("Tick at least one metafield to export.");
      return;
    }
    setExporting(kind);
    setExportError(null);
    try {
      await downloadCsv(
        `/app/export-variant-metafields?kind=${kind}&refs=${refs}&product=${
          withProduct ? 1 : 0
        }&expand=${withExpanded ? 1 : 0}&fields=${encodeURIComponent(
          [...columns].join(","),
        )}`,
      );
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(null);
    }
  };

  // A submit that renders nothing is indistinguishable from a dead button;
  // say so instead. See `useSubmitFeedback`.
  const [submitError, setSubmitError] = useSubmitFeedback(
    fetcher.state,
    fetcher.data,
  );

  const submitWith = (intent: string) => () => {
    const form = formRef.current;
    if (!form) return;
    // A programmatic submit skips the constraint validation a native one runs,
    // and the CSV field is `required` — without this, forgetting to choose a
    // file would round-trip to the server just to be told so.
    //
    // `readForm` rather than `reportValidity()` + `new FormData(form)`: the
    // field is an `s-drop-zone`, and neither of those handles a form-associated
    // custom element reliably. See `readForm` in components/ui/ImportFlow.
    const formData = readForm(form);
    if (!formData) {
      setSubmitError("Choose a CSV file first.");
      return;
    }
    setSubmitError(null);
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

  if (variant.length === 0 && product.length === 0) {
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

  const definitionRows = [
    ...variant.map((definition) => ({ definition, owner: "variant" as const })),
    ...product.map((definition) => ({ definition, owner: "product" as const })),
  ];

  return (
    <s-page heading="Variant metafields">
      <s-section heading="Definitions">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            {variant.length} definition(s) on variants and {product.length} on
            products. <strong>Pinned</strong> is worth checking: an unpinned
            definition accepts values but never appears in the admin, which
            looks exactly like an import that did nothing.
          </s-paragraph>

          <TableScroll>
            <s-table>
              <s-table-header-row>
                <s-table-header>Owner</s-table-header>
                <s-table-header>Name</s-table-header>
                <s-table-header>Column</s-table-header>
                <s-table-header>Type</s-table-header>
                <s-table-header>Pinned</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {definitionRows.map(({ definition, owner }) => (
                  <s-table-row key={definition.id}>
                    <s-table-cell>{owner}</s-table-cell>
                    <s-table-cell>{definition.name}</s-table-cell>
                    <s-table-cell>
                      {owner === "product"
                        ? `${PRODUCT_COLUMN_PREFIX}${definition.column}`
                        : definition.column}
                    </s-table-cell>
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
          </TableScroll>

          <Actions>
            <s-button
              onClick={() => runExport("definitions")}
              {...(exporting === "definitions" ? { loading: true } : {})}
              {...(exporting ? { disabled: true } : {})}
            >
              Download definitions CSV
            </s-button>
          </Actions>
        </s-stack>
      </s-section>

      <s-section heading="Export">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Every variant, one row each, with the product&rsquo;s{" "}
            <s-text>handle</s-text> and <s-text>title</s-text>, the variant SKU
            and its options, then one column per metafield named{" "}
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
              setRefs(
                event.currentTarget.value === "handle" ? "handle" : "name",
              )
            }
          >
            {/* The selection lives on the option rather than the select, for
                the reason `app.product-update.tsx` documents. */}
            <s-option value="name" defaultSelected>
              Display name (Peach)
            </s-option>
            <s-option value="handle">Handle (01-peach-radiant)</s-option>
          </s-select>

          <s-paragraph>
            Pick the columns below. <s-text>{PRODUCT_COLUMN_PREFIX}</s-text>{" "}
            columns hold a metafield defined on the <strong>product</strong>,
            repeated on each of its variants; they are importable, a value being
            written once per product, and rows of the same product that disagree
            are reported as errors rather than one of them silently winning.
            Leaving them all unticked also makes the export cheaper — a product
            metafield costs a lookup per product to read.
          </s-paragraph>

          <FieldPicker
            groups={columnGroups}
            selected={columns}
            onChange={setColumns}
            presets={columnPresets}
          />

          <s-checkbox
            label="Expand referenced entries into their own columns"
            details="Adds a read-only column per field of each referenced metaobject — 'custom.color_family > color' holds the color field of whatever entry that cell points at. References inside those fields are named one level deeper, so a color-pattern's colour reads as 'Peach' rather than a gid. Ignored on import: changing an entry's own fields is what the metaobject import on Import & export does."
            defaultChecked
            onChange={(event: { currentTarget: { checked: boolean } }) =>
              setWithExpanded(event.currentTarget.checked)
            }
          />

          {exportError && (
            <s-banner tone="critical">
              <s-paragraph>{exportError}</s-paragraph>
            </s-banner>
          )}

          <Actions>
            <s-button
              variant="primary"
              onClick={() => runExport("values")}
              {...(exporting === "values" ? { loading: true } : {})}
              {...(exporting ? { disabled: true } : {})}
            >
              Download variants CSV ({columns.size} column
              {columns.size === 1 ? "" : "s"})
            </s-button>
            <s-button
              onClick={() => runExport("template")}
              {...(exporting === "template" ? { loading: true } : {})}
              {...(exporting ? { disabled: true } : {})}
            >
              Download empty template
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
        <s-section heading="Update from CSV">
          <s-stack direction="block" gap="base">
            <Steps current={step} />

            <Guide id="variant-metafields-import" title="How rows are matched">
              <s-stack direction="block" gap="small-200">
                <s-paragraph>
                  Rows are matched by <strong>{SKU_COLUMN}</strong>, and rows
                  without one by <strong>{HANDLE_COLUMN}</strong> plus their
                  option columns. The identifying columns are never written —
                  editing <s-text type="strong">title</s-text> here does not
                  rename anything, it just changes which variant the row finds.
                  Variants your file does not mention are left alone, and none
                  are ever created or deleted.
                </s-paragraph>

                <s-paragraph>
                  <s-text type="strong">{PRODUCT_COLUMN_PREFIX}</s-text> columns
                  write to the <strong>product</strong>, once each, however many
                  of its variants the file lists. Two rows of the same product
                  asking for different values is an error on both — a product
                  metafield has one value for every variant. Columns containing{" "}
                  <s-text type="strong">&gt;</s-text> are expanded metaobject
                  fields and are read and ignored.
                </s-paragraph>

                <s-paragraph>
                  An <strong>empty cell is skipped</strong>, never written as a
                  blank, so a partly-filled spreadsheet cannot erase anything. A
                  value that already matches is not written at all, so
                  re-running the same file is free and a run that times out is
                  safe to repeat.
                </s-paragraph>
              </s-stack>
            </Guide>

            <CsvDropZone name="file" label="CSV file" accept=".csv,text/csv" />

            {submitError && (
              <s-banner tone="critical" heading="That did not go through">
                <s-paragraph>{submitError}</s-paragraph>
              </s-banner>
            )}

            <s-checkbox
              name={CLEAR_EMPTY_FIELD}
              label="Clear metafields left empty"
              details="Off, an empty cell is skipped and nothing is erased. On, an empty cell deletes the metafield on that variant or product — which is how you clear a discontinued value across a catalogue. Every clear is shown in the review step as a value → — change before anything is written."
              {...(data?.step === "plan" && data.clearEmpty
                ? { defaultChecked: true }
                : {})}
            />

            <Actions>
              <s-button
                type="button"
                onClick={submitWith("plan")}
                {...(busy ? { loading: true } : {})}
              >
                Review changes
              </s-button>
            </Actions>
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
          <s-section heading="Review">
            <s-stack direction="block" gap="base">
              <Steps current={2} />

              <s-banner tone="info">
                <s-paragraph>
                  Nothing has been written yet. This is what the file would do —
                  the store changes only when you press the button at the
                  bottom.
                </s-paragraph>
              </s-banner>
              <s-stack direction="inline" gap="small-300">
                <s-badge tone="info">{plan.counts.update} to update</s-badge>
                <s-badge tone="neutral">
                  {plan.counts.unchanged} unchanged
                </s-badge>
                {plan.products.length > 0 && (
                  <s-badge tone="info">
                    {plan.products.length} product(s)
                  </s-badge>
                )}
                {plan.counts.error > 0 && (
                  <s-badge tone="critical">
                    {plan.counts.error} with errors
                  </s-badge>
                )}
              </s-stack>

              {plan.unknownColumns.length > 0 && (
                <s-banner tone="warning">
                  <s-paragraph>
                    Ignored column(s) that match no metafield definition:{" "}
                    {plan.unknownColumns.join(", ")}
                  </s-paragraph>
                </s-banner>
              )}

              {plan.ignoredColumns.length > 0 && (
                <s-banner tone="info">
                  <s-paragraph>
                    Read and ignored — expanded metaobject fields are never
                    written back: {plan.ignoredColumns.join(", ")}
                  </s-paragraph>
                </s-banner>
              )}

              {plan.products.length > 0 && (
                <s-stack direction="block" gap="small-300">
                  <s-paragraph>
                    <strong>Product metafields</strong> —{" "}
                    {plan.productWriteCount} write(s) and{" "}
                    {plan.productDeleteCount} clear(s), one per product however
                    many rows asked for them.
                  </s-paragraph>
                  <s-unordered-list>
                    {plan.products.slice(0, 20).map((change) => (
                      <s-list-item key={change.productId}>
                        {change.label}: {change.changes.join("; ")}
                      </s-list-item>
                    ))}
                  </s-unordered-list>
                </s-stack>
              )}

              {/* A wide plan table would otherwise push the whole embedded page
                  sideways on a narrow screen. */}
              <TableScroll>
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
              </TableScroll>

              {plan.rows.length > 100 && (
                <s-paragraph>
                  Showing the first 100 of {plan.rows.length} rows. All of them
                  will be imported.
                </s-paragraph>
              )}

              <Actions>
                <s-button
                  type="button"
                  variant="primary"
                  onClick={submitWith("apply")}
                  {...(busy ? { loading: true } : {})}
                  {...(plan.writeCount +
                    plan.deleteCount +
                    plan.productWriteCount +
                    plan.productDeleteCount ===
                  0
                    ? { disabled: true }
                    : {})}
                >
                  Write{" "}
                  {plan.writeCount +
                    plan.deleteCount +
                    plan.productWriteCount +
                    plan.productDeleteCount}{" "}
                  change(s)
                </s-button>
              </Actions>
            </s-stack>
          </s-section>
        )}

        {data?.step === "applied" && (
          <s-section heading="Update finished">
            <s-stack direction="block" gap="base">
              <Steps current={3} />
              <s-banner tone={data.failures.length ? "warning" : "success"}>
                <s-paragraph>
                  {data.variants} variant(s) and {data.products} product(s):{" "}
                  {data.written} field(s) written, {data.cleared} cleared,{" "}
                  {data.failures.length} failed.
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
