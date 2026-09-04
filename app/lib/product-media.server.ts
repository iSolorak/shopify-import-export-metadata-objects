// Admin API access for adding videos to a product's media gallery.
//
// Same conventions as `metaobjects.server.ts` and `product-metafields.server.ts`
// — a structural `Admin` type, a private `query` helper, `#graphql`-tagged
// documents, and mutations that return their user errors instead of throwing so
// one bad row is reported next to the rows that worked.
//
// Validated against the 2026-07 schema that `app/shopify.server.ts` pins.

/** Structural, for the same reason as in `metaobjects.server.ts`. */
type Admin = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

type UserError = { field: string[] | null; message: string; code: string | null };

/**
 * Handles per lookup query.
 *
 * Each alias pulls a product plus up to 50 of its media, so the query cost adds
 * up faster than the field count suggests. Ten keeps a batch comfortably inside
 * the cost budget while still cutting 200 handles down to 20 round trips.
 */
export const HANDLE_BATCH_SIZE = 10;

/** Media read per product when checking what is already attached. */
const MEDIA_PAGE_SIZE = 50;

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

export type ProductMedia = {
  id: string;
  handle: string;
  title: string;
  /** Alt text of the videos already on this product, lowercased and trimmed. */
  videoAlts: string[];
};

type ProductNode = {
  id: string;
  handle: string;
  title: string;
  media: {
    nodes: { alt: string | null; mediaContentType: string }[];
  };
} | null;

/**
 * Resolve CSV handles to products, along with the videos already attached.
 *
 * `productByIdentifier` is used rather than the `products(query:)` search the
 * rich text import uses: search matches handles loosely, and attaching a video
 * to a near-miss product is the failure this feature can least afford. The
 * tradeoff is one aliased field per handle, hence the batching.
 *
 * Handles are passed as GraphQL variables rather than interpolated, so a handle
 * containing quotes cannot break out into the query body.
 */
export async function getProductsByHandles(
  admin: Admin,
  handles: string[],
): Promise<Map<string, ProductMedia>> {
  const unique = [...new Set(handles.map((handle) => handle.trim()))].filter(
    Boolean,
  );
  const found = new Map<string, ProductMedia>();

  for (let start = 0; start < unique.length; start += HANDLE_BATCH_SIZE) {
    const batch = unique.slice(start, start + HANDLE_BATCH_SIZE);

    const declarations = batch
      .map((_, index) => `$h${index}: String!`)
      .join(", ");
    const selections = batch
      .map(
        (_, index) => `
        p${index}: productByIdentifier(identifier: { handle: $h${index} }) {
          id
          handle
          title
          media(first: ${MEDIA_PAGE_SIZE}) {
            nodes { alt mediaContentType }
          }
        }`,
      )
      .join("");

    const document = `#graphql
      query ProductsByHandleForMedia(${declarations}) {${selections}
      }
    `;

    const variables: Record<string, string> = {};
    batch.forEach((handle, index) => {
      variables[`h${index}`] = handle;
    });

    const data = await query<Record<string, ProductNode>>(
      admin,
      document,
      variables,
    );

    batch.forEach((handle, index) => {
      const node = data[`p${index}`];
      if (!node) return;
      found.set(handle, {
        id: node.id,
        handle: node.handle,
        title: node.title,
        videoAlts: node.media.nodes
          .filter((media) => media.mediaContentType === "VIDEO")
          .map((media) => (media.alt ?? "").trim().toLowerCase()),
      });
    });
  }

  return found;
}

const STAGE_UPLOAD = `#graphql
  mutation StageProductVideoUpload($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }
`;

export type StagedTarget = {
  url: string;
  resourceUrl: string;
  parameters: { name: string; value: string }[];
};

/**
 * Reserve an upload slot for one video.
 *
 * A VIDEO resource always comes back as a Google Cloud Storage POST target,
 * whatever `httpMethod` asks for, so the caller must send the bytes as a signed
 * multipart form (see `uploadRemoteVideo`). `fileSize` is not optional here —
 * the schema requires it whenever `resource` is VIDEO.
 *
 * Throws rather than returning user errors, because unlike a per-row data
 * problem there is nothing partial to report: without a target the row cannot
 * proceed at all.
 */
export async function stageVideoUpload(
  admin: Admin,
  video: { filename: string; mimeType: string; fileSize: number },
): Promise<StagedTarget> {
  const data = await query<{
    stagedUploadsCreate: {
      stagedTargets: StagedTarget[];
      userErrors: { field: string[] | null; message: string }[];
    };
  }>(admin, STAGE_UPLOAD, {
    input: [
      {
        filename: video.filename,
        mimeType: video.mimeType,
        resource: "VIDEO",
        fileSize: String(video.fileSize),
      },
    ],
  });

  const { stagedTargets, userErrors } = data.stagedUploadsCreate;

  if (userErrors.length) {
    throw new Error(
      formatUserErrors(
        userErrors.map((error) => ({ ...error, code: null })),
      ).join("; "),
    );
  }

  const target = stagedTargets[0];
  if (!target?.url || !target.resourceUrl) {
    throw new Error("Shopify returned no upload target for this video.");
  }

  return target;
}

// `productUpdate` rather than `productCreateMedia`: the latter is deprecated on
// this API version, which points at `productUpdate` or `productSet` instead.
// Passing only the id in `product` adds the media without touching anything
// else about the product.
const ATTACH_MEDIA = `#graphql
  mutation AttachProductVideo(
    $product: ProductUpdateInput!
    $media: [CreateMediaInput!]
  ) {
    productUpdate(product: $product, media: $media) {
      product { id }
      userErrors { field message }
    }
  }
`;

/**
 * Attach an uploaded video to a product's gallery.
 *
 * `resourceUrl` is the staged upload's handle, not a public URL — Shopify
 * resolves it internally. Nothing here waits for the video to be playable:
 * transcoding runs asynchronously and can take minutes, so the media comes back
 * `UPLOADED` and becomes `READY` long after this request has returned.
 */
export async function attachVideoToProduct(
  admin: Admin,
  productId: string,
  resourceUrl: string,
  alt: string,
): Promise<{ ok: boolean; errors: string[] }> {
  const data = await query<{
    productUpdate: {
      userErrors: { field: string[] | null; message: string }[];
    };
  }>(admin, ATTACH_MEDIA, {
    product: { id: productId },
    media: [
      {
        mediaContentType: "VIDEO",
        originalSource: resourceUrl,
        alt,
      },
    ],
  });

  const { userErrors } = data.productUpdate;

  return {
    ok: userErrors.length === 0,
    errors: formatUserErrors(
      userErrors.map((error) => ({ ...error, code: null })),
    ),
  };
}
