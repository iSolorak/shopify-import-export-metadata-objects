import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { parseCsv, rowsToRecords } from "../lib/csv";
import {
  createDefinition,
  getDefinition,
  getEntries,
  listDefinitions,
  upsertEntry,
} from "../lib/metaobjects.server";
import {
  isDefinitionCsv,
  planDefinitionImport,
  planEntryImport,
  type ImportPlan,
} from "../lib/metaobject-csv";

// An import is two round trips: "plan" reads the file and reports what would
// change, "apply" performs the writes. The CSV text rides along in a hidden
// field between them so confirming does not require re-picking the file.
type ActionData =
  | { step: "plan"; plan: ImportPlan; csv: string; type: string }
  | { step: "plan-definition"; summary: string[]; csv: string }
  | { step: "applied"; created: number; updated: number; failures: string[] }
  | { step: "error"; message: string };

// A single import runs one mutation per changed row against a rate-limited API.
// Past this many rows the request outlives a sensible HTTP timeout, so the file
// is rejected with an explanation rather than dying halfway through.
const MAX_ROWS = 1000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  return { definitions: await listDefinitions(admin) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  try {
    // --- Step 1: read the file and report what it would do ----------------
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

      const records = rowsToRecords(rows);

      if (isDefinitionCsv(rows[0])) {
        const definitions = planDefinitionImport(records);
        return {
          step: "plan-definition",
          csv,
          summary: definitions.map(
            (d) =>
              `${d.name} (${d.type}) — ${d.fieldDefinitions.length} field(s)`,
          ),
        } as const;
      }

      // An entries CSV does not name its own type; the merchant picks the
      // target definition, which also prevents importing into the wrong one
      // by accident.
      const type = String(formData.get("type") ?? "");
      if (!type) {
        return {
          step: "error",
          message: "Choose which metaobject type these entries belong to.",
        } as const;
      }

      const definition = await getDefinition(admin, type);
      if (!definition) {
        return {
          step: "error",
          message: `This store has no metaobject definition of type "${type}".`,
        } as const;
      }

      const existing = await getEntries(admin, type);
      return {
        step: "plan",
        plan: planEntryImport(definition, records, existing),
        csv,
        type,
      } as const;
    }

    // --- Step 2: write ----------------------------------------------------
    if (intent === "apply") {
      const csv = String(formData.get("csv") ?? "");
      const records = rowsToRecords(parseCsv(csv));
      const failures: string[] = [];

      if (String(formData.get("kind")) === "definition") {
        let created = 0;
        for (const definition of planDefinitionImport(records)) {
          const result = await createDefinition(admin, definition);
          if (result.ok) created++;
          else failures.push(`${definition.type}: ${result.errors.join("; ")}`);
        }
        return { step: "applied", created, updated: 0, failures } as const;
      }

      const type = String(formData.get("type") ?? "");
      const definition = await getDefinition(admin, type);
      if (!definition) {
        return {
          step: "error",
          message: `This store has no metaobject definition of type "${type}".`,
        } as const;
      }

      // Re-plan against the store as it is *now* rather than trusting the plan
      // the browser is echoing back: the data may have changed since it was
      // shown, and it arrived from the client where it could have been edited.
      const plan = planEntryImport(
        definition,
        records,
        await getEntries(admin, type),
      );

      let created = 0;
      let updated = 0;

      // Sequential on purpose. These mutations share a leaky-bucket rate limit,
      // and a burst of parallel writes gets throttled into failures that look
      // like data errors.
      for (const row of plan.rows) {
        if (row.action === "unchanged") continue;
        if (row.action === "error") {
          failures.push(`Row ${row.rowNumber}: ${row.message}`);
          continue;
        }

        const result = await upsertEntry(admin, type, row.handle, row.values);
        if (!result.ok) {
          failures.push(`Row ${row.rowNumber} (${row.handle}): ${result.errors.join("; ")}`);
        } else if (row.action === "create") {
          created++;
        } else {
          updated++;
        }
      }

      return { step: "applied", created, updated, failures } as const;
    }

    return { step: "error", message: "Unknown action." } as const;
  } catch (error) {
    // Parse failures and Admin API errors both land here. The message is the
    // useful part — it names the row or the field that broke.
    return {
      step: "error",
      message: error instanceof Error ? error.message : String(error),
    } as const;
  }
};

export default function MetaobjectsImport() {
  const { definitions } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const [type, setType] = useState(definitions[0]?.type ?? "");

  const data = fetcher.data;
  const busy = fetcher.state !== "idle";

  return (
    <s-page heading="Import metaobjects">
      <s-button slot="primary-action" href="/app/metaobjects" variant="tertiary">
        Back
      </s-button>

      <s-section heading="Choose a file">
        <fetcher.Form method="post" encType="multipart/form-data">
          <input type="hidden" name="intent" value="plan" />
          <s-stack direction="block" gap="base">
            <s-paragraph>
              An <strong>entries</strong> CSV needs a{" "}
              <s-text>handle</s-text> column plus one column per field. A{" "}
              <strong>definition</strong> CSV is detected automatically and
              creates the schema instead.
            </s-paragraph>

            <s-select
              label="Metaobject type (entries CSV only)"
              name="type"
              value={type}
              onChange={(e: Event) =>
                setType((e.target as HTMLSelectElement).value)
              }
            >
              {definitions.map((definition) => (
                <s-option key={definition.id} value={definition.type}>
                  {definition.name} ({definition.type})
                </s-option>
              ))}
            </s-select>

            <input type="file" name="file" accept=".csv,text/csv" required />

            <s-button type="submit" {...(busy ? { loading: true } : {})}>
              Review changes
            </s-button>
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
            <s-stack direction="inline" gap="small-300">
              <s-badge tone="success">{data.plan.counts.create} to create</s-badge>
              <s-badge tone="info">{data.plan.counts.update} to update</s-badge>
              <s-badge tone="neutral">
                {data.plan.counts.unchanged} unchanged
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
                  Ignored column(s) with no matching field:{" "}
                  {data.plan.unknownColumns.join(", ")}
                </s-paragraph>
              </s-banner>
            )}

            {data.plan.missingRequiredColumns.length > 0 && (
              <s-banner tone="warning">
                <s-paragraph>
                  The definition requires field(s) this file has no column for:{" "}
                  {data.plan.missingRequiredColumns.join(", ")}. New entries
                  will fail unless you add them.
                </s-paragraph>
              </s-banner>
            )}

            <s-table>
              <s-table-header-row>
                <s-table-header>Row</s-table-header>
                <s-table-header>Handle</s-table-header>
                <s-table-header>Action</s-table-header>
                <s-table-header>Details</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {data.plan.rows.slice(0, 100).map((row) => (
                  <s-table-row key={row.rowNumber}>
                    <s-table-cell>{row.rowNumber}</s-table-cell>
                    <s-table-cell>{row.handle || "—"}</s-table-cell>
                    <s-table-cell>
                      <s-badge
                        tone={
                          row.action === "error"
                            ? "critical"
                            : row.action === "create"
                              ? "success"
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
                        (row.changedFields.length
                          ? `changes: ${row.changedFields.join(", ")}`
                          : "")}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>

            {data.plan.rows.length > 100 && (
              <s-paragraph>
                Showing the first 100 of {data.plan.rows.length} rows. All of
                them will be imported.
              </s-paragraph>
            )}

            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="apply" />
              <input type="hidden" name="kind" value="entries" />
              <input type="hidden" name="type" value={data.type} />
              <input type="hidden" name="csv" value={data.csv} />
              <s-button
                type="submit"
                variant="primary"
                {...(busy ? { loading: true } : {})}
              >
                Import {data.plan.counts.create + data.plan.counts.update}{" "}
                entries
              </s-button>
            </fetcher.Form>
          </s-stack>
        </s-section>
      )}

      {data?.step === "plan-definition" && (
        <s-section heading="Review — definition CSV">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              This file describes {data.summary.length} definition(s). Existing
              types are not modified — creating one that already exists will
              report an error rather than overwrite it.
            </s-paragraph>
            <s-unordered-list>
              {data.summary.map((line) => (
                <s-list-item key={line}>{line}</s-list-item>
              ))}
            </s-unordered-list>

            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="apply" />
              <input type="hidden" name="kind" value="definition" />
              <input type="hidden" name="csv" value={data.csv} />
              <s-button
                type="submit"
                variant="primary"
                {...(busy ? { loading: true } : {})}
              >
                Create definition(s)
              </s-button>
            </fetcher.Form>
          </s-stack>
        </s-section>
      )}

      {data?.step === "applied" && (
        <s-section heading="Import finished">
          <s-stack direction="block" gap="base">
            <s-banner tone={data.failures.length ? "warning" : "success"}>
              <s-paragraph>
                {data.created} created, {data.updated} updated,{" "}
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

            <Link to="/app/metaobjects">
              <s-button>Back to metaobjects</s-button>
            </Link>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}
