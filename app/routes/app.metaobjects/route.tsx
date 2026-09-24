import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";

import { authenticate } from "../../shopify.server";
import { parseCsv, rowsToRecords } from "../../lib/csv";
import {
  createDefinition,
  getDefinition,
  getEntries,
  listDefinitions,
  upsertEntry,
} from "../../lib/metaobjects.server";
import {
  DISPLAY_NAME_COLUMN,
  HANDLE_COLUMN,
  fileUrlsInRecords,
  isDefinitionCsv,
  planDefinitionImport,
  planEntryImport,
  type ImportPlan,
} from "../../lib/metaobject-csv";
import {
  createFilesFromUrls,
  findFilesByFilename,
  uploadFilenameFor,
  type FileUpload,
} from "../../lib/files.server";
import { downloadCsv } from "../../lib/download-csv";
import type { Definition } from "../../lib/metaobjects.server";
import { Guide } from "../../components/ui/Guide";
import {
  Actions,
  CsvDropZone,
  PlanSummary,
  Steps,
  TableScroll,
  TruncationNote,
} from "../../components/ui/ImportFlow";

// Export metaobjects to CSV, and import a CSV back to create or update them.
// Product rich text metafields have their own page — see `app.rich-text.tsx`.
//
// An import is two round trips. "plan" reads the file and reports what would
// change; "apply" performs the writes. The CSV text rides along in a hidden
// field between them so confirming does not require re-picking the file.
type ActionData =
  | { step: "plan"; plan: ImportPlan; csv: string; type: string }
  | { step: "plan-definition"; summary: string[]; csv: string }
  | {
      step: "applied";
      created: number;
      updated: number;
      /** Images pulled from their source URLs into Content → Files. */
      uploaded: number;
      failures: string[];
    }
  | { step: "error"; message: string };

// A single import runs one mutation per changed row against a rate-limited API.
// Past this many rows the request outlives a sensible HTTP timeout, so the file
// is rejected with an explanation rather than dying halfway through.
const MAX_ROWS = 1000;

/**
 * Distinct new images per import.
 *
 * Each one is a `fileCreate` that Shopify fulfils by fetching the URL itself,
 * so the cost is a round trip rather than a download — but it is still inside a
 * request nginx gives 300 seconds. Because a resolved image is reused rather
 * than re-uploaded, splitting a larger file and running it twice costs nothing
 * for the images that already landed.
 */
const MAX_NEW_FILES = 100;

type Admin = Parameters<typeof findFilesByFilename>[0];

/**
 * Resolve the file URLs in a CSV to gids, without uploading anything.
 *
 * Read-only on purpose, and run during the plan step: the diff cannot be taken
 * until file cells hold gids (see `planEntryImport`), and the plan step's whole
 * promise is that nothing has been written yet. Anything this does not find is
 * reported as a pending upload and dealt with on apply.
 */
async function resolveExistingFiles(
  admin: Admin,
  definition: Definition,
  records: Record<string, string>[],
): Promise<{ files: Map<string, string>; uploads: FileUpload[] }> {
  const refs = fileUrlsInRecords(definition, records);
  if (!refs.length) return { files: new Map(), uploads: [] };

  // Alt text comes from `display_name`, falling back to the handle. It is the
  // only human-readable label a row carries, it is on every entries CSV this
  // app exports, and an image landing in Files with no alt is both unsearchable
  // and inaccessible.
  const altByUrl = new Map<string, string>();
  for (const record of records) {
    const alt =
      (record[DISPLAY_NAME_COLUMN] ?? "").trim() ||
      (record[HANDLE_COLUMN] ?? "").trim();
    // First row to mention a URL names it; the same image shared by several
    // entries is one file, so it can only carry one alt.
    for (const ref of fileUrlsInRecords(definition, [record])) {
      if (!altByUrl.has(ref.url)) altByUrl.set(ref.url, alt);
    }
  }

  const uploads: FileUpload[] = refs.map((ref) => ({
    url: ref.url,
    filename: uploadFilenameFor(ref.handle, ref.url),
    alt: altByUrl.get(ref.url) ?? ref.handle,
  }));

  const existing = await findFilesByFilename(
    admin,
    uploads.map((upload) => upload.filename),
  );

  const files = new Map<string, string>();
  const missing: FileUpload[] = [];
  for (const upload of uploads) {
    const id = existing.get(upload.filename.toLowerCase());
    if (id) files.set(upload.url, id);
    else missing.push(upload);
  }

  return { files, uploads: missing };
}

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
      // Read-only: images already in the store resolve now, so an unedited
      // re-import can still report "unchanged". The rest are counted as
      // pending and uploaded only once the merchant confirms.
      const { files } = await resolveExistingFiles(admin, definition, records);

      const plan = planEntryImport(definition, records, existing, { files });
      if (plan.pendingUploads.length > MAX_NEW_FILES) {
        return {
          step: "error",
          message: `That file introduces ${plan.pendingUploads.length} new images. Import at most ${MAX_NEW_FILES} at a time — images already uploaded are reused, so splitting the file costs nothing.`,
        } as const;
      }

      return { step: "plan", plan, csv, type } as const;
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
        return {
          step: "applied",
          created,
          updated: 0,
          uploaded: 0,
          failures,
        } as const;
      }

      const type = String(formData.get("type") ?? "");
      const definition = await getDefinition(admin, type);
      if (!definition) {
        return {
          step: "error",
          message: `This store has no metaobject definition of type "${type}".`,
        } as const;
      }

      // Resolve what is already in Files, then upload only what is left. Both
      // happen before the upsert loop so a row never half-writes — an entry
      // pointing at a file that failed to upload would be worse than an entry
      // not written at all.
      const { files, uploads } = await resolveExistingFiles(
        admin,
        definition,
        records,
      );

      if (uploads.length > MAX_NEW_FILES) {
        return {
          step: "error",
          message: `That file introduces ${uploads.length} new images. Import at most ${MAX_NEW_FILES} at a time.`,
        } as const;
      }

      let uploaded = 0;
      if (uploads.length) {
        const createdFiles = await createFilesFromUrls(admin, uploads);
        for (const [url, id] of createdFiles.resolved) files.set(url, id);
        uploaded = createdFiles.resolved.size;
        failures.push(...createdFiles.errors.map((error) => `Image: ${error}`));
      }

      // Re-plan against the store as it is *now* rather than trusting the plan
      // the browser is echoing back: the data may have changed since it was
      // shown, and it arrived from the client where it could have been edited.
      const plan = planEntryImport(
        definition,
        records,
        await getEntries(admin, type),
        { files },
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

        // An upload that failed above leaves the cell holding a URL. Writing it
        // would put a bare URL in a file reference field, so the row is skipped
        // and reported instead — the error explaining why is already in
        // `failures` from `createFilesFromUrls`.
        if (row.pendingUploads.length) {
          failures.push(
            `Row ${row.rowNumber} (${row.handle}): skipped — ${row.pendingUploads.length} image(s) could not be uploaded.`,
          );
          continue;
        }

        const result = await upsertEntry(admin, type, row.handle, row.values);
        if (!result.ok) {
          failures.push(
            `Row ${row.rowNumber} (${row.handle}): ${result.errors.join("; ")}`,
          );
        } else if (row.action === "create") {
          created++;
        } else {
          updated++;
        }
      }

      return { step: "applied", created, updated, uploaded, failures } as const;
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

// The decorative dark-terminal backdrop that used to live here — a fixed CRT
// layer with scanlines and a sweeping refresh band, painted by tinting
// `document.body` while the route was mounted — has been removed.
//
// It was on this page only, so the app changed visual identity when you moved
// between tools; it forced a dark surface behind Polaris components that were
// still rendering in the admin's light theme; and it made one tool look like
// the app's centrepiece when the front door moved to `/app`. None of that is
// recoverable by tuning it, because the problem was that it was per-page.
//
// If the app wants a distinctive look, the place for it is the whole app and
// the mechanism is the theme, not one route reaching into `document.body`.

export default function ImportExportPage() {
  const { definitions } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();

  // Which definition the export buttons point at, and the default target for
  // an entries import.
  const [selectedType, setSelectedType] = useState(definitions[0]?.type ?? "");
  const [exporting, setExporting] = useState<"entries" | "definition" | null>(
    null,
  );
  const [exportError, setExportError] = useState<string | null>(null);

  const data = fetcher.data;
  const busy = fetcher.state !== "idle";
  const selected = definitions.find((d) => d.type === selectedType);

  const runExport = async (kind: "entries" | "definition") => {
    setExporting(kind);
    setExportError(null);
    try {
      await downloadCsv(
        `/app/export?type=${encodeURIComponent(selectedType)}&kind=${kind}`,
      );
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(null);
    }
  };

  // Which of choose → review → apply the page is showing. Driven by the shape
  // of the last response rather than by state of its own, so a browser back or
  // a re-submitted form cannot leave the indicator disagreeing with the page.
  const step: 1 | 2 | 3 =
    data?.step === "applied"
      ? 3
      : data?.step === "plan" || data?.step === "plan-definition"
        ? 2
        : 1;

  return (
    <s-page heading="Metaobjects">
      <s-section heading="Export">
        {definitions.length === 0 ? (
          <s-paragraph>
            This store has no metaobject definitions yet. Import a definition
            CSV below to create one.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            <Guide id="metaobjects-export" title="Entries or definition?">
              <s-stack direction="block" gap="small-200">
                <s-paragraph>
                  <strong>Entries</strong> is the data — one row per metaobject,
                  one column per field. This is the file to edit when you want
                  to change content.
                </s-paragraph>
                <s-paragraph>
                  <strong>Definition</strong> is the schema: which fields the
                  type has and what they hold. Moving a type to another store
                  means importing its definition there first, so the entries
                  have somewhere to land.
                </s-paragraph>
              </s-stack>
            </Guide>

            <s-select
              label="Metaobject type"
              name="exportType"
              value={selectedType}
              onChange={(e: Event) =>
                setSelectedType((e.target as HTMLSelectElement).value)
              }
            >
              {definitions.map((definition) => (
                <s-option key={definition.id} value={definition.type}>
                  {definition.name} ({definition.type}) —{" "}
                  {definition.entryCount} entries
                </s-option>
              ))}
            </s-select>

            {/* The columns the chosen file will have, before downloading it.
                Subdued because it confirms the selection rather than asking
                anything — it should be available to read, not compete with the
                select above it. */}
            {selected && (
              <s-paragraph color="subdued">
                {selected.fieldKeys.length} field
                {selected.fieldKeys.length === 1 ? "" : "s"}:{" "}
                {selected.fieldKeys.join(", ")}
              </s-paragraph>
            )}

            {exportError && (
              <s-banner tone="critical" heading="Export failed">
                <s-paragraph>{exportError}</s-paragraph>
              </s-banner>
            )}

            <Actions>
              <s-button
                variant="primary"
                icon="download"
                onClick={() => runExport("entries")}
                {...(exporting === "entries" ? { loading: true } : {})}
                {...(exporting ? { disabled: true } : {})}
              >
                Download entries CSV
              </s-button>
              <s-button
                icon="download"
                onClick={() => runExport("definition")}
                {...(exporting === "definition" ? { loading: true } : {})}
                {...(exporting ? { disabled: true } : {})}
              >
                Download definition CSV
              </s-button>
            </Actions>
          </s-stack>
        )}
      </s-section>

      <s-section heading="Import">
        <fetcher.Form method="post" encType="multipart/form-data">
          <input type="hidden" name="intent" value="plan" />
          <s-stack direction="block" gap="base">
            <Steps current={step} />

            <Guide id="metaobjects-import" title="What your file needs">
              <s-stack direction="block" gap="small-200">
                <s-paragraph>
                  An <strong>entries</strong> CSV needs a{" "}
                  <s-text type="strong">handle</s-text> column plus one column
                  per field. Rows are matched by handle: a known handle is
                  updated, a new one creates a metaobject.
                </s-paragraph>
                <s-paragraph>
                  A <strong>definition</strong> CSV is recognised automatically
                  and creates the schema instead — you do not need to tell the
                  page which kind you are uploading.
                </s-paragraph>
                <s-paragraph>
                  A <strong>file</strong> field accepts an image URL as well as
                  the <s-text type="strong">gid://</s-text> value an export
                  writes. Any URL is pulled into Content &rarr; Files and linked
                  to the entry, so a sheet made by hand needs no uploading
                  first. Mixing the two in one file is fine — a cell that
                  already holds a gid is left exactly as it is. Link directly to
                  the image, and separate several with{" "}
                  <s-text type="strong">;</s-text> on a list field.
                </s-paragraph>
              </s-stack>
            </Guide>

            <s-select
              label="Import entries into"
              name="type"
              value={selectedType}
              onChange={(e: Event) =>
                setSelectedType((e.target as HTMLSelectElement).value)
              }
            >
              {definitions.map((definition) => (
                <s-option key={definition.id} value={definition.type}>
                  {definition.name} ({definition.type})
                </s-option>
              ))}
            </s-select>

            <CsvDropZone />

            <Actions>
              <s-button
                type="submit"
                variant="primary"
                icon="import"
                {...(busy ? { loading: true } : {})}
              >
                Review changes
              </s-button>
            </Actions>
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
        <s-section heading="Review">
          <s-stack direction="block" gap="base">
            <Steps current={2} />

            {/* The reassurance is a banner, not a heading. It used to be part
                of the section title ("Review — nothing has been written yet"),
                where it made the heading long enough to skim past and left the
                most important promise on the page competing with a label. */}
            <s-banner tone="info">
              <s-paragraph>
                Nothing has been written yet. This is what the file would do —
                the store changes only when you press the button at the bottom.
              </s-paragraph>
            </s-banner>

            <PlanSummary
              counts={data.plan.counts}
              extra={
                <>
                  {data.plan.pendingUploads.length > 0 && (
                    <s-badge tone="info" icon="image-add">
                      {data.plan.pendingUploads.length} image
                      {data.plan.pendingUploads.length === 1 ? "" : "s"} to
                      upload
                    </s-badge>
                  )}
                  {data.plan.reusedFiles > 0 && (
                    <s-badge tone="neutral" icon="image">
                      {data.plan.reusedFiles} image
                      {data.plan.reusedFiles === 1 ? "" : "s"} already in Files
                    </s-badge>
                  )}
                </>
              }
            />

            {data.plan.pendingUploads.length > 0 && (
              <s-banner tone="info">
                <s-paragraph>
                  {data.plan.pendingUploads.length} image URL(s) will be pulled
                  into Content &rarr; Files and linked to their entries. Images
                  already uploaded by an earlier run are reused, so running this
                  file again will not create copies.
                </s-paragraph>
              </s-banner>
            )}

            {/* Named before the other warnings because it is the cause of
                them: when nothing lines up, the per-row errors below are all
                the same error described from the wrong end. */}
            {data.plan.definitionMismatch && (
              <s-banner tone="critical">
                <s-stack direction="block" gap="small-300">
                  <s-paragraph>
                    This file does not match <s-text>{data.plan.type}</s-text>.
                    None of its columns are fields of that definition, so every
                    row would fail.
                  </s-paragraph>
                  <s-paragraph>
                    The file has: {data.plan.unknownColumns.join(", ") || "—"}.
                  </s-paragraph>
                  <s-paragraph>
                    <s-text>{data.plan.type}</s-text> has:{" "}
                    {data.plan.definitionFieldKeys.join(", ") || "no fields"}.
                  </s-paragraph>
                  <s-paragraph>
                    Either pick a different type above, or create the definition
                    this file was built for — import its definition CSV first.
                  </s-paragraph>
                </s-stack>
              </s-banner>
            )}

            {data.plan.unknownColumns.length > 0 &&
              !data.plan.definitionMismatch && (
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

            <TableScroll>
              <s-table variant="auto">
                <s-table-header-row>
                  {/* `listSlot` is what lets `variant="auto"` collapse the
                      table into readable rows on a narrow screen instead of a
                      horizontal scroll: the handle becomes each row's title,
                      the action its badge, the rest labelled detail. */}
                  <s-table-header>Row</s-table-header>
                  <s-table-header listSlot="primary">Handle</s-table-header>
                  <s-table-header listSlot="inline">Action</s-table-header>
                  <s-table-header listSlot="labeled">Details</s-table-header>
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
            </TableScroll>

            <TruncationNote shown={100} total={data.plan.rows.length} />

            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="apply" />
              <input type="hidden" name="kind" value="entries" />
              <input type="hidden" name="type" value={data.type} />
              <input type="hidden" name="csv" value={data.csv} />
              <Actions>
                <s-button
                  type="submit"
                  variant="primary"
                  icon="check"
                  {...(busy ? { loading: true } : {})}
                >
                  Import {data.plan.counts.create + data.plan.counts.update}{" "}
                  entries
                </s-button>
              </Actions>
            </fetcher.Form>
          </s-stack>
        </s-section>
      )}

      {data?.step === "plan-definition" && (
        <s-section heading="Review">
          <s-stack direction="block" gap="base">
            <Steps current={2} />
            <s-banner tone="info">
              <s-paragraph>
                This is a definition CSV, so it creates schemas rather than
                entries. Nothing has been written yet. Existing types are never
                modified — creating one that already exists reports an error
                instead of overwriting it.
              </s-paragraph>
            </s-banner>
            <s-unordered-list>
              {data.summary.map((line) => (
                <s-list-item key={line}>{line}</s-list-item>
              ))}
            </s-unordered-list>

            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="apply" />
              <input type="hidden" name="kind" value="definition" />
              <input type="hidden" name="csv" value={data.csv} />
              <Actions>
                <s-button
                  type="submit"
                  variant="primary"
                  icon="check"
                  {...(busy ? { loading: true } : {})}
                >
                  Create {data.summary.length} definition
                  {data.summary.length === 1 ? "" : "s"}
                </s-button>
              </Actions>
            </fetcher.Form>
          </s-stack>
        </s-section>
      )}

      {data?.step === "applied" && (
        <s-section heading="Import finished">
          <s-stack direction="block" gap="base">
            <Steps current={3} />
            <s-banner tone={data.failures.length ? "warning" : "success"}>
              <s-paragraph>
                {data.created} created, {data.updated} updated,{" "}
                {data.failures.length} failed.
                {data.uploaded > 0 &&
                  ` ${data.uploaded} image(s) uploaded to Files — Shopify finishes processing them a few seconds after this, so one may briefly show as a placeholder in the admin.`}
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
