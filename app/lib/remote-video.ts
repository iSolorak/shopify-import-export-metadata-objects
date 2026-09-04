// Fetching a video from a third-party site and pushing it at a Shopify staged
// upload target.
//
// This exists because of one line in the 2026-07 schema: `FileCreateInput`
// documents that "an external URL can be used for images, generic files, or
// external videos. Videos and 3D models require a staged upload URL." A direct
// .mp4 on someone else's domain therefore cannot be handed to Shopify as a URL
// the way an image can — the bytes have to move through this app.
//
// Kept apart from the GraphQL module because none of it is Shopify-specific:
// this half is an HTTP client with a size budget and an SSRF guard.

import { lookup } from "node:dns/promises";

/**
 * Refuse anything larger than this.
 *
 * Shopify's own ceiling for a product video is 1 GB, but a video is buffered
 * here rather than streamed: a signed GCS upload URL wants a real
 * `Content-Length`, and piping a `fetch` body straight into a `PUT` makes the
 * request chunked instead, which those URLs reject. Buffering keeps the length
 * honest, and this cap is what keeps buffering from being reckless. The videos
 * this was built for top out around 20 MB.
 */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

/** Content types Shopify will accept as a product video. */
const ALLOWED_MIME = new Set(["video/mp4", "video/quicktime", "video/webm"]);

export type VideoProbe = {
  url: string;
  filename: string;
  mimeType: string;
  fileSize: number;
};

export type ProbeResult =
  | ({ ok: true } & VideoProbe)
  | { ok: false; url: string; message: string };

/**
 * Reject addresses that point back inside the network this server sits on.
 *
 * The URL arrives in a merchant-supplied CSV and is fetched by the server, so
 * without this the import is an open proxy into the VPS's own loopback and any
 * private range it can reach.
 */
function isPrivateAddress(address: string): boolean {
  // An IPv4-mapped IPv6 address hides a v4 address the v4 rules below must
  // still see, so unwrap it first.
  const unmapped = address.replace(/^::ffff:/i, "");

  if (/^\d+\.\d+\.\d+\.\d+$/.test(unmapped)) {
    const [a, b] = unmapped.split(".").map(Number);
    return (
      a === 0 || // "this network"
      a === 10 ||
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, incl. cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      a >= 224 // multicast and reserved
    );
  }

  const v6 = unmapped.toLowerCase();
  return (
    v6 === "::" ||
    v6 === "::1" ||
    /^f[cd]/.test(v6) || // unique local
    /^fe[89ab]/.test(v6) // link-local
  );
}

/** Validate the URL and confirm its host is not internal. Throws on refusal. */
async function assertFetchableUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a URL.`);
  }

  if (url.protocol !== "https:") {
    throw new Error(
      `Only https URLs are fetched, and this one is ${url.protocol.replace(":", "")}.`,
    );
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    throw new Error(`Could not resolve ${url.hostname}.`);
  }

  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error(`${url.hostname} resolves to a private address.`);
  }

  return url;
}

/** A filename Shopify will accept, derived from the URL's last path segment. */
function filenameFor(url: URL, fallback: string): string {
  const last = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  const cleaned = last.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+/, "");
  // A bare extension ("-.mp4") or an empty segment is no more useful than the
  // handle, and Shopify shows this name in Content → Files.
  if (cleaned.length > 4 && /\.[A-Za-z0-9]{2,5}$/.test(cleaned)) return cleaned;
  return `${fallback}.mp4`;
}

/**
 * Learn a video's size and type without downloading it.
 *
 * `StagedUploadInput.fileSize` is required when `resource` is `VIDEO`, so the
 * length has to be known before the upload can even be staged — which is also
 * what lets a bad row fail during the plan step instead of halfway through a
 * 200-row run.
 */
export async function probeRemoteVideo(
  rawUrl: string,
  fallbackName: string,
): Promise<ProbeResult> {
  try {
    const url = await assertFetchableUrl(rawUrl);

    let response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });

    // Not every server implements HEAD. A one-byte ranged GET gets the same
    // headers back, plus the full length in Content-Range.
    let fileSize = Number(response.headers.get("content-length") ?? NaN);
    if (!response.ok || !Number.isFinite(fileSize)) {
      response = await fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
      // Drain rather than leave the socket hanging on an unread body.
      await response.arrayBuffer().catch(() => undefined);

      const total = /\/(\d+)\s*$/.exec(
        response.headers.get("content-range") ?? "",
      );
      fileSize = total ? Number(total[1]) : NaN;
    }

    if (!response.ok) {
      return {
        ok: false,
        url: rawUrl,
        message: `The source returned HTTP ${response.status}.`,
      };
    }

    const mimeType = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();

    if (!ALLOWED_MIME.has(mimeType)) {
      return {
        ok: false,
        url: rawUrl,
        message: `The source serves "${mimeType || "an unknown type"}", not a video. Shopify accepts ${[...ALLOWED_MIME].join(", ")}.`,
      };
    }

    if (!Number.isFinite(fileSize) || fileSize <= 0) {
      return {
        ok: false,
        url: rawUrl,
        message:
          "The source does not report a Content-Length, and Shopify requires the exact byte size to stage a video upload.",
      };
    }

    if (fileSize > MAX_VIDEO_BYTES) {
      return {
        ok: false,
        url: rawUrl,
        message: `${(fileSize / 1024 / 1024).toFixed(0)} MB exceeds this app's ${MAX_VIDEO_BYTES / 1024 / 1024} MB limit.`,
      };
    }

    return {
      ok: true,
      url: rawUrl,
      filename: filenameFor(url, fallbackName),
      mimeType,
      fileSize,
    };
  } catch (error) {
    return {
      ok: false,
      url: rawUrl,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Download the video and PUT it at the staged target.
 *
 * Throws on failure: unlike a GraphQL user error, there is no partial success
 * to report here — either the bytes arrived or the row cannot proceed.
 */
export async function uploadRemoteVideo(
  probe: VideoProbe,
  target: { url: string; parameters: { name: string; value: string }[] },
): Promise<void> {
  const source = await fetch(probe.url, {
    redirect: "follow",
    // Generous: this is a whole video over someone else's connection.
    signal: AbortSignal.timeout(180_000),
  });

  if (!source.ok || !source.body) {
    throw new Error(`Downloading the video failed (HTTP ${source.status}).`);
  }

  const bytes = new Uint8Array(await source.arrayBuffer());

  // The probe read the length from a header; this is the length that actually
  // arrived. They differ if the file changed between the two requests, and
  // `stagedUploadsCreate` was told the first number — so the upload would be
  // rejected or silently truncated.
  if (bytes.byteLength !== probe.fileSize) {
    throw new Error(
      `The source served ${bytes.byteLength} bytes but announced ${probe.fileSize}.`,
    );
  }

  // Shopify returns the headers the signed URL expects; for a PUT target that
  // is typically just Content-Type.
  const headers = new Headers();
  for (const parameter of target.parameters) {
    headers.set(parameter.name, parameter.value);
  }
  if (!headers.has("Content-Type")) headers.set("Content-Type", probe.mimeType);
  headers.set("Content-Length", String(bytes.byteLength));

  const upload = await fetch(target.url, {
    method: "PUT",
    headers,
    body: bytes,
    signal: AbortSignal.timeout(180_000),
  });

  if (!upload.ok) {
    const detail = await upload.text().catch(() => "");
    throw new Error(
      `Uploading to Shopify failed (HTTP ${upload.status})${detail ? `: ${detail.slice(0, 200)}` : ""}.`,
    );
  }
}

/**
 * Run `task` over `items` a few at a time, preserving input order.
 *
 * Probes are network-bound and independent, so doing 200 of them one after
 * another is minutes of dead time inside a request that also has videos to
 * move. The limit is low because these all hit the same origin server.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    (async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await task(items[index]);
      }
    })(),
  );

  await Promise.all(workers);
  return results;
}
