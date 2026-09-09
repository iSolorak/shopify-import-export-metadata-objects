// Admin API access for creating store files from source URLs.
//
// Same conventions as the other server modules here — a structural `Admin`
// type, a private `query` that throws on transport errors, `#graphql`-tagged
// documents, and mutations that return their user errors instead of throwing so
// one bad row is reported next to the rows that worked.
//
// Validated against the 2026-07 schema that `app/shopify.server.ts` pins.
//
// Images need none of `remote-video.ts`'s machinery. `FileCreateInput`
// documents that "an external URL can be used for images, generic files, or
// external videos" — only videos and 3D models require a staged upload — so
// Shopify fetches the bytes itself and this app never downloads them. That is
// why there is no size cap, no `Content-Length` requirement and no SSRF guard
// in this file: nothing here makes an outbound request to a merchant URL.

import { createHash } from "node:crypto";

import { imageExtensionOf } from "./file-cells";

/** Structural, for the same reason as in `metaobjects.server.ts`. */
type Admin = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

type UserError = { field: string[] | null; message: string; code?: string | null };
type PageInfo = { hasNextPage: boolean; endCursor: string | null };

/** Filenames per lookup query. Each term is an OR in one search string. */
const LOOKUP_BATCH_SIZE = 10;

/** Files read per page of a lookup. */
const LOOKUP_PAGE_SIZE = 50;

/**
 * Files created per call.
 *
 * `fileCreate` caps a batch at 250. Twenty-five matches the house batch sizes
 * and keeps one failure from taking a large group of unrelated uploads with it.
 */
const CREATE_BATCH_SIZE = 25;

async function query<T>(
  admin: Admin,
  document: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(document, { variables });
  const body = (await response.json()) as {
    data?: T;
    errors?: { message: string }[];
  };

  if (!response.ok || body.errors) {
    const detail = body.errors?.map((error) => error.message).join("; ");
    throw new Error(detail || `Admin API request failed (${response.status})`);
  }

  return body.data as T;
}

function formatUserErrors(userErrors: UserError[]): string[] {
  return userErrors.map((error) =>
    error.field?.length
      ? `${error.field.join(".")}: ${error.message}`
      : error.message,
  );
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Reduce a handle to the characters Shopify accepts in a filename. */
function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "image"
  );
}

/**
 * The filename an uploaded image is stored under.
 *
 * `<handle>-<hash8><ext>`, e.g. `dermatologically-tested-3f9a1c04.jpg`.
 *
 * Both halves are load-bearing. The filename is also the **reuse key** — an
 * import looks for a file of this name before uploading — so a name derived
 * from the handle alone would find the *old* file when a handle is later
 * pointed at a different image, and the new image would silently never import.
 * Hashing the source URL means a changed URL is a changed filename is a new
 * upload. The handle prefix is what keeps Content → Files readable: source
 * filenames in the wild are frequently content hashes carrying nothing a
 * merchant can search for.
 */
export function uploadFilenameFor(handle: string, url: string): string {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 8);
  return `${slug(handle)}-${hash}${imageExtensionOf(url) ?? ".jpg"}`;
}

/** The filename part of a Shopify CDN URL, which carries a `?v=` query. */
function filenameFromCdnUrl(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0];
  return decodeURIComponent(withoutQuery.split("/").pop() ?? "").toLowerCase();
}

// ---------------------------------------------------------------------------
// Looking up files already in the store
// ---------------------------------------------------------------------------

const FILES_BY_FILENAME = `#graphql
  query FilesByFilename($search: String!, $pageSize: Int!, $cursor: String) {
    files(first: $pageSize, query: $search, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        fileStatus
        ... on MediaImage { image { url } }
        ... on GenericFile { url }
      }
    }
  }
`;

type FileNode = {
  id: string;
  fileStatus: string;
  image?: { url: string | null } | null;
  url?: string | null;
};

/**
 * Find files already in the store, by exact filename.
 *
 * This is what makes re-running an import free. Without it every run would
 * upload the same images again, and Shopify would append a UUID to each one —
 * so a weekly price-and-image sheet would silently fill Content → Files with
 * copies.
 *
 * The search is filtered to an **exact** filename afterwards, for the same
 * reason `getProductsForUpdateByTitle` filters titles: Shopify's file search is
 * fuzzy, and reusing the wrong image is precisely the silent damage this app
 * exists to avoid. A file whose processing failed is skipped so a broken
 * earlier upload is replaced rather than reused forever.
 */
export async function findFilesByFilename(
  admin: Admin,
  filenames: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(filenames.map((name) => name.trim()))].filter(
    Boolean,
  );
  const found = new Map<string, string>();
  const wanted = new Set(unique.map((name) => name.toLowerCase()));

  for (let start = 0; start < unique.length; start += LOOKUP_BATCH_SIZE) {
    const batch = unique.slice(start, start + LOOKUP_BATCH_SIZE);
    // Escaped as in the title lookup: a quote would otherwise terminate the
    // term early and turn the rest into stray search syntax.
    const search = batch
      .map((name) => `filename:"${name.replace(/(["\\])/g, "\\$1")}"`)
      .join(" OR ");

    let cursor: string | null = null;
    do {
      const data: {
        files: { pageInfo: PageInfo; nodes: FileNode[] };
      } = await query(admin, FILES_BY_FILENAME, {
        search,
        pageSize: LOOKUP_PAGE_SIZE,
        cursor,
      });

      for (const node of data.files.nodes) {
        if (node.fileStatus === "FAILED") continue;

        const url = node.image?.url ?? node.url ?? "";
        if (!url) continue;

        const name = filenameFromCdnUrl(url);
        if (!wanted.has(name) || found.has(name)) continue;
        found.set(name, node.id);
      }

      cursor = data.files.pageInfo.hasNextPage
        ? data.files.pageInfo.endCursor
        : null;
    } while (cursor);
  }

  return found;
}

// ---------------------------------------------------------------------------
// Creating files
// ---------------------------------------------------------------------------

const FILE_CREATE = `#graphql
  mutation CreateFilesFromUrls($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        fileStatus
        ... on MediaImage { image { url } }
      }
      userErrors { field message code }
    }
  }
`;

export type FileUpload = {
  /** The source URL, and the key the resolved gid is returned under. */
  url: string;
  filename: string;
  alt: string;
};

type CreatedFile = {
  id: string;
  fileStatus: string;
  image?: { url: string | null } | null;
};

/**
 * Create files from their source URLs.
 *
 * Returns the gids keyed by source URL, plus one message per upload that
 * failed, so a single unreachable image does not abort an import that has
 * twenty good rows in it.
 *
 * `duplicateResolutionMode` is left at its `APPEND_UUID` default. The filename
 * lookup has already claimed anything that existed, so a collision here means
 * two genuinely different images produced the same name — appending a UUID
 * keeps both, where `REPLACE` would destroy one.
 *
 * Nothing waits for processing to finish. `fileCreate` returns the gid straight
 * away with `fileStatus: UPLOADED`, and the metaobject reference holds from
 * that moment; the image becomes `READY` seconds later, which is why the
 * finished-import banner says so.
 */
export async function createFilesFromUrls(
  admin: Admin,
  uploads: FileUpload[],
): Promise<{ resolved: Map<string, string>; errors: string[] }> {
  const resolved = new Map<string, string>();
  const errors: string[] = [];

  for (let start = 0; start < uploads.length; start += CREATE_BATCH_SIZE) {
    const batch = uploads.slice(start, start + CREATE_BATCH_SIZE);

    const data = await query<{
      fileCreate: { files: CreatedFile[] | null; userErrors: UserError[] };
    }>(admin, FILE_CREATE, {
      files: batch.map((upload) => ({
        originalSource: upload.url,
        contentType: "IMAGE",
        filename: upload.filename,
        ...(upload.alt ? { alt: upload.alt } : {}),
      })),
    });

    const { files, userErrors } = data.fileCreate;
    errors.push(...formatUserErrors(userErrors));

    // `fileCreate` returns the created files in input order, so a partial
    // batch is matched positionally. Anything short of a full result leaves the
    // remaining URLs unresolved, which the caller reports as a pending upload
    // rather than writing a wrong gid.
    (files ?? []).forEach((file, index) => {
      const upload = batch[index];
      if (!upload || !file?.id) return;
      resolved.set(upload.url, file.id);
    });
  }

  return { resolved, errors };
}
