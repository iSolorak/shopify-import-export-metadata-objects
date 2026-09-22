// Admin API access for the variant metafield section.
//
// Same conventions as the sibling server modules — a structural `Admin` type, a
// private `query` helper that throws on transport errors, `#graphql`-tagged
// documents — and the same reason for not sharing them: nothing here reads a
// product's own metafields, and nothing in `product-metafields.server.ts` knows
// what a variant is.
//
// What this module adds over the existing product-side reads is the pair of
// lookups the readable CSV needs: metaobject **gid → display name** for the
// export, and metaobject **display name → gid** for the import. Every other
// export in this app writes the stored API value or a handle, which is exactly
// the thing a merchant cannot edit in a spreadsheet.

import { getEntries } from "./metaobjects.server";
import { METAOBJECT_TYPES, PRODUCT_REFERENCE_TYPES } from "./product-write.server";
import type { RichTextDefinition } from "./product-metafields.server";
import { normalizeDisplayName } from "./variant-metafield-columns";

/** Structural, for the same reason as in `metaobjects.server.ts`. */
type Admin = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

type PageInfo = { hasNextPage: boolean; endCursor: string | null };

/**
 * Products per page.
 *
 * Each one carries up to `VARIANT_PAGE_SIZE` variants and every variant carries
 * one metafield lookup per definition, so this is by some distance the most
 * expensive query in the app. Twenty-five keeps a store with a dozen variant
 * definitions inside the query cost budget; the fifty the rich text export uses
 * would not, because that one reads a single metafield per *product*.
 */
const PRODUCT_PAGE_SIZE = 25;

/** Variants read with their product before a second pass picks up the rest. */
const VARIANT_PAGE_SIZE = 100;

/** Variants per page when reading them from the top-level connection. */
const VARIANT_CONNECTION_PAGE_SIZE = 100;

/** SKUs or handles per search query; a long OR chain is the slowest kind. */
const SEARCH_BATCH_SIZE = 20;

/** Ids per `nodes(ids:)` call. */
const NODE_BATCH_SIZE = 100;

/**
 * Variants read in one export.
 *
 * `deploy/nginx/shopify-app.conf` gives the request 300 seconds, and a
 * catalogue past this point should be exported in slices rather than discovered
 * as a gateway timeout with no file to show for it.
 */
export const MAX_VARIANTS = 20000;

export type VariantMetafields = {
  /** Variant gid — the owner every write in this section targets. */
  id: string;
  sku: string | null;
  /** Variant title, e.g. `Peach / S`. */
  title: string;
  selectedOptions: { name: string; value: string }[];
  productId: string;
  productHandle: string;
  productTitle: string;
  /** `namespace.key` → stored API value (a gid, a JSON list, a plain string). */
  values: Record<string, string>;
};

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

/**
 * Quote a value for a search term.
 *
 * A SKU containing a quote would otherwise terminate the term early and turn
 * the rest of it into stray search syntax — the same escaping
 * `getProductRichTextByTitles` does for titles.
 */
function searchTerm(field: string, value: string): string {
  return `${field}:"${value.replace(/(["\\])/g, "\\$1")}"`;
}

/**
 * The aliased metafield selections for a variant.
 *
 * Indexed rather than derived from the key, for the reason
 * `product-metafields.server.ts` gives: a metafield key may contain characters
 * a GraphQL alias may not.
 */
function metafieldSelections(definitions: RichTextDefinition[]): string {
  return definitions
    .map(
      (definition, index) =>
        `mf${index}: metafield(namespace: ${JSON.stringify(
          definition.namespace,
        )}, key: ${JSON.stringify(definition.key)}) { value }`,
    )
    .join("\n            ");
}

type VariantNode = {
  id: string;
  title: string;
  sku: string | null;
  selectedOptions: { name: string; value: string }[];
} & Record<string, unknown>;

type ProductContext = { id: string; handle: string; title: string };

function toVariantMetafields(
  node: VariantNode,
  product: ProductContext,
  definitions: RichTextDefinition[],
): VariantMetafields {
  const values: Record<string, string> = {};
  definitions.forEach((definition, index) => {
    const field = node[`mf${index}`] as { value: string | null } | null;
    values[definition.column] = field?.value ?? "";
  });

  return {
    id: node.id,
    sku: node.sku,
    title: node.title,
    selectedOptions: node.selectedOptions,
    productId: product.id,
    productHandle: product.handle,
    productTitle: product.title,
    values,
  };
}

// ---------------------------------------------------------------------------
// Reading variants
// ---------------------------------------------------------------------------

/**
 * Variants read through the products connection.
 *
 * Used for both the full export and the handle lookup: the only difference is
 * the `query` argument, and building the two separately would mean two places
 * to keep the metafield selections right.
 *
 * The nested `variants` connection is capped at `VARIANT_PAGE_SIZE` rather than
 * paged inline, because a nested cursor cannot be advanced without re-running
 * the outer page. Products that have more is a real case — a garment in forty
 * colours and five sizes clears it — so the ones that report `hasNextPage` are
 * collected and finished off by `variantsOfProduct` below rather than silently
 * truncated. An export that quietly drops variants is worse than a slow one.
 */
async function readProducts(
  admin: Admin,
  definitions: RichTextDefinition[],
  search: string | null,
  limit: number,
): Promise<VariantMetafields[]> {
  const document = `#graphql
    query VariantMetafieldsByProduct(
      $cursor: String
      $pageSize: Int!
      $variantPageSize: Int!
      $search: String
    ) {
      products(first: $pageSize, after: $cursor, query: $search, sortKey: TITLE) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          handle
          title
          variants(first: $variantPageSize) {
            pageInfo { hasNextPage }
            nodes {
              id
              title
              sku
              selectedOptions { name value }
              ${metafieldSelections(definitions)}
            }
          }
        }
      }
    }
  `;

  const variants: VariantMetafields[] = [];
  const truncated: ProductContext[] = [];
  let cursor: string | null = null;

  do {
    const data: {
      products: {
        pageInfo: PageInfo;
        nodes: (ProductContext & {
          variants: { pageInfo: { hasNextPage: boolean }; nodes: VariantNode[] };
        })[];
      };
    } = await query(admin, document, {
      cursor,
      pageSize: PRODUCT_PAGE_SIZE,
      variantPageSize: VARIANT_PAGE_SIZE,
      search,
    });

    for (const node of data.products.nodes) {
      const product = { id: node.id, handle: node.handle, title: node.title };
      for (const variant of node.variants.nodes) {
        variants.push(toVariantMetafields(variant, product, definitions));
      }
      if (node.variants.pageInfo.hasNextPage) truncated.push(product);
    }

    if (variants.length >= limit) {
      throw new Error(
        `This store has more than ${limit} variants. Export in slices rather than all at once.`,
      );
    }

    cursor = data.products.pageInfo.hasNextPage
      ? data.products.pageInfo.endCursor
      : null;
  } while (cursor);

  // The overflow pass. Rare enough to be worth a second round trip per affected
  // product and not worth complicating the query above for.
  for (const product of truncated) {
    const seen = new Set(
      variants.filter((v) => v.productId === product.id).map((v) => v.id),
    );
    for (const variant of await variantsOfProduct(admin, definitions, product)) {
      if (!seen.has(variant.id)) variants.push(variant);
    }
  }

  return variants;
}

/** Every variant of one product, through the top-level connection. */
async function variantsOfProduct(
  admin: Admin,
  definitions: RichTextDefinition[],
  product: ProductContext,
): Promise<VariantMetafields[]> {
  // `product_id` takes the numeric id, not the gid.
  const numericId = product.id.split("/").pop() ?? product.id;
  const nodes = await readVariantConnection(
    admin,
    definitions,
    `product_id:${numericId}`,
  );

  return nodes.map(({ node }) => toVariantMetafields(node, product, definitions));
}

/** Variants read through the top-level connection, with their product. */
async function readVariantConnection(
  admin: Admin,
  definitions: RichTextDefinition[],
  search: string,
): Promise<{ node: VariantNode; product: ProductContext }[]> {
  const document = `#graphql
    query VariantMetafieldsPage(
      $cursor: String
      $pageSize: Int!
      $search: String!
    ) {
      productVariants(first: $pageSize, after: $cursor, query: $search) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          sku
          selectedOptions { name value }
          product { id handle title }
          ${metafieldSelections(definitions)}
        }
      }
    }
  `;

  const found: { node: VariantNode; product: ProductContext }[] = [];
  let cursor: string | null = null;

  do {
    const data: {
      productVariants: {
        pageInfo: PageInfo;
        nodes: (VariantNode & { product: ProductContext })[];
      };
    } = await query(admin, document, {
      cursor,
      pageSize: VARIANT_CONNECTION_PAGE_SIZE,
      search,
    });

    for (const node of data.productVariants.nodes) {
      found.push({ node, product: node.product });
    }

    cursor = data.productVariants.pageInfo.hasNextPage
      ? data.productVariants.pageInfo.endCursor
      : null;
  } while (cursor);

  return found;
}

/** Every variant in the store, with its metafield values. Used by export. */
export function getAllVariantMetafields(
  admin: Admin,
  definitions: RichTextDefinition[],
): Promise<VariantMetafields[]> {
  return readProducts(admin, definitions, null, MAX_VARIANTS);
}

/**
 * Look up only the variants a CSV names, by SKU.
 *
 * Shopify's `sku:` search is a prefix match, so `SS-PCH-S` also returns
 * `SS-PCH-SMALL`. Everything it returns is filtered down to an exact match
 * before being returned — a near-miss silently writing to the wrong variant is
 * the failure this feature can least afford. The comparison is
 * case-**sensitive**: a SKU is a code, and two SKUs differing only in case are
 * two different variants.
 */
export async function getVariantMetafieldsBySkus(
  admin: Admin,
  definitions: RichTextDefinition[],
  skus: string[],
): Promise<VariantMetafields[]> {
  const wanted = new Set(skus.map((sku) => sku.trim()).filter(Boolean));
  if (wanted.size === 0) return [];

  const unique = [...wanted];
  const found: VariantMetafields[] = [];
  const seen = new Set<string>();

  for (let start = 0; start < unique.length; start += SEARCH_BATCH_SIZE) {
    const batch = unique.slice(start, start + SEARCH_BATCH_SIZE);
    const search = batch.map((sku) => searchTerm("sku", sku)).join(" OR ");

    for (const { node, product } of await readVariantConnection(
      admin,
      definitions,
      search,
    )) {
      if (!node.sku || !wanted.has(node.sku.trim())) continue;
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      found.push(toVariantMetafields(node, product, definitions));
    }
  }

  return found;
}

/**
 * Look up the variants of the products a CSV names, by product handle.
 *
 * The fallback for rows with no SKU, where a variant is identified by its
 * option values instead. Read through the products connection because
 * `productVariants` has no handle filter.
 */
export async function getVariantMetafieldsByProductHandles(
  admin: Admin,
  definitions: RichTextDefinition[],
  handles: string[],
): Promise<VariantMetafields[]> {
  const wanted = new Set(
    handles.map((handle) => handle.trim().toLowerCase()).filter(Boolean),
  );
  if (wanted.size === 0) return [];

  const unique = [...wanted];
  const found: VariantMetafields[] = [];
  const seen = new Set<string>();

  for (let start = 0; start < unique.length; start += SEARCH_BATCH_SIZE) {
    const batch = unique.slice(start, start + SEARCH_BATCH_SIZE);
    const search = batch
      .map((handle) => searchTerm("handle", handle))
      .join(" OR ");

    // `handle:` is an exact match, but the OR chain can still pull in a
    // neighbour on a fuzzy tokenisation, so the result is filtered anyway.
    for (const variant of await readProducts(
      admin,
      definitions,
      search,
      MAX_VARIANTS,
    )) {
      if (!wanted.has(variant.productHandle.trim().toLowerCase())) continue;
      if (seen.has(variant.id)) continue;
      seen.add(variant.id);
      found.push(variant);
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// Reference lookups — what makes the CSV readable
// ---------------------------------------------------------------------------

export type MetaobjectRef = {
  handle: string;
  displayName: string | null;
  type: string;
};

/**
 * Resolve metaobject gids to their handle and display name, for the export.
 *
 * Reads the entries directly rather than loading every entry of every type the
 * definitions allow: an export touches only the entries actually referenced,
 * and a `mixed_reference` column has no single definition to enumerate anyway.
 */
export async function resolveMetaobjectIds(
  admin: Admin,
  ids: string[],
): Promise<Map<string, MetaobjectRef>> {
  const unique = [...new Set(ids)].filter(Boolean);
  const resolved = new Map<string, MetaobjectRef>();
  if (unique.length === 0) return resolved;

  const document = `#graphql
    query MetaobjectRefs($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Metaobject { id handle displayName type }
      }
    }
  `;

  for (let start = 0; start < unique.length; start += NODE_BATCH_SIZE) {
    const batch = unique.slice(start, start + NODE_BATCH_SIZE);
    const data = await query<{
      nodes: ({
        id: string;
        handle: string;
        displayName: string | null;
        type: string;
      } | null)[];
    }>(admin, document, { ids: batch });

    for (const node of data.nodes) {
      if (!node?.id) continue;
      resolved.set(node.id, {
        handle: node.handle,
        displayName: node.displayName,
        type: node.type,
      });
    }
  }

  return resolved;
}

/** Resolve product gids to handles, for product reference columns. */
export async function resolveProductIds(
  admin: Admin,
  ids: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter(Boolean);
  const resolved = new Map<string, string>();
  if (unique.length === 0) return resolved;

  const document = `#graphql
    query ProductHandlesByIds($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product { id handle }
      }
    }
  `;

  for (let start = 0; start < unique.length; start += NODE_BATCH_SIZE) {
    const batch = unique.slice(start, start + NODE_BATCH_SIZE);
    const data = await query<{
      nodes: ({ id: string; handle: string } | null)[];
    }>(admin, document, { ids: batch });

    for (const node of data.nodes) {
      if (!node?.id) continue;
      resolved.set(node.id, node.handle);
    }
  }

  return resolved;
}

/**
 * Everything needed to turn a display name back into a gid, per metaobject type.
 *
 * Built only for the definitions that are restricted to one metaobject
 * definition, because those are the only columns where a bare name is
 * unambiguous about *which* definition it belongs to. A `mixed_reference`
 * column keeps the `type:handle` form in both directions.
 *
 * Display names are not unique. `byDisplayName` therefore holds an array, and
 * the planner reports a name matching several entries as an error rather than
 * resolving to whichever one the API happened to return first.
 */
export type MetaobjectIndex = {
  /** Metafield column (`namespace.key`) → the metaobject type it accepts. */
  typeByColumn: Map<string, string>;
  /** `type:handle` → gid. */
  idByHandle: Map<string, string>;
  /** `type:handle` → display name, for a readable ambiguity message. */
  handlesByDisplayName: Map<string, string[]>;
};

export const EMPTY_METAOBJECT_INDEX: MetaobjectIndex = {
  typeByColumn: new Map(),
  idByHandle: new Map(),
  handlesByDisplayName: new Map(),
};

export async function buildMetaobjectIndex(
  admin: Admin,
  definitions: RichTextDefinition[],
): Promise<MetaobjectIndex> {
  const index: MetaobjectIndex = {
    typeByColumn: new Map(),
    idByHandle: new Map(),
    handlesByDisplayName: new Map(),
  };

  const definitionIds = [
    ...new Set(
      definitions
        .filter(
          (definition) =>
            METAOBJECT_TYPES.includes(definition.type) &&
            definition.metaobjectDefinitionId,
        )
        .map((definition) => definition.metaobjectDefinitionId!),
    ),
  ];
  if (definitionIds.length === 0) return index;

  // The definition carries the *id* of the metaobject definition; every lookup
  // from here on needs its *type* string.
  const document = `#graphql
    query MetaobjectDefinitionTypes($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on MetaobjectDefinition { id type }
      }
    }
  `;

  const typeById = new Map<string, string>();
  for (let start = 0; start < definitionIds.length; start += NODE_BATCH_SIZE) {
    const batch = definitionIds.slice(start, start + NODE_BATCH_SIZE);
    const data = await query<{
      nodes: ({ id: string; type: string } | null)[];
    }>(admin, document, { ids: batch });

    for (const node of data.nodes) {
      if (node?.id) typeById.set(node.id, node.type);
    }
  }

  for (const definition of definitions) {
    const type = definition.metaobjectDefinitionId
      ? typeById.get(definition.metaobjectDefinitionId)
      : undefined;
    if (type) index.typeByColumn.set(definition.column, type);
  }

  for (const type of new Set(typeById.values())) {
    for (const entry of await getEntries(admin, type)) {
      index.idByHandle.set(`${type}:${entry.handle}`, entry.id);
      if (!entry.displayName) continue;

      const key = `${type}:${normalizeDisplayName(entry.displayName)}`;
      const handles = index.handlesByDisplayName.get(key);
      if (handles) handles.push(entry.handle);
      else index.handlesByDisplayName.set(key, [entry.handle]);
    }
  }

  return index;
}

export { METAOBJECT_TYPES, PRODUCT_REFERENCE_TYPES };
