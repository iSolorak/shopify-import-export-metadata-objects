// Admin API access for the variant metafield section.
//
// Same conventions as the sibling server modules — a structural `Admin` type, a
// private `query` helper that throws on transport errors, `#graphql`-tagged
// documents — and the same reason for not sharing them: nothing here reads a
// product's own metafields the way the rich text feature does, and nothing in
// `product-metafields.server.ts` knows what a variant is.
//
// What this module adds over the existing product-side reads is the pair of
// lookups the readable CSV needs: metaobject **gid → display name** for the
// export, and metaobject **display name → gid** for the import. Every other
// export in this app writes the stored API value or a handle, which is exactly
// the thing a merchant cannot edit in a spreadsheet.
//
// A row is a variant, but it carries its product's metafields too. That is not
// redundancy for its own sake: the values a merchant most often wants beside a
// variant — `shopify.color-pattern`, a size chart, a care guide — are defined on
// the *product*, and a file that omits them cannot answer "which variants are
// the peach ones" without a second export to join against.

import { getEntries } from "./metaobjects.server";
import {
  METAOBJECT_TYPES,
  PRODUCT_REFERENCE_TYPES,
} from "./product-write.server";
import type { RichTextDefinition } from "./product-metafields.server";
import { normalizeDisplayName } from "./variant-metafield-columns";
import { adminQuery } from "./admin-query.server";

/** Structural, for the same reason as in `metaobjects.server.ts`. */
type Admin = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

type PageInfo = { hasNextPage: boolean; endCursor: string | null };

/**
 * The two owners a row touches, passed around together.
 *
 * Every read, every column and every write here is parameterised by both, and
 * threading two arrays through a dozen signatures went wrong the first time the
 * order was transposed. One object cannot be.
 */
export type DefinitionSet = {
  variant: RichTextDefinition[];
  product: RichTextDefinition[];
};

/** The most variants a page will ever ask for; `variantPageSize` lowers it as
 *  the definition count grows. */
const VARIANT_CONNECTION_PAGE_SIZE = 100;

/** Products per page when turning handles into ids. Cheap: two scalars each. */
const HANDLE_PAGE_SIZE = 50;

/** SKUs or handles per search query; a long OR chain is the slowest kind. */
const SEARCH_BATCH_SIZE = 20;

/** Ids per `nodes(ids:)` call. */
const NODE_BATCH_SIZE = 100;

/** Ceiling for the product-metafield lookup; `productNodeBatchSize` lowers it
 *  as the definition count grows. */
const PRODUCT_NODE_BATCH_SIZE = 50;

/**
 * Variants read in one export.
 *
 * `deploy/nginx/shopify-app.conf` gives the request 300 seconds, and a
 * catalogue past this point should be exported in slices rather than discovered
 * as a gateway timeout with no file to show for it.
 */
export const MAX_VARIANTS = 20000;

export type VariantMetafields = {
  /** Variant gid — the owner every variant write in this section targets. */
  id: string;
  sku: string | null;
  /** Variant title, e.g. `Peach / S`. */
  title: string;
  /**
   * The variant's 1-based place in its product.
   *
   * Carried because a product metafield holding a *list* — Shopify's own
   * `shopify.color-pattern` is one — lines its entries up with the variants in
   * this order, and nothing else in a variant row says which entry is whose.
   * The connection's own order is not a substitute: it is not documented to
   * follow position, and a mis-ordered list would silently attach the wrong
   * colour to every variant of a product.
   */
  position: number;
  selectedOptions: { name: string; value: string }[];
  productId: string;
  productHandle: string;
  productTitle: string;
  /** `namespace.key` → stored API value (a gid, a JSON list, a plain string). */
  values: Record<string, string>;
  /**
   * The product's own metafields, by `namespace.key`.
   *
   * Repeated on every variant of the same product — a row is a variant, and a
   * product metafield belongs to all of them. The planner is what stops that
   * repetition turning into conflicting writes.
   */
  productValues: Record<string, string>;
};

/**
 * One Admin API call.
 *
 * Thin by design: `adminQuery` is the shared one, and it waits out `THROTTLED`
 * rather than throwing on it — see `admin-query.server.ts` for why that is not
 * optional once a page walks a whole catalogue.
 */
const query = adminQuery;

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
 * The aliased metafield selections for one owner.
 *
 * Indexed rather than derived from the key, for the reason
 * `product-metafields.server.ts` gives: a metafield key may contain characters
 * a GraphQL alias may not. The prefix keeps the variant's aliases and its
 * product's apart inside the one query.
 */
function metafieldSelections(
  definitions: RichTextDefinition[],
  prefix: "mf" | "pmf",
): string {
  return definitions
    .map(
      (definition, index) =>
        `${prefix}${index}: metafield(namespace: ${JSON.stringify(
          definition.namespace,
        )}, key: ${JSON.stringify(definition.key)}) { value }`,
    )
    .join("\n            ");
}

type MetafieldNode = { value: string | null } | null;

type VariantNode = {
  id: string;
  title: string;
  sku: string | null;
  position: number;
  selectedOptions: { name: string; value: string }[];
} & Record<string, unknown>;

type ProductNode = {
  id: string;
  handle: string;
  title: string;
} & Record<string, unknown>;

function readValues(
  node: Record<string, unknown>,
  definitions: RichTextDefinition[],
  prefix: "mf" | "pmf",
): Record<string, string> {
  const values: Record<string, string> = {};
  definitions.forEach((definition, index) => {
    const field = node[`${prefix}${index}`] as MetafieldNode;
    values[definition.column] = field?.value ?? "";
  });
  return values;
}

function toVariantMetafields(
  node: VariantNode,
  product: ProductNode,
  definitions: DefinitionSet,
): VariantMetafields {
  return {
    id: node.id,
    sku: node.sku,
    title: node.title,
    position: node.position,
    selectedOptions: node.selectedOptions,
    productId: product.id,
    productHandle: product.handle,
    productTitle: product.title,
    values: readValues(node, definitions.variant, "mf"),
    // Filled by `attachProductMetafields`, not read here — see its comment.
    productValues: {},
  };
}

// ---------------------------------------------------------------------------
// Reading variants
// ---------------------------------------------------------------------------

/**
 * Every read here goes through the **flat** `productVariants` connection, and
 * every page size below is derived rather than chosen. Both are consequences of
 * one rule: a single Admin API query may not exceed 1,000 cost points, checked
 * before it runs.
 *
 * A connection costs `2 + first × (cost of one node)`, and an object costs 1.
 * The obvious shape for this feature — `products(first: 25) { variants(first:
 * 100) { … } }` — therefore costs about `25 × (2 + 100 × (2 + definitions))`,
 * which is five figures before a single metafield is selected. It fails outright
 * with `Query cost is …, which exceeds the single query max cost limit (1000)`,
 * and the merchant sees an unexplained server error. Flattening removes the
 * multiplication: one page of variants costs `2 + first × (3 + definitions)`.
 *
 * That still grows with the number of metafield definitions, which is why the
 * page size is computed from it. A store that adds its thirtieth variant
 * metafield gets smaller pages, not a broken export.
 */
const COST_BUDGET = 800;

/** Cost of one variant node: the variant, its options, its product, its
 *  metafields. */
function variantPageSize(definitionCount: number): number {
  return Math.min(
    VARIANT_CONNECTION_PAGE_SIZE,
    Math.max(5, Math.floor(COST_BUDGET / (3 + definitionCount))),
  );
}

/** Products per product-metafield lookup, by the same reasoning. */
function productNodeBatchSize(definitionCount: number): number {
  return Math.min(
    PRODUCT_NODE_BATCH_SIZE,
    Math.max(1, Math.floor(COST_BUDGET / (1 + definitionCount))),
  );
}

/**
 * Variants read through the top-level connection, with their product.
 *
 * `search` is null for the full export and a filter expression otherwise — the
 * same document either way, so there is one place where the metafield
 * selections have to be right.
 */
async function readVariantConnection(
  admin: Admin,
  definitions: DefinitionSet,
  search: string | null,
  limit = MAX_VARIANTS,
): Promise<VariantMetafields[]> {
  const document = `#graphql
    query VariantMetafieldsPage(
      $cursor: String
      $pageSize: Int!
      $search: String
    ) {
      productVariants(first: $pageSize, after: $cursor, query: $search) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          sku
          position
          selectedOptions { name value }
          product { id handle title }
          ${metafieldSelections(definitions.variant, "mf")}
        }
      }
    }
  `;

  const found: VariantMetafields[] = [];
  let cursor: string | null = null;

  do {
    const data: {
      productVariants: {
        pageInfo: PageInfo;
        nodes: (VariantNode & { product: ProductNode })[];
      };
    } = await query(admin, document, {
      cursor,
      pageSize: variantPageSize(definitions.variant.length),
      search,
    });

    for (const node of data.productVariants.nodes) {
      found.push(toVariantMetafields(node, node.product, definitions));
    }

    if (found.length >= limit) {
      throw new Error(
        `This store has more than ${limit} variants. Export in slices rather than all at once.`,
      );
    }

    cursor = data.productVariants.pageInfo.hasNextPage
      ? data.productVariants.pageInfo.endCursor
      : null;
  } while (cursor);

  return found;
}

/**
 * Fill in each variant's product metafields, in a pass of their own.
 *
 * These cannot be selected on the `product` node inside the variant query: that
 * multiplies their cost by the page size, and a store carrying Shopify's
 * standard product metafields has enough of them to blow the single-query limit
 * on its own. Reading them by id afterwards costs `products ÷ batch` small
 * queries and is flat in the page size.
 */
async function attachProductMetafields(
  admin: Admin,
  definitions: RichTextDefinition[],
  variants: VariantMetafields[],
): Promise<VariantMetafields[]> {
  if (definitions.length === 0 || variants.length === 0) return variants;

  const document = `#graphql
    query ProductMetafieldValues($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          ${metafieldSelections(definitions, "pmf")}
        }
      }
    }
  `;

  const ids = [...new Set(variants.map((variant) => variant.productId))];
  const batchSize = productNodeBatchSize(definitions.length);
  const byProduct = new Map<string, Record<string, string>>();

  for (let start = 0; start < ids.length; start += batchSize) {
    const batch = ids.slice(start, start + batchSize);
    const data = await query<{ nodes: (ProductNode | null)[] }>(
      admin,
      document,
      { ids: batch },
    );

    for (const node of data.nodes) {
      if (!node?.id) continue;
      byProduct.set(node.id, readValues(node, definitions, "pmf"));
    }
  }

  for (const variant of variants) {
    variant.productValues = byProduct.get(variant.productId) ?? {};
  }

  return variants;
}

/** Every variant in the store, with its metafield values. Used by export. */
export async function getAllVariantMetafields(
  admin: Admin,
  definitions: DefinitionSet,
): Promise<VariantMetafields[]> {
  return attachProductMetafields(
    admin,
    definitions.product,
    await readVariantConnection(admin, definitions, null),
  );
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
  definitions: DefinitionSet,
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

    for (const variant of await readVariantConnection(
      admin,
      definitions,
      search,
    )) {
      if (!variant.sku || !wanted.has(variant.sku.trim())) continue;
      if (seen.has(variant.id)) continue;
      seen.add(variant.id);
      found.push(variant);
    }
  }

  return attachProductMetafields(admin, definitions.product, found);
}

/**
 * The gids of the products a CSV names, by handle.
 *
 * `productVariants` has no handle filter, so the handles are turned into
 * product ids first and the variants are then fetched by `product_id`. Reading
 * the variants through the products connection instead would nest one
 * connection inside another, which is the shape the cost limit refuses.
 */
async function productIdsByHandle(
  admin: Admin,
  handles: string[],
): Promise<Map<string, string>> {
  const document = `#graphql
    query ProductIdsByHandle($pageSize: Int!, $search: String!, $cursor: String) {
      products(first: $pageSize, after: $cursor, query: $search) {
        pageInfo { hasNextPage endCursor }
        nodes { id handle }
      }
    }
  `;

  const wanted = new Set(handles);
  const found = new Map<string, string>();

  for (let start = 0; start < handles.length; start += SEARCH_BATCH_SIZE) {
    const batch = handles.slice(start, start + SEARCH_BATCH_SIZE);
    const search = batch
      .map((handle) => searchTerm("handle", handle))
      .join(" OR ");

    let cursor: string | null = null;
    do {
      const data: {
        products: {
          pageInfo: PageInfo;
          nodes: { id: string; handle: string }[];
        };
      } = await query(admin, document, {
        pageSize: HANDLE_PAGE_SIZE,
        search,
        cursor,
      });

      for (const node of data.products.nodes) {
        // `handle:` is exact, but an OR chain can still pull in a neighbour on
        // a fuzzy tokenisation, so what comes back is filtered anyway.
        if (wanted.has(node.handle.trim().toLowerCase())) {
          found.set(node.handle.trim().toLowerCase(), node.id);
        }
      }

      cursor = data.products.pageInfo.hasNextPage
        ? data.products.pageInfo.endCursor
        : null;
    } while (cursor);
  }

  return found;
}

/**
 * Look up the variants of the products a CSV names, by product handle.
 *
 * The fallback for rows with no SKU, where a variant is identified by its
 * option values instead.
 */
export async function getVariantMetafieldsByProductHandles(
  admin: Admin,
  definitions: DefinitionSet,
  handles: string[],
): Promise<VariantMetafields[]> {
  const wanted = [
    ...new Set(
      handles.map((handle) => handle.trim().toLowerCase()).filter(Boolean),
    ),
  ];
  if (wanted.length === 0) return [];

  const ids = await productIdsByHandle(admin, wanted);
  if (ids.size === 0) return [];

  // `product_id` takes the numeric id, not the gid.
  const numeric = [...ids.values()].map((id) => id.split("/").pop() ?? id);
  const found: VariantMetafields[] = [];
  const seen = new Set<string>();

  for (let start = 0; start < numeric.length; start += SEARCH_BATCH_SIZE) {
    const batch = numeric.slice(start, start + SEARCH_BATCH_SIZE);
    const search = batch.map((id) => `product_id:${id}`).join(" OR ");

    for (const variant of await readVariantConnection(
      admin,
      definitions,
      search,
    )) {
      if (seen.has(variant.id)) continue;
      seen.add(variant.id);
      found.push(variant);
    }
  }

  return attachProductMetafields(admin, definitions.product, found);
}

// ---------------------------------------------------------------------------
// Reference lookups — what makes the CSV readable
// ---------------------------------------------------------------------------

export type MetaobjectRef = {
  handle: string;
  displayName: string | null;
  type: string;
  /** The entry's own fields, by key — what the expanded columns read. */
  values: Record<string, string>;
};

/**
 * Resolve metaobject gids to their handle, display name and field values.
 *
 * Reads the entries directly rather than loading every entry of every type the
 * definitions allow: an export touches only the entries actually referenced,
 * and a `mixed_reference` column has no single definition to enumerate anyway.
 *
 * The fields come back in the same call the handle does, so expanding an entry
 * into columns costs nothing extra once the entry has been resolved at all.
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
        ... on Metaobject {
          id
          handle
          displayName
          type
          fields { key value }
        }
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
        fields: { key: string; value: string | null }[];
      } | null)[];
    }>(admin, document, { ids: batch });

    for (const node of data.nodes) {
      if (!node?.id) continue;
      const values: Record<string, string> = {};
      for (const field of node.fields) values[field.key] = field.value ?? "";

      resolved.set(node.id, {
        handle: node.handle,
        displayName: node.displayName,
        type: node.type,
        values,
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
 * Everything needed to turn a display name back into a gid, and to know which
 * columns an entry expands into, per metaobject type.
 *
 * Built only for the definitions that are restricted to one metaobject
 * definition, because those are the only columns where a bare name is
 * unambiguous about *which* definition it belongs to, and the only ones whose
 * expanded column set is known before the data is read. A `mixed_reference`
 * column keeps the `type:handle` form and is never expanded.
 *
 * Display names are not unique. `handlesByDisplayName` therefore holds an
 * array, and the planner reports a name matching several entries as an error
 * rather than resolving to whichever one the API happened to return first.
 */
export type MetaobjectIndex = {
  /** Metafield column (`namespace.key`, product ones prefixed) → entry type. */
  typeByColumn: Map<string, string>;
  /** `type:handle` → gid. */
  idByHandle: Map<string, string>;
  /** `type:normalised display name` → handles. */
  handlesByDisplayName: Map<string, string[]>;
  /** Entry type → its field keys, in definition order. */
  fieldKeysByType: Map<string, string[]>;
};

export const EMPTY_METAOBJECT_INDEX: MetaobjectIndex = {
  typeByColumn: new Map(),
  idByHandle: new Map(),
  handlesByDisplayName: new Map(),
  fieldKeysByType: new Map(),
};

/**
 * `entries` decides whether every entry of every referenced type is read.
 *
 * The import needs them — that is what turns "Peach" back into a gid. The
 * export does not: it only wants `typeByColumn` and `fieldKeysByType` to know
 * which columns exist, and resolves the entries it actually references by id
 * instead. Loading a thousand-entry metaobject to name six of them is the
 * difference between a fast export and a timed-out one.
 */
export async function buildMetaobjectIndex(
  admin: Admin,
  columns: { column: string; definition: RichTextDefinition }[],
  options?: { entries?: boolean },
): Promise<MetaobjectIndex> {
  const index: MetaobjectIndex = {
    typeByColumn: new Map(),
    idByHandle: new Map(),
    handlesByDisplayName: new Map(),
    fieldKeysByType: new Map(),
  };

  const definitionIds = [
    ...new Set(
      columns
        .filter(
          ({ definition }) =>
            METAOBJECT_TYPES.includes(definition.type) &&
            definition.metaobjectDefinitionId,
        )
        .map(({ definition }) => definition.metaobjectDefinitionId!),
    ),
  ];
  if (definitionIds.length === 0) return index;

  // The metafield definition carries the *id* of the metaobject definition;
  // every lookup from here on needs its *type* string, and the expanded columns
  // need its field keys.
  const document = `#graphql
    query MetaobjectDefinitionTypes($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on MetaobjectDefinition {
          id
          type
          fieldDefinitions { key }
        }
      }
    }
  `;

  const typeById = new Map<string, string>();
  for (let start = 0; start < definitionIds.length; start += NODE_BATCH_SIZE) {
    const batch = definitionIds.slice(start, start + NODE_BATCH_SIZE);
    const data = await query<{
      nodes: ({
        id: string;
        type: string;
        fieldDefinitions: { key: string }[];
      } | null)[];
    }>(admin, document, { ids: batch });

    for (const node of data.nodes) {
      if (!node?.id) continue;
      typeById.set(node.id, node.type);
      index.fieldKeysByType.set(
        node.type,
        node.fieldDefinitions.map((field) => field.key),
      );
    }
  }

  for (const { column, definition } of columns) {
    const type = definition.metaobjectDefinitionId
      ? typeById.get(definition.metaobjectDefinitionId)
      : undefined;
    if (type) index.typeByColumn.set(column, type);
  }

  if (options?.entries === false) return index;

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
