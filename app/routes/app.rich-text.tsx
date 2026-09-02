import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { parseCsv } from "../lib/csv";
import { normalizeCsvRecords } from "../lib/shopify-export-csv";
import {
  METAFIELD_BATCH_SIZE,
  getProductRichTextByTitles,
  listRichTextDefinitions,
  setRichTextMetafields,
  type MetafieldWrite,
} from "../lib/product-metafields.server";
import {
  TITLE_COLUMN,
  planRichTextImport,
  type RichTextImportPlan,
} from "../lib/rich-text-csv";
import { SUPPORTED_TAGS } from "../lib/rich-text";
import { downloadCsv } from "../lib/download-csv";
import styles from "./app._index/styles.module.css";

// Import and export product rich text metafields as HTML.
//
// The two-step plan/apply flow is the same as the metaobject page: "plan" reads
// the file and reports what would change, "apply" performs the writes, and the
// CSV text rides between them in a hidden field so confirming does not require
// re-picking the file.
type ActionData =
  | { step: "plan"; plan: RichTextImportPlan; csv: string; note?: string }
  | { step: "applied"; updated: number; failures: string[] }
  | { step: "error"; message: string };

// Import writes in batches of 25 against a rate-limited API. Past this many
// rows the request outlives a sensible HTTP timeout, so the file is rejected
// with an explanation rather than dying halfway through.
const MAX_ROWS = 1000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  return { definitions: await listRichTextDefinitions(admin) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  try {
    const definitions = await listRichTextDefinitions(admin);
    if (definitions.length === 0) {
      return {
        step: "error",
        message:
          "This store has no rich text metafield definitions on products. Create one in Settings → Custom data → Products first.",
      } as const;
    }

    // --- Step 1: read the file and report what it would do ------------------
    if (intent === "plan") {
      const file = formData.get("file");
      if (!(file instanceof File) || file.size === 0) {
        return { step: "error", message: "Choose a CSV file first." } as const;
      }

      const csv = await file.text();
      const rows = parseCsv(csv);
      if (rows.length < 2) {
        return {
          step: "error",
          message: "That file has a header row but no data rows.",
        } as const;
      }
      if (rows.length - 1 > MAX_ROWS) {
        return {
          step: "error",
          message: `That file has ${rows.length - 1} rows. Import at most ${MAX_ROWS} at a time.`,
        } as const;
      }

      // Accepts this app's own export or a file straight out of the admin's
      // Products → Export; see `shopify-export-csv.ts`.
      const { records, note } = normalizeCsvRecords(
        rows,
        definitions.map((definition) => definition.column),
      );
      if (!records.some((record) => record[TITLE_COLUMN] !== undefined)) {
        return {
          step: "error",
          message: `This file has no "${TITLE_COLUMN}" column. Rows are matched to products by title — download the template to see the expected columns, or import a Shopify product export unchanged.`,
        } as const;
      }

      const titles = records.map((record) => record[TITLE_COLUMN] ?? "");
      const products = await getProductRichTextByTitles(
        admin,
        definitions,
        titles,
      );

      return {
        step: "plan",
        plan: planRichTextImport(definitions, records, products),
        csv,
        ...(note ? { note } : {}),
      } as const;
    }

    // --- Step 2: write ------------------------------------------------------
    if (intent === "apply") {
      const csv = String(formData.get("csv") ?? "");
      // Normalised the same way as in the plan step, so the re-plan below sees
      // exactly the rows the merchant was shown.
      const { records } = normalizeCsvRecords(
        parseCsv(csv),
        definitions.map((definition) => definition.column),
      );

      // Re-plan against the store as it is *now* rather than trusting the plan
      // the browser is echoing back: the data may have changed since it was
      // shown, and it arrived from the client where it could have been edited.
      const plan = planRichTextImport(
        definitions,
        records,
        await getProductRichTextByTitles(
          admin,
          definitions,
          records.map((record) => record[TITLE_COLUMN] ?? ""),
        ),
      );

      const byColumn = new Map(definitions.map((d) => [d.column, d]));
      const failures: string[] = [];

      // Flatten the plan into individual metafield writes, remembering which
      // row each came from so a failed batch can name the rows involved rather
      // than just the batch.
      const pending: { write: MetafieldWrite; label: string }[] = [];
      for (const row of plan.rows) {
        if (row.action === "error") {
          failures.push(`Row ${row.rowNumber}: ${row.message}`);
          continue;
        }
        if (!row.productId) continue;

        for (const [column, value] of Object.entries(row.writes)) {
          const definition = byColumn.get(column);
          if (!definition) continue;
          pending.push({
            write: {
              ownerId: row.productId,
              namespace: definition.namespace,
              key: definition.key,
              value,
            },
            label: `Row ${row.rowNumber} (${row.title}) ${column}`,
          });
        }
      }

      let updated = 0;

      // Batched, then sequential. `metafieldsSet` takes 25 metafields per call,
      // and these mutations share a leaky-bucket rate limit — a burst of
      // parallel calls gets throttled into failures that look like data errors.
      for (
        let start = 0;
        start < pending.length;
        start += METAFIELD_BATCH_SIZE
      ) {
        const batch = pending.slice(start, start + METAFIELD_BATCH_SIZE);
        const result = await setRichTextMetafields(
          admin,
          batch.map((item) => item.write),
        );

        if (result.ok) {
          updated += batch.length;
        } else {
          // The API reports errors against a position in the input array, so
          // the batch is named as a whole rather than mis-attributing them.
          failures.push(
            `${batch[0].label}${batch.length > 1 ? ` and ${batch.length - 1} more` : ""}: ${result.errors.join("; ")}`,
          );
        }
      }

      return { step: "applied", updated, failures } as const;
    }

    return { step: "error", message: "Unknown action." } as const;
  } catch (error) {
    return {
      step: "error",
      message: error instanceof Error ? error.message : String(error),
    } as const;
  }
};

export default function RichTextPage() {
  const { definitions } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();

  const [exporting, setExporting] = useState<"values" | "template" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const data = fetcher.data;
  const busy = fetcher.state !== "idle";

  const runExport = async (kind: "values" | "template") => {
    setExporting(kind);
    setExportError(null);
    try {
      await downloadCsv(`/app/export-rich-text?kind=${kind}`);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(null);
    }
  };

  if (definitions.length === 0) {
    return (
      <s-page heading="Rich text import & export">
        <s-section heading="No rich text metafields yet">
          <s-paragraph>
            This store has no metafield definitions of type{" "}
            <s-text>rich_text_field</s-text> on products. Create one in Settings
            → Custom data → Products, then come back here to fill it in from a
            spreadsheet.
          </s-paragraph>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Rich text import & export">
      <s-section heading="Export">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Every product, one row each, with its rich text metafields written
            as <strong>HTML</strong> rather than the JSON Shopify stores. Edit
            the cells in a spreadsheet and import the file back.
          </s-paragraph>

          <s-paragraph>
            <s-text>
              {definitions.length} rich text field(s):{" "}
              {definitions.map((d) => d.column).join(", ")}
            </s-text>
          </s-paragraph>

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
              Download products CSV
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

      <s-section heading="Import">
        <fetcher.Form method="post" encType="multipart/form-data">
          <input type="hidden" name="intent" value="plan" />
          <s-stack direction="block" gap="base">
            <s-paragraph>
              The file needs a <s-text>{TITLE_COLUMN}</s-text> column holding
              the product title, plus one column per metafield named{" "}
              <s-text>namespace.key</s-text>. Cells hold HTML —{" "}
              <s-text>{SUPPORTED_TAGS}</s-text> are converted to Shopify&rsquo;s
              rich text format. Anything else is kept as plain text.
            </s-paragraph>

            <s-paragraph>
              A CSV exported from <strong>Products → Export</strong> in the
              admin also works as-is — its{" "}
              <s-text>Title</s-text> and{" "}
              <s-text>… (product.metafields.namespace.key)</s-text> columns are
              recognised, and its per-variant rows are collapsed to one row per
              product.
            </s-paragraph>

            <s-paragraph>
              An <strong>empty cell is left alone</strong>, not cleared, so you
              can fill in one column without disturbing the others. Two products
              sharing a title need a <s-text>handle</s-text> column to tell them
              apart.
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

            <div className={styles.actions}>
              <s-button type="submit" {...(busy ? { loading: true } : {})}>
                Review changes
              </s-button>
            </div>
          </s-stack>
        </fetcher.Form>
      </s-section>

      {data?.step === "error" && (
        <s-section heading="Could not read that file">
          <s-banner tone="critical">
            <s-paragraph>{data.message}</s-paragraph>
          </s-banner>
        </s-section>
      )}

      {data?.step === "plan" && (
        <s-section heading="Review — nothing has been written yet">
          <s-stack direction="block" gap="base">
            {data.note && (
              <s-banner tone="info">
                <s-paragraph>{data.note}</s-paragraph>
              </s-banner>
            )}

            <s-stack direction="inline" gap="small-300">
              <s-badge tone="info">{data.plan.counts.update} to update</s-badge>
              <s-badge tone="neutral">
                {data.plan.counts.unchanged} unchanged
              </s-badge>
              <s-badge tone="neutral">
                {data.plan.counts.skipped} empty
              </s-badge>
              {data.plan.counts.error > 0 && (
                <s-badge tone="critical">
                  {data.plan.counts.error} with errors
                </s-badge>
              )}
            </s-stack>

            {data.plan.unknownColumns.length > 0 && (
              <s-banner tone="warning">
                <s-paragraph>
                  Ignored column(s) that are not a rich text metafield on
                  products: {data.plan.unknownColumns.join(", ")}
                </s-paragraph>
              </s-banner>
            )}

            {/* A wide plan table would otherwise push the whole embedded page
                sideways on a narrow screen. */}
            <div className={styles.tableScroll}>
              <s-table>
                <s-table-header-row>
                  <s-table-header>Row</s-table-header>
                  <s-table-header>Product</s-table-header>
                  <s-table-header>Action</s-table-header>
                  <s-table-header>Details</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {data.plan.rows.slice(0, 100).map((row) => (
                    <s-table-row key={row.rowNumber}>
                      <s-table-cell>{row.rowNumber}</s-table-cell>
                      <s-table-cell>{row.title || "—"}</s-table-cell>
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
                        {row.message ??
                          (row.changedColumns.length
                            ? `changes: ${row.changedColumns.join(", ")}`
                            : "")}
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            </div>

            {data.plan.rows.length > 100 && (
              <s-paragraph>
                Showing the first 100 of {data.plan.rows.length} rows. All of
                them will be imported.
              </s-paragraph>
            )}

            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="apply" />
              <input type="hidden" name="csv" value={data.csv} />
              <div className={styles.actions}>
                <s-button
                  type="submit"
                  variant="primary"
                  {...(busy ? { loading: true } : {})}
                  {...(data.plan.writeCount === 0 ? { disabled: true } : {})}
                >
                  Write {data.plan.writeCount} field(s)
                </s-button>
              </div>
            </fetcher.Form>
          </s-stack>
        </s-section>
      )}

      {data?.step === "applied" && (
        <s-section heading="Import finished">
          <s-stack direction="block" gap="base">
            <s-banner tone={data.failures.length ? "warning" : "success"}>
              <s-paragraph>
                {data.updated} field(s) written, {data.failures.length} failed.
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
    </s-page>
  );
}
