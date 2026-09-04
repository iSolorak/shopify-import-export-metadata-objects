// Admin API access for cross-mapping metafield translations.
//
// A translations export identifies a metafield row by nothing but the metafield
// ID — no product, no namespace, no key:
//
//     METAFIELD,77312718307671,value,ro,,,{"type":"root",…},
//
// Neither CSV says which product that belongs to, so the link has to come from
// the store. That is the only reason this feature touches the API at all.
//
// The work is split so the expensive half is skipped whenever possible:
//
//   `listProductMetafieldDefinitions` — one cheap paged query, used to populate
//   the mapping dropdown. Runs on every submit.
//
//   `resolveMetafieldOwners` — the ID → product lookup, one request per 100
//   IDs. Runs only at build time, and only when a metafield was actually
//   mapped. Mapping nothing but product fields costs zero extra requests.
//
// Needs `read_products`, which the app's existing `write_products` already
// grants, so this adds no scope.

/** Structural, matching the other server modules in this app. */
type Admin = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

/** The metafield type whose value is stored as rich text JSON. */
export const RICH_TEXT_TYPE = "rich_text_field";

export type MetafieldDefinition = {
  namespace: string;
  key: string;
  name: string;
  type: string;
  /** `namespace.key` — how a metafield is addressed throughout this feature. */
  column: string;
};

export type MetafieldOwner = {
  /** The numeric product ID, matching the translations CSV's `Identification`. */
  productId: string;
  /** `namespace.key`. */
  column: string;
};

type PageInfo = { hasNextPage: boolean; endCursor: string | null };

/**
 * IDs per `nodes` call.
 *
 * Well under the 250 the field allows: each node drags an `owner` resolution
 * behind it, and the query cost is charged on what is fetched rather than what
 * is asked for. A catalogue's worth of metafields is a handful of requests
 * either way, so the smaller batch buys safety for nothing.
 */
const RESOLVE_BATCH_SIZE = 100;

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

const DEFINITIONS = `#graphql
  query TranslationMetafieldDefinitions($cursor: String) {
    metafieldDefinitions(ownerType: PRODUCT, first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        namespace
        key
        type { name }
      }
    }
  }
`;

type DefinitionsResponse = {
  metafieldDefinitions: {
    pageInfo: PageInfo;
    nodes: {
      name: string;
      namespace: string;
      key: string;
      type: { name: string };
    }[];
  };
};

/**
 * Every product metafield definition on the store, for the mapping dropdown.
 *
 * Unlike the rich text page this keeps all types, not just `rich_text_field`:
 * a translation can go into a plain text metafield just as well, and which
 * ones matter is the user's choice, not this module's.
 */
export async function listProductMetafieldDefinitions(
  admin: Admin,
): Promise<MetafieldDefinition[]> {
  const definitions: MetafieldDefinition[] = [];
  let cursor: string | null = null;

  do {
    const data: DefinitionsResponse = await query<DefinitionsResponse>(
      admin,
      DEFINITIONS,
      { cursor },
    );
    const connection = data.metafieldDefinitions;

    for (const node of connection.nodes) {
      definitions.push({
        namespace: node.namespace,
        key: node.key,
        name: node.name,
        type: node.type.name,
        column: `${node.namespace}.${node.key}`,
      });
    }

    cursor = connection.pageInfo.hasNextPage
      ? connection.pageInfo.endCursor
      : null;
  } while (cursor);

  return definitions.sort((a, b) => a.column.localeCompare(b.column));
}

const RESOLVE = `#graphql
  query ResolveMetafieldOwners($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Metafield {
        id
        namespace
        key
        owner {
          ... on Product {
            id
          }
        }
      }
    }
  }
`;

type ResolveResponse = {
  nodes: ({
    id: string;
    namespace: string;
    key: string;
    owner: { id?: string } | null;
  } | null)[];
};

/** `gid://shopify/Product/123` → `123`, which is what the CSV carries. */
function numericId(gid: string): string {
  return gid.slice(gid.lastIndexOf("/") + 1);
}

/**
 * Look up which product each metafield ID belongs to, and under what key.
 *
 * IDs that do not resolve are simply absent from the result. That is the normal
 * outcome for a metafield deleted since the export was taken, and for every row
 * if the translations file came from a different store than the one the app is
 * installed on — the caller reports the count rather than failing the run.
 *
 * Owners that are not products are skipped too: a translations export covers
 * collections and pages as well, and this feature only matches products.
 */
export async function resolveMetafieldOwners(
  admin: Admin,
  ids: string[],
): Promise<Map<string, MetafieldOwner>> {
  const owners = new Map<string, MetafieldOwner>();
  const unique = [...new Set(ids.filter(Boolean))];

  for (let start = 0; start < unique.length; start += RESOLVE_BATCH_SIZE) {
    const batch = unique.slice(start, start + RESOLVE_BATCH_SIZE);
    const data = await query<ResolveResponse>(admin, RESOLVE, {
      ids: batch.map((id) => `gid://shopify/Metafield/${id}`),
    });

    for (const node of data.nodes) {
      // A null node is an ID that no longer exists; a node without an owner id
      // is one owned by something other than a product, since `owner` is only
      // spread on Product above.
      if (!node?.owner?.id) continue;

      owners.set(numericId(node.id), {
        productId: numericId(node.owner.id),
        column: `${node.namespace}.${node.key}`,
      });
    }
  }

  return owners;
}
