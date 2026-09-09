// Reading the `file_reference` cells of a metaobject entries CSV.
//
// A file reference field stores a gid, and that is what this app's export
// writes: `gid://shopify/MediaImage/123` for a single reference, and the
// bracketed JSON array `["gid://…","gid://…"]` for a list. Round-tripping an
// unedited export therefore has to leave those cells exactly as they are.
//
// A merchant filling the sheet by hand has neither form. They have the URL of
// an image on their own website, and no way to turn it into a gid without
// leaving the app, uploading through Content → Files, and copying the id back.
// So a cell that is not already a gid is read as one or more source URLs, which
// the caller uploads and resolves before the value is written.
//
// Pure, like the other parsing modules here: it is handed a map of already
// resolved URLs and reports which ones are still missing. Nothing fetches.

/** The metaobject field types whose value is a file gid. */
export const FILE_FIELD_TYPES = ["file_reference", "list.file_reference"];

export function isFileFieldType(type: string): boolean {
  return FILE_FIELD_TYPES.includes(type);
}

/**
 * A Shopify file gid.
 *
 * Deliberately not pinned to `MediaImage`: a `file_reference` can hold a
 * `GenericFile` or a `Video` too, and a cell already holding one of those is
 * none of this module's business — it passes through like any other gid.
 */
const GID = /^gid:\/\/shopify\/[A-Za-z]+\/\d+$/;

export function isGid(value: string): boolean {
  return GID.test(value.trim());
}

/**
 * Extensions Shopify recognises as an image.
 *
 * A URL that does not end in one is rejected rather than uploaded. The
 * alternative is a `HEAD` from this server to read the content type, which
 * costs a network round trip per row during planning and turns the importer
 * into an HTTP client pointed at merchant-supplied URLs. `fileCreate` is given
 * an explicit filename so that Content → Files stays readable, and a filename
 * needs an extension — so the extension has to be known before the upload, not
 * discovered during it.
 */
const IMAGE_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".avif",
  ".heic",
  ".bmp",
  ".ico",
  ".tiff",
  ".svg",
];

/** The lowercased extension of a URL's last path segment, or null. */
export function imageExtensionOf(rawUrl: string): string | null {
  let path: string;
  try {
    path = new URL(rawUrl).pathname;
  } catch {
    return null;
  }

  const last = decodeURIComponent(path.split("/").pop() ?? "").toLowerCase();
  return IMAGE_EXTENSIONS.find((extension) => last.endsWith(extension)) ?? null;
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/**
 * Is the cell already exactly what the API stores?
 *
 * True for a bare gid and for a JSON array of gids — the two shapes the export
 * produces. Such a cell is passed through byte for byte, which is what keeps a
 * re-import of an unedited export a no-op.
 */
export function isResolvedFileValue(cell: string): boolean {
  const trimmed = cell.trim();
  if (!trimmed) return false;
  if (isGid(trimmed)) return true;

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((entry) => typeof entry === "string" && isGid(entry))
      );
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * The source URLs a cell refers to, for gathering before an import runs.
 *
 * A cell already holding gids yields nothing. Anything else is split on `;`,
 * the separator the metaobject-reference columns already use, and the parts
 * that look like URLs are returned. A part that is neither a gid nor a URL is
 * not reported here — it becomes a per-row error in `toFileValue`, where there
 * is a row number to name.
 */
export function fileUrlsIn(cell: string): string[] {
  const trimmed = cell.trim();
  if (!trimmed || isResolvedFileValue(trimmed)) return [];

  return trimmed
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && looksLikeUrl(part));
}

export type FileCellResult =
  | {
      ok: true;
      /** The value to write, or the cell unchanged while uploads are pending. */
      value: string;
      /** URLs with no gid yet. Non-empty means this cell cannot be written. */
      pending: string[];
    }
  | { ok: false; message: string };

/**
 * Turn a cell into the value the API expects, given the URLs resolved so far.
 *
 * Returns a message rather than throwing, so one bad cell becomes one error row
 * beside the fields that did import — the same contract as `toMetafieldValue`
 * in `product-write.server.ts`.
 *
 * `pending` is how the plan step stays honest. A URL that has not been uploaded
 * yet has no gid to write, so the cell is reported as pending rather than
 * guessed at; the caller uploads, then plans again with a fuller map.
 */
export function toFileValue(
  fieldType: string,
  cell: string,
  resolved: Map<string, string>,
): FileCellResult {
  const trimmed = cell.trim();
  const isList = fieldType === "list.file_reference";

  // Already stored form: pass through byte for byte.
  if (isResolvedFileValue(trimmed)) {
    return { ok: true, value: trimmed, pending: [] };
  }

  const parts = trimmed
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.length) {
    return { ok: false, message: "Empty file reference." };
  }

  if (!isList && parts.length > 1) {
    return {
      ok: false,
      message: `This field holds one file, but ${parts.length} were given. Separate values with ";" only on a list field.`,
    };
  }

  const ids: string[] = [];
  const pending: string[] = [];

  for (const part of parts) {
    if (isGid(part)) {
      ids.push(part);
      continue;
    }

    if (!looksLikeUrl(part)) {
      return {
        ok: false,
        message: `"${truncate(part)}" is neither a file gid nor an http(s) URL.`,
      };
    }

    if (!imageExtensionOf(part)) {
      return {
        ok: false,
        message: `"${truncate(part)}" does not end in an image extension (${IMAGE_EXTENSIONS.slice(0, 5).join(", ")}…), so it cannot be uploaded. Link directly to the image file.`,
      };
    }

    const id = resolved.get(part);
    if (id) {
      ids.push(id);
      continue;
    }
    pending.push(part);
  }

  // Nothing to write until every URL in the cell has a gid — a half-resolved
  // list would silently drop the images still waiting.
  if (pending.length) return { ok: true, value: trimmed, pending };

  return {
    ok: true,
    value: isList ? JSON.stringify(ids) : ids[0],
    pending: [],
  };
}

function truncate(value: string, limit = 60): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}
