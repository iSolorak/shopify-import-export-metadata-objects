import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher } from "react-router";

import { authenticate } from "../shopify.server";
import { parseCsv, rowsToRecords } from "../lib/csv";
import {
  attachVideoToProduct,
  getProductsByHandles,
  stageVideoUpload,
} from "../lib/product-media.server";
import {
  HANDLE_COLUMN,
  TITLE_COLUMN,
  VIDEO_URL_COLUMN,
  formatBytes,
  planVideoImport,
  resolveColumns,
  type ColumnMap,
  type VideoImportPlan,
} from "../lib/product-video-csv";
import {
  mapWithConcurrency,
  probeRemoteVideo,
  uploadRemoteVideo,
  type ProbeResult,
} from "../lib/remote-video";
import styles from "./app._index/styles.module.css";

// Add videos hosted on another site to products' media galleries.
//
// The two-step plan/apply flow matches the other import pages. It earns its
// keep more here than anywhere else: applying moves entire video files, so
// every problem that can be found without transferring a byte — an unknown
// handle, a dead URL, a video that is already attached — is found first.
type ActionData =
  | { step: "plan"; plan: VideoImportPlan; csv: string }
  | { step: "applied"; added: number; failures: string[] }
  | { step: "error"; message: string };

/**
 * Rows per run.
 *
 * The binding limit is not the row count but the wall clock: each row is a
 * download and an upload, and `deploy/nginx/shopify-app.conf` gives the request
 * 300 seconds. A full 200 rows of large video will not fit in that — see the
 * warning the plan step shows once the estimate gets close.
 */
const MAX_ROWS = 200;

/** How far past the nginx budget an estimate may go before we warn. */
const SLOW_ESTIMATE_BYTES = 150 * 1024 * 1024;

/** Simultaneous probes. Low: they all hit the same origin server. */
const PROBE_CONCURRENCY = 8;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

type Admin = Parameters<typeof getProductsByHandles>[0];

/**
 * Turn CSV text into a plan.
 *
 * Shared by both steps so that "apply" re-derives the plan from the store as it
 * is now rather than trusting what the browser echoes back — the same reasoning
 * as the rich text page, with the extra weight that a stale plan here would
 * re-upload videos that another run already attached.
 */
async function buildPlan(
  admin: Admin,
  csv: string,
): Promise<
  | { ok: true; plan: VideoImportPlan; columns: ColumnMap }
  | { ok: false; message: string }
> {
  const rows = parseCsv(csv);
  if (rows.length < 2) {
    return { ok: false, message: "That file has a header row but no data rows." };
  }

  const columns = resolveColumns(rows[0].map((header) => header.trim()));
  if (!columns) {
    return {
      ok: false,
      message: `This file needs "${HANDLE_COLUMN}", "${TITLE_COLUMN}" and "${VIDEO_URL_COLUMN}" columns. Found: ${rows[0].join(", ")}.`,
    };
  }

  const records = rowsToRecords(rows);
  if (records.length > MAX_ROWS) {
    return {
      ok: false,
      message: `That file has ${records.length} rows. Import at most ${MAX_ROWS} at a time — each row transfers a whole video.`,
    };
  }

  const products = await getProductsByHandles(
    admin,
    records.map((record) => record[columns.handle] ?? ""),
  );

  // Probe each distinct URL once. The source file routinely reuses one video
  // across a group of related products — five of the twenty-five rows it was
  // built for share a single 10 MB file.
  const urls = [
    ...new Set(
      records
        .map((record) => (record[columns.videoUrl] ?? "").trim())
        .filter(Boolean),
    ),
  ];
  const probed = await mapWithConcurrency(urls, PROBE_CONCURRENCY, (url) =>
    probeRemoteVideo(url, "video"),
  );
  const probes = new Map<string, ProbeResult>(
    urls.map((url, index) => [url, probed[index]]),
  );

  return {
    ok: true,
    plan: planVideoImport(records, columns, products, probes),
    columns,
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  try {
    // --- Step 1: read the file and report what it would do ------------------
    if (intent === "plan") {
      const file = formData.get("file");
      if (!(file instanceof File) || file.size === 0) {
        return { step: "error", message: "Choose a CSV file first." } as const;
      }

      const csv = await file.text();
      const built = await buildPlan(admin, csv);
      if (!built.ok) return { step: "error", message: built.message } as const;

      return { step: "plan", plan: built.plan, csv } as const;
    }

    // --- Step 2: move the videos --------------------------------------------
    if (intent === "apply") {
      const csv = String(formData.get("csv") ?? "");
      const built = await buildPlan(admin, csv);
      if (!built.ok) return { step: "error", message: built.message } as const;

      const failures: string[] = [];
      let added = 0;

      // Strictly sequential. Not just the house style for the rate limit: each
      // iteration holds a whole video in memory, and overlapping them would
      // multiply that by the concurrency.
      for (const row of built.plan.rows) {
        if (row.action === "error") {
          failures.push(`Row ${row.rowNumber} (${row.handle}): ${row.message}`);
          continue;
        }
        if (row.action !== "add" || !row.productId) continue;

        const label = `Row ${row.rowNumber} (${row.handle})`;

        try {
          // Re-probed rather than carried over from the plan: the staged upload
          // is told a byte count up front, and it has to be the count of the
          // bytes actually about to be sent.
          const probe = await probeRemoteVideo(row.url, row.handle);
          if (!probe.ok) {
            failures.push(`${label}: ${probe.message}`);
            continue;
          }

          const target = await stageVideoUpload(admin, {
            filename: probe.filename,
            mimeType: probe.mimeType,
            fileSize: probe.fileSize,
          });

          await uploadRemoteVideo(probe, target);

          const result = await attachVideoToProduct(
            admin,
            row.productId,
            target.resourceUrl,
            row.title,
          );

          if (result.ok) added++;
          else failures.push(`${label}: ${result.errors.join("; ")}`);
        } catch (error) {
          failures.push(
            `${label}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      return { step: "applied", added, failures } as const;
    }

    return { step: "error", message: "Unknown action." } as const;
  } catch (error) {
    return {
      step: "error",
      message: error instanceof Error ? error.message : String(error),
    } as const;
  }
};

export default function ProductVideosPage() {
  const fetcher = useFetcher<ActionData>();

  const data = fetcher.data;
  const busy = fetcher.state !== "idle";

  return (
    <s-page heading="Add product videos">
      <s-section heading="Import">
        <fetcher.Form method="post" encType="multipart/form-data">
          <input type="hidden" name="intent" value="plan" />
          <s-stack direction="block" gap="base">
            <s-paragraph>
              A CSV with <s-text>{HANDLE_COLUMN}</s-text>,{" "}
              <s-text>{TITLE_COLUMN}</s-text> and{" "}
              <s-text>{VIDEO_URL_COLUMN}</s-text> columns. Each row&rsquo;s video
              is downloaded from its URL and added to that product&rsquo;s media
              gallery. Extra columns are ignored.
            </s-paragraph>

            <s-paragraph>
              Shopify will not accept a video by URL the way it accepts an image,
              so the file is fetched here and re-uploaded. The URL must be{" "}
              <strong>https</strong> and serve an <s-text>.mp4</s-text>,{" "}
              <s-text>.mov</s-text> or <s-text>.webm</s-text> with a
              Content-Length.
            </s-paragraph>

            <s-paragraph>
              The <s-text>{TITLE_COLUMN}</s-text> becomes the video&rsquo;s{" "}
              <strong>alt text</strong>, and re-running the same file{" "}
              <strong>skips</strong> any product that already has a video with
              that alt text — so a large import can be run again safely if it
              does not finish.
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
        <s-section heading="Review — nothing has been uploaded yet">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small-300">
              <s-badge tone="info">{data.plan.counts.add} to add</s-badge>
              <s-badge tone="neutral">
                {data.plan.counts.skip} already present
              </s-badge>
              {data.plan.counts.error > 0 && (
                <s-badge tone="critical">
                  {data.plan.counts.error} with errors
                </s-badge>
              )}
            </s-stack>

            {data.plan.writeCount > 0 && (
              <s-banner
                tone={
                  data.plan.totalBytes > SLOW_ESTIMATE_BYTES ? "warning" : "info"
                }
              >
                <s-paragraph>
                  {formatBytes(data.plan.totalBytes)} to download and re-upload.
                  {data.plan.totalBytes > SLOW_ESTIMATE_BYTES
                    ? " That may take longer than the server allows one request to run. If it times out, run the same file again — everything already added will be skipped."
                    : ""}
                </s-paragraph>
              </s-banner>
            )}

            {/* A wide plan table would otherwise push the whole embedded page
                sideways on a narrow screen. */}
            <div className={styles.tableScroll}>
              <s-table>
                <s-table-header-row>
                  <s-table-header>Row</s-table-header>
                  <s-table-header>Handle</s-table-header>
                  <s-table-header>Action</s-table-header>
                  <s-table-header>Size</s-table-header>
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
                              : row.action === "add"
                                ? "info"
                                : "neutral"
                          }
                        >
                          {row.action}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        {row.fileSize ? formatBytes(row.fileSize) : ""}
                      </s-table-cell>
                      <s-table-cell>{row.message ?? row.title}</s-table-cell>
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
                  Add {data.plan.writeCount} video(s)
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
                {data.added} video(s) added, {data.failures.length} failed.
                Shopify transcodes videos in the background, so they show as
                &ldquo;Processing&rdquo; on the product for a few minutes before
                they play.
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
