// The product-video CSV shape and its dry-run planner.
//
// Mirrors `rich-text-csv.ts`: decide what every row would do before a single
// byte moves. That matters more here than anywhere else in the app, because the
// apply step downloads and re-uploads whole videos — finding out on row 180
// that a handle was wrong is expensive in a way a failed metafield write is not.

import type { ProductMedia } from "./product-media.server";
import type { ProbeResult } from "./remote-video";

/** The columns a file must supply, in the form the UI quotes back to a merchant. */
export const HANDLE_COLUMN = "Handle";
export const TITLE_COLUMN = "Title";
export const VIDEO_URL_COLUMN = "Video URL";

/**
 * Reduce a header to its comparable form.
 *
 * The file this was built for comes out of a spreadsheet as `Handle,Title,Video
 * URL`, but the same file re-saved elsewhere may say `video_url` or `videoUrl`.
 * Matching on letters and digits alone accepts all of them without keeping a
 * list of spellings.
 */
function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export type ColumnMap = {
  handle: string;
  title: string;
  videoUrl: string;
};

/**
 * Find the three columns in a header row, whatever they are spelled like.
 * Returns the header names as they actually appear, so records can be read with
 * them. Null when a required column is absent.
 */
export function resolveColumns(headers: string[]): ColumnMap | null {
  const byNormalized = new Map(
    headers.map((header) => [normalizeHeader(header), header]),
  );

  const handle = byNormalized.get("handle");
  const title = byNormalized.get("title");
  const videoUrl = byNormalized.get("videourl");

  if (!handle || !title || !videoUrl) return null;
  return { handle, title, videoUrl };
}

export type VideoRowPlan = {
  rowNumber: number;
  handle: string;
  title: string;
  url: string;
  /** Resolved once the handle matched a product. */
  productId?: string;
  action: "add" | "skip" | "error";
  message?: string;
  /** Bytes to be moved, for the size estimate shown before applying. */
  fileSize?: number;
};

export type VideoImportPlan = {
  rows: VideoRowPlan[];
  counts: { add: number; skip: number; error: number };
  /** Rows the apply step would actually upload. */
  writeCount: number;
  /** Total bytes those rows would download and re-upload. */
  totalBytes: number;
};

/**
 * Decide what each row would do, without writing anything.
 *
 * `probes` is keyed by URL and supplied by the caller rather than gathered
 * here, so this stays a pure function over already-collected facts — the same
 * split the other planners in this app use.
 */
export function planVideoImport(
  records: Record<string, string>[],
  columns: ColumnMap,
  products: Map<string, ProductMedia>,
  probes: Map<string, ProbeResult>,
): VideoImportPlan {
  const seenHandles = new Set<string>();

  const rows: VideoRowPlan[] = records.map((record, index) => {
    // +2: one for the header row, one because spreadsheets number from 1.
    const rowNumber = index + 2;
    const handle = (record[columns.handle] ?? "").trim();
    const title = (record[columns.title] ?? "").trim();
    const url = (record[columns.videoUrl] ?? "").trim();
    const base = { rowNumber, handle, title, url };

    if (!handle) {
      return {
        ...base,
        action: "error" as const,
        message: `Missing ${HANDLE_COLUMN}. It decides which product the video is added to.`,
      };
    }
    if (!url) {
      return {
        ...base,
        action: "error" as const,
        message: `Missing ${VIDEO_URL_COLUMN}.`,
      };
    }
    if (!title) {
      return {
        ...base,
        action: "error" as const,
        message: `Missing ${TITLE_COLUMN}. It becomes the video's alt text, which is also how a re-run recognises the video as already added.`,
      };
    }

    // Two rows for one product would attach two videos, and the second run
    // would then see the first row's alt text and skip both. Refuse instead of
    // creating that inconsistency.
    if (seenHandles.has(handle)) {
      return {
        ...base,
        action: "error" as const,
        message: `Duplicate row for "${handle}" — an earlier row already adds a video to this product.`,
      };
    }
    seenHandles.add(handle);

    const product = products.get(handle);
    if (!product) {
      return {
        ...base,
        action: "error" as const,
        message: `No product with the handle "${handle}".`,
      };
    }

    // The dedupe check, and the reason a 200-row import is safe to re-run: the
    // alt text is the only durable mark this app leaves on the media, since
    // Shopify re-hosts the video under its own CDN URL and forgets where it
    // came from.
    if (product.videoAlts.includes(title.toLowerCase())) {
      return {
        ...base,
        productId: product.id,
        action: "skip" as const,
        message: `"${product.title}" already has a video with this alt text.`,
      };
    }

    const probe = probes.get(url);
    if (!probe) {
      return {
        ...base,
        productId: product.id,
        action: "error" as const,
        message: "The video URL was not checked.",
      };
    }
    if (!probe.ok) {
      return {
        ...base,
        productId: product.id,
        action: "error" as const,
        message: probe.message,
      };
    }

    return {
      ...base,
      productId: product.id,
      action: "add" as const,
      fileSize: probe.fileSize,
    };
  });

  const counts = { add: 0, skip: 0, error: 0 };
  for (const row of rows) counts[row.action]++;

  const totalBytes = rows.reduce(
    (total, row) => total + (row.action === "add" ? (row.fileSize ?? 0) : 0),
    0,
  );

  return { rows, counts, writeCount: counts.add, totalBytes };
}

/** Size for the UI, in the units a merchant reads rather than bytes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
