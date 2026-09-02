// Admin API access for the product rich text metafield import/export.
//
// Kept separate from `metaobjects.server.ts` because the two features share no
// queries: this one works on products and metafield definitions, that one on
// metaobjects. The `Admin` shape and the error handling are the same, and are
// duplicated rather than shared so neither module constrains the other.

/** Structural, for the same reason as in `metaobjects.server.ts`. */
type Admin = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

/** The metafield type this feature exists for. */
export const RICH_TEXT_TYPE = "rich_text_field";

export type RichTextDefinition = {
  id: string;
  namespace: string;
  key: string;
  name: string;
  /** `namespace.key` — how a metafield is addressed, and the CSV column name. */
  column: string;
};

export type ProductRichText = {
  id: string;
  title: string;
  handle: string;
  /** Stored value per `namespace.key`, as the API returns it (rich text JSON). */
  values: Record<string, string>;
};

type PageInfo = { hasNextPage: boolean; endCursor: string | null };
type UserError = { field: string[] | null; message: string; code: string | null };

// Metafield lookups are the expensive part of the product query, so this pages
// smaller than the 250 the connection allows to stay inside the query cost
// budget on stores with many rich text definitions.
const PRODUCT_PAGE_SIZE = 50;

/** Titles per search query. Shopify caps the search string length, and a long
 *  OR chain is also the slowest kind of query to run. */
const TITLE_BATCH_SIZE = 20;

/** `metafieldsSet` accepts at most 25 metafields per call. */
const METAFIELD_BATCH_SIZE = 25;

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
// Definitions
// ---------------------------------------------------------------------------

const DEFINITIONS = `#graphql
  query ProductRichTextDefinitions($cursor: String) {
    metafieldDefinitions(ownerType: PRODUCT, first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
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
      id: string;
      name: string;
      namespace: string;
      key: string;
      type: { name: string };
    }[];
  };
};

/**
 * Every rich text metafield defined on products.
 *
 * Only defined metafields are listed. A value can technically be written to an
 * undefined namespace/key, but it would be invisible in the admin, so offering
 * that would mostly be a way to lose data.
 */
export async function listRichTextDefinitions(
  admin: Admin,
): Promise<RichTextDefinition[]> {
  const definitions: RichTextDefinition[] = [];
  let cursor: string | null = null;

  do {
    const data: DefinitionsResponse = await query<DefinitionsResponse>(
      admin,
      DEFINITIONS,
      { cursor },
    );
    const connection = data.metafieldDefinitions;

    for (const node of connection.nodes) {
      if (node.type.name !== RICH_TEXT_TYPE) continue;
      definitions.push({
        id: node.id,
        namespace: node.namespace,
        key: node.key,
        name: node.name,
        column: `${node.namespace}.${node.key}`,
      });
    }

    cursor = connection.pageInfo.hasNextPage
      ? connection.pageInfo.endCursor
      : null;
  } while (cursor);

  return definitions.sort((a, b) => a.column.localeCompare(b.column));
}

// ---------------------------------------------------------------------------
// Reading product values
// ---------------------------------------------------------------------------

/**
 * Build the metafield selections for a product query.
 *
 * The namespace/key pairs are only known at runtime, so the aliases are
 * generated. They are indexed rather than derived from the key because a
 * metafield key may contain characters a GraphQL alias may not.
 */
function metafieldSelections(definitions: RichTextDefinition[]): string {
  return definitions
    .map(
      (definition, index) =>
        `mf${index}: metafield(namespace: ${JSON.stringify(
          definition.namespace,
        )}, key: ${JSON.stringify(definition.key)}) { value }`,
    )
    .join("\n        ");
}

type ProductNode = {
  id: string;
  title: string;
  handle: string;
} & Record<string, { value: string | null } | string | null>;

function toProductRichText(
  node: ProductNode,
  definitions: RichTextDefinition[],
): ProductRichText {
  const values: Record<string, string> = {};
  definitions.forEach((definition, index) => {
    const field = node[`mf${index}`] as { value: string | null } | null;
    values[definition.column] = field?.value ?? "";
  });

  return { id: node.id, title: node.title, handle: node.handle, values };
}

/** Every product with its rich text values. Used by export. */
export async function getAllProductRichText(
  admin: Admin,
  definitions: RichTextDefinition[],
): Promise<ProductRichText[]> {
  const document = `#graphql
    query ProductsRichTextPage($cursor: String, $pageSize: Int!) {
      products(first: $pageSize, after: $cursor, sortKey: TITLE) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          handle
          ${metafieldSelections(definitions)}
        }
      }
    }
  `;

  const products: ProductRichText[] = [];
  let cursor: string | null = null;

  do {
    const data: {
      products: { pageInfo: PageInfo; nodes: ProductNode[] };
    } = await query(admin, document, {
      cursor,
      pageSize: PRODUCT_PAGE_SIZE,
    });

    for (const node of data.products.nodes) {
      products.push(toProductRichText(node, definitions));
    }

    cursor = data.products.pageInfo.hasNextPage
      ? data.products.pageInfo.endCursor
      : null;
  } while (cursor);

  return products;
}

/**
 * Look up only the products a CSV names, by title.
 *
 * Fetching the whole catalogue to import twenty rows would be wasteful on a
 * large store, so the titles are batched into search queries instead.
 *
 * Shopify's `title:` search is a prefix/fuzzy match, so it happily returns
 * neighbours of what was asked for. Everything it returns is therefore filtered
 * down to an exact, case-insensitive title match before being returned — a
 * near-miss silently writing to the wrong product is the failure this feature
 * can least afford.
 */
export async function getProductRichTextByTitles(
  admin: Admin,
  definitions: RichTextDefinition[],
  titles: string[],
): Promise<ProductRichText[]> {
  const document = `#graphql
    query ProductsByTitle($search: String!, $pageSize: Int!, $cursor: String) {
      products(first: $pageSize, query: $search, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          handle
          ${metafieldSelections(definitions)}
        }
      }
    }
  `;

  const wanted = new Set(titles.map((title) => title.trim().toLowerCase()));
  const found: ProductRichText[] = [];
  const seenIds = new Set<string>();

  const unique = [...new Set(titles.map((title) => title.trim()))].filter(
    Boolean,
  );

  for (let start = 0; start < unique.length; start += TITLE_BATCH_SIZE) {
    const batch = unique.slice(start, start + TITLE_BATCH_SIZE);
    // Escaping matters: a title containing a quote would otherwise terminate
    // the term early and turn the rest of it into stray search syntax.
    const search = batch
      .map((title) => `title:"${title.replace(/(["\\])/g, "\\$1")}"`)
      .join(" OR ");

    let cursor: string | null = null;
    do {
      const data: {
        products: { pageInfo: PageInfo; nodes: ProductNode[] };
      } = await query(admin, document, {
        search,
        pageSize: PRODUCT_PAGE_SIZE,
        cursor,
      });

      for (const node of data.products.nodes) {
        if (!wanted.has(node.title.trim().toLowerCase())) continue;
        if (seenIds.has(node.id)) continue;
        seenIds.add(node.id);
        found.push(toProductRichText(node, definitions));
      }

      cursor = data.products.pageInfo.hasNextPage
        ? data.products.pageInfo.endCursor
        : null;
    } while (cursor);
  }

  return found;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const METAFIELDS_SET = `#graphql
  mutation SetProductRichText($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key namespace }
      userErrors { field message code }
    }
  }
`;

export type MetafieldWrite = {
  ownerId: string;
  namespace: string;
  key: string;
  value: string;
};

/**
 * Write a batch of metafield values.
 *
 * Returns user errors rather than throwing, matching `upsertEntry`: one bad
 * value should be reported next to the rows that succeeded, not abort the run.
 */
export async function setRichTextMetafields(
  admin: Admin,
  writes: MetafieldWrite[],
): Promise<{ ok: boolean; errors: string[] }> {
  const data = await query<{
    metafieldsSet: { userErrors: UserError[] };
  }>(admin, METAFIELDS_SET, {
    metafields: writes.map((write) => ({
      ownerId: write.ownerId,
      namespace: write.namespace,
      key: write.key,
      type: RICH_TEXT_TYPE,
      value: write.value,
    })),
  });

  const { userErrors } = data.metafieldsSet;

  return { ok: userErrors.length === 0, errors: formatUserErrors(userErrors) };
}

export { METAFIELD_BATCH_SIZE };
