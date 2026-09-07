// Admin API access for the non-destructive product CSV update.
//
// Same conventions as `product-media.server.ts` and
// `product-metafields.server.ts` — a structural `Admin` type, a private
// `query` helper that throws on transport errors, `#graphql`-tagged documents,
// and mutations that return their user errors instead of throwing so one bad
// product is reported next to the ones that worked.
//
// Every operation here was validated against the 2026-07 schema that
// `app/shopify.server.ts` pins. Two field placements are easy to get wrong and
// worth stating: in `ProductVariantsBulkInput` the SKU, weight, cost, country
// of origin, HS code, `tracked` and `requiresShipping` all live under
// `inventoryItem`, not at the top level; and `ProductVariant.taxCode` is
// deprecated on this version, so nothing selects it.

import { cellToRichTextValue } from "./rich-text";

/** Structural, for the same reason as in `metaobjects.server.ts`. */
type Admin = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

type UserError = { field: string[] | null; message: string; code?: string | null };
type PageInfo = { hasNextPage: boolean; endCursor: string | null };

/**
 * Handles per lookup query.
 *
 * Each alias pulls a product with its media, variants, inventory levels and
 * metafields, which is by far the heaviest query in this app. Five keeps a
 * batch inside the query cost budget; the video importer's ten would not,
 * because that one reads only alt text.
 */
const HANDLE_BATCH_SIZE = 5;

/** Titles per search query, as in `getProductRichTextByTitles`. */
const TITLE_BATCH_SIZE = 10;

/** Variants read per product. Shopify's default cap per product is 2048, but a
 *  file describing more than this many variants of one product is not the case
 *  this importer is for, and reading them all would blow the cost budget. */
const VARIANT_PAGE_SIZE = 100;

/** Media read per product when checking which images are already attached. */
const MEDIA_PAGE_SIZE = 100;

/** Inventory levels read per variant — i.e. locations the item is stocked at. */
const LEVEL_PAGE_SIZE = 10;

/** `metafieldsSet` accepts at most 25 metafields per call. */
export const METAFIELD_BATCH_SIZE = 25;

/** `productVariantsBulkUpdate` accepts at most 250 variants per call. */
export const VARIANT_BATCH_SIZE = 250;

/** `inventorySetQuantities` quantities per call. */
export const INVENTORY_BATCH_SIZE = 250;

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
// Reading the current state
// ---------------------------------------------------------------------------

export type ExistingVariant = {
  id: string;
  inventoryItemId: string;
  sku: string | null;
  barcode: string | null;
  price: string | null;
  compareAtPrice: string | null;
  taxable: boolean;
  inventoryPolicy: string;
  tracked: boolean;
  requiresShipping: boolean;
  weightValue: number | null;
  weightUnit: string | null;
  cost: string | null;
  countryOfOrigin: string | null;
  hsCode: string | null;
  selectedOptions: { name: string; value: string }[];
  /** Location id → available quantity. */
  quantities: Map<string, number>;
  /** `namespace.key` → stored value. */
  metafields: Map<string, string>;
};

export type ExistingProduct = {
  id: string;
  handle: string;
  title: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  tags: string[];
  status: string;
  templateSuffix: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  categoryId: string | null;
  categoryName: string | null;
  images: { url: string; alt: string }[];
  variants: ExistingVariant[];
  metafields: Map<string, string>;
};

/** The metafields to read back, so the planner can skip unchanged values. */
export type MetafieldRef = { namespace: string; key: string };

/**
 * Build the aliased metafield selections for a product or variant.
 *
 * The namespace/key pairs are only known at runtime, so aliases are generated
 * and indexed rather than derived from the key — a metafield key may contain
 * characters a GraphQL alias may not.
 */
function metafieldSelections(refs: MetafieldRef[], prefix: string): string {
  return refs
    .map(
      (ref, index) =>
        `${prefix}${index}: metafield(namespace: ${JSON.stringify(
          ref.namespace,
        )}, key: ${JSON.stringify(ref.key)}) { value }`,
    )
    .join("\n            ");
}

function readMetafields(
  node: Record<string, unknown>,
  refs: MetafieldRef[],
  prefix: string,
): Map<string, string> {
  const values = new Map<string, string>();
  refs.forEach((ref, index) => {
    const field = node[`${prefix}${index}`] as { value: string | null } | null;
    if (field?.value != null) {
      values.set(`${ref.namespace}.${ref.key}`, field.value);
    }
  });
  return values;
}

type ProductNode = {
  id: string;
  handle: string;
  title: string;
  descriptionHtml: string | null;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  status: string;
  templateSuffix: string | null;
  seo: { title: string | null; description: string | null } | null;
  category: { id: string; name: string } | null;
  media: {
    nodes: {
      alt: string | null;
      mediaContentType: string;
      image?: { url: string } | null;
    }[];
  };
  variants: { nodes: VariantNode[] };
} & Record<string, unknown>;

type VariantNode = {
  id: string;
  sku: string | null;
  barcode: string | null;
  price: string | null;
  compareAtPrice: string | null;
  taxable: boolean;
  inventoryPolicy: string;
  selectedOptions: { name: string; value: string }[];
  inventoryItem: {
    id: string;
    tracked: boolean;
    requiresShipping: boolean;
    measurement: { weight: { unit: string; value: number } | null } | null;
    unitCost: { amount: string } | null;
    countryCodeOfOrigin: string | null;
    harmonizedSystemCode: string | null;
    inventoryLevels: {
      nodes: {
        location: { id: string };
        quantities: { name: string; quantity: number }[];
      }[];
    };
  };
} & Record<string, unknown>;

/**
 * The product selection, shared by the handle and title lookups so the two
 * paths cannot drift into reading different things.
 */
function productSelection(
  productRefs: MetafieldRef[],
  variantRefs: MetafieldRef[],
): string {
  return `
    id
    handle
    title
    descriptionHtml
    vendor
    productType
    tags
    status
    templateSuffix
    seo { title description }
    category { id name }
    media(first: ${MEDIA_PAGE_SIZE}) {
      nodes {
        alt
        mediaContentType
        ... on MediaImage { image { url } }
      }
    }
    variants(first: ${VARIANT_PAGE_SIZE}) {
      nodes {
        id
        sku
        barcode
        price
        compareAtPrice
        taxable
        inventoryPolicy
        selectedOptions { name value }
        inventoryItem {
          id
          tracked
          requiresShipping
          measurement { weight { unit value } }
          unitCost { amount }
          countryCodeOfOrigin
          harmonizedSystemCode
          inventoryLevels(first: ${LEVEL_PAGE_SIZE}) {
            nodes {
              location { id }
              quantities(names: ["available"]) { name quantity }
            }
          }
        }
        ${metafieldSelections(variantRefs, "vmf")}
      }
    }
    ${metafieldSelections(productRefs, "pmf")}
  `;
}

function toExistingVariant(
  node: VariantNode,
  variantRefs: MetafieldRef[],
): ExistingVariant {
  const quantities = new Map<string, number>();
  for (const level of node.inventoryItem.inventoryLevels.nodes) {
    const available = level.quantities.find(
      (quantity) => quantity.name === "available",
    );
    if (available) quantities.set(level.location.id, available.quantity);
  }

  return {
    id: node.id,
    inventoryItemId: node.inventoryItem.id,
    sku: node.sku,
    barcode: node.barcode,
    price: node.price,
    compareAtPrice: node.compareAtPrice,
    taxable: node.taxable,
    inventoryPolicy: node.inventoryPolicy,
    tracked: node.inventoryItem.tracked,
    requiresShipping: node.inventoryItem.requiresShipping,
    weightValue: node.inventoryItem.measurement?.weight?.value ?? null,
    weightUnit: node.inventoryItem.measurement?.weight?.unit ?? null,
    cost: node.inventoryItem.unitCost?.amount ?? null,
    countryOfOrigin: node.inventoryItem.countryCodeOfOrigin,
    hsCode: node.inventoryItem.harmonizedSystemCode,
    selectedOptions: node.selectedOptions,
    quantities,
    metafields: readMetafields(node, variantRefs, "vmf"),
  };
}

function toExistingProduct(
  node: ProductNode,
  productRefs: MetafieldRef[],
  variantRefs: MetafieldRef[],
): ExistingProduct {
  return {
    id: node.id,
    handle: node.handle,
    title: node.title,
    descriptionHtml: node.descriptionHtml ?? "",
    vendor: node.vendor ?? "",
    productType: node.productType ?? "",
    tags: node.tags ?? [],
    status: node.status,
    templateSuffix: node.templateSuffix,
    seoTitle: node.seo?.title ?? null,
    seoDescription: node.seo?.description ?? null,
    categoryId: node.category?.id ?? null,
    categoryName: node.category?.name ?? null,
    images: node.media.nodes
      .filter((media) => media.mediaContentType === "IMAGE")
      .map((media) => ({
        url: media.image?.url ?? "",
        alt: media.alt ?? "",
      })),
    variants: node.variants.nodes.map((variant) =>
      toExistingVariant(variant, variantRefs),
    ),
    metafields: readMetafields(node, productRefs, "pmf"),
  };
}

/**
 * Resolve CSV handles to products and everything the planner diffs against.
 *
 * `productByIdentifier` rather than the `products(query:)` search: search
 * matches handles loosely, and writing a price to a near-miss product is the
 * failure this feature can least afford. The tradeoff is one aliased field per
 * handle, hence the batching.
 *
 * Handles are passed as GraphQL variables rather than interpolated, so a handle
 * containing quotes cannot break out into the query body.
 */
export async function getProductsForUpdate(
  admin: Admin,
  handles: string[],
  productRefs: MetafieldRef[],
  variantRefs: MetafieldRef[],
): Promise<Map<string, ExistingProduct>> {
  const unique = [...new Set(handles.map((handle) => handle.trim()))].filter(
    Boolean,
  );
  const found = new Map<string, ExistingProduct>();
  const selection = productSelection(productRefs, variantRefs);

  for (let start = 0; start < unique.length; start += HANDLE_BATCH_SIZE) {
    const batch = unique.slice(start, start + HANDLE_BATCH_SIZE);

    const declarations = batch
      .map((_, index) => `$h${index}: String!`)
      .join(", ");
    const selections = batch
      .map(
        (_, index) => `
        p${index}: productByIdentifier(identifier: { handle: $h${index} }) {
          ${selection}
        }`,
      )
      .join("");

    const document = `#graphql
      query ProductsForUpdate(${declarations}) {${selections}
      }
    `;

    const variables: Record<string, string> = {};
    batch.forEach((handle, index) => {
      variables[`h${index}`] = handle;
    });

    const data = await query<Record<string, ProductNode | null>>(
      admin,
      document,
      variables,
    );

    batch.forEach((handle, index) => {
      const node = data[`p${index}`];
      if (!node) return;
      // Keyed on the handle as the file spelled it, lowercased, because that
      // is the key the planner groups rows under.
      found.set(
        handle.toLowerCase(),
        toExistingProduct(node, productRefs, variantRefs),
      );
    });
  }

  return found;
}

/**
 * Look up products by title, for files with no handle column.
 *
 * Shopify's `title:` search is a prefix/fuzzy match, so everything it returns
 * is filtered to an exact case-insensitive title before being used. A title
 * matching several products is returned in `ambiguous` rather than resolved by
 * guessing — writing one product's data over another's is precisely what this
 * importer exists to prevent.
 */
export async function getProductsForUpdateByTitle(
  admin: Admin,
  titles: string[],
  productRefs: MetafieldRef[],
  variantRefs: MetafieldRef[],
): Promise<{
  products: Map<string, ExistingProduct>;
  ambiguous: Set<string>;
}> {
  const document = `#graphql
    query ProductsForUpdateByTitle(
      $search: String!
      $pageSize: Int!
      $cursor: String
    ) {
      products(first: $pageSize, query: $search, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ${productSelection(productRefs, variantRefs)}
        }
      }
    }
  `;

  const wanted = new Set(titles.map((title) => title.trim().toLowerCase()));
  const products = new Map<string, ExistingProduct>();
  const ambiguous = new Set<string>();
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
        pageSize: 10,
        cursor,
      });

      for (const node of data.products.nodes) {
        const key = node.title.trim().toLowerCase();
        if (!wanted.has(key)) continue;
        if (seenIds.has(node.id)) continue;
        seenIds.add(node.id);

        if (products.has(key)) {
          ambiguous.add(key);
          continue;
        }
        products.set(key, toExistingProduct(node, productRefs, variantRefs));
      }

      cursor = data.products.pageInfo.hasNextPage
        ? data.products.pageInfo.endCursor
        : null;
    } while (cursor);
  }

  // A title that turned out to match several products cannot be used at all,
  // so the first match is withdrawn rather than left to win by accident.
  for (const key of ambiguous) products.delete(key);

  return { products, ambiguous };
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

const LOCATIONS = `#graphql
  query ShopLocations($cursor: String) {
    locations(first: 50, after: $cursor, includeInactive: false) {
      pageInfo { hasNextPage endCursor }
      nodes { id name }
    }
  }
`;

export type ShopLocation = { id: string; name: string };

/** The store's active locations, for the inventory quantity target. */
export async function listLocations(admin: Admin): Promise<ShopLocation[]> {
  const locations: ShopLocation[] = [];
  let cursor: string | null = null;

  do {
    const data: {
      locations: { pageInfo: PageInfo; nodes: ShopLocation[] };
    } = await query(admin, LOCATIONS, { cursor });

    locations.push(...data.locations.nodes);
    cursor = data.locations.pageInfo.hasNextPage
      ? data.locations.pageInfo.endCursor
      : null;
  } while (cursor);

  return locations;
}

// ---------------------------------------------------------------------------
// Resolving names to ids
// ---------------------------------------------------------------------------

/**
 * Resolve metaobject handles to gids, for `metaobject_reference` metafields.
 *
 * A merchant writes the handle in the CSV because that is what is legible; the
 * API needs the gid. Batched and aliased like the product lookup.
 */
export async function resolveMetaobjectHandles(
  admin: Admin,
  refs: { type: string; handle: string }[],
): Promise<Map<string, string>> {
  const unique = new Map<string, { type: string; handle: string }>();
  for (const ref of refs) {
    unique.set(`${ref.type}:${ref.handle}`, ref);
  }

  const resolved = new Map<string, string>();
  const entries = [...unique.entries()];

  for (let start = 0; start < entries.length; start += 20) {
    const batch = entries.slice(start, start + 20);

    const declarations = batch
      .map((_, index) => `$t${index}: String!, $h${index}: String!`)
      .join(", ");
    const selections = batch
      .map(
        (_, index) => `
        m${index}: metaobjectByHandle(
          handle: { type: $t${index}, handle: $h${index} }
        ) { id }`,
      )
      .join("");

    const document = `#graphql
      query MetaobjectsByHandle(${declarations}) {${selections}
      }
    `;

    const variables: Record<string, string> = {};
    batch.forEach(([, ref], index) => {
      variables[`t${index}`] = ref.type;
      variables[`h${index}`] = ref.handle;
    });

    const data = await query<Record<string, { id: string } | null>>(
      admin,
      document,
      variables,
    );

    batch.forEach(([key], index) => {
      const node = data[`m${index}`];
      if (node) resolved.set(key, node.id);
    });
  }

  return resolved;
}

const CATEGORY_SEARCH = `#graphql
  query FindProductCategory($search: String!) {
    taxonomy {
      categories(first: 10, search: $search) {
        nodes { id fullName name isLeaf }
      }
    }
  }
`;

/**
 * Resolve a category name from the CSV to a taxonomy gid.
 *
 * Only an exact match on the full path or the leaf name is accepted. The search
 * is fuzzy and will happily return "Shirts & Tops" for "Shorts"; assigning a
 * product to a category nobody asked for is worse than reporting that the name
 * was not recognised.
 */
export async function findCategories(
  admin: Admin,
  names: string[],
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();

  for (const name of [...new Set(names.map((value) => value.trim()))]) {
    if (!name) continue;

    const data = await query<{
      taxonomy: {
        categories: {
          nodes: {
            id: string;
            fullName: string;
            name: string;
            isLeaf: boolean;
          }[];
        };
      };
    }>(admin, CATEGORY_SEARCH, { search: name });

    const wanted = name.toLowerCase();
    const match = data.taxonomy.categories.nodes.find(
      (node) =>
        node.fullName.toLowerCase() === wanted ||
        node.name.toLowerCase() === wanted,
    );

    if (match) resolved.set(wanted, match.id);
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Metafield value conversion
// ---------------------------------------------------------------------------

/** Metafield types whose value is a metaobject gid. */
export const METAOBJECT_TYPES = [
  "metaobject_reference",
  "list.metaobject_reference",
  "mixed_reference",
  "list.mixed_reference",
];

/**
 * Metaobject handles a file refers to, so they can be resolved in one pass
 * before planning rather than one query at a time inside it.
 *
 * The cell is `type:handle` — the type is required because a handle is only
 * unique within its definition, and the metafield's own definition does not
 * carry it in a form this code can read back.
 */
export function metaobjectRefsIn(cell: string): { type: string; handle: string }[] {
  return cell
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf(":");
      if (separator === -1) return null;
      return {
        type: part.slice(0, separator).trim(),
        handle: part.slice(separator + 1).trim(),
      };
    })
    .filter((ref): ref is { type: string; handle: string } => ref !== null);
}

/**
 * Convert a CSV cell to the string `metafieldsSet` expects for a given type.
 *
 * Returns a message rather than throwing, so a bad cell becomes one error row
 * next to the fields that did import.
 */
export function toMetafieldValue(
  type: string,
  cell: string,
  metaobjects: Map<string, string>,
): { ok: true; value: string } | { ok: false; message: string } {
  const trimmed = cell.trim();

  if (type === "rich_text_field") {
    try {
      return { ok: true, value: cellToRichTextValue(trimmed) };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (METAOBJECT_TYPES.includes(type)) {
    const refs = metaobjectRefsIn(trimmed);
    if (!refs.length) {
      return {
        ok: false,
        message: `Expected "type:handle" (several separated by ";"), got "${trimmed}".`,
      };
    }

    const ids: string[] = [];
    for (const ref of refs) {
      const id = metaobjects.get(`${ref.type}:${ref.handle}`);
      if (!id) {
        return {
          ok: false,
          message: `No "${ref.type}" metaobject with the handle "${ref.handle}".`,
        };
      }
      ids.push(id);
    }

    return type.startsWith("list.")
      ? { ok: true, value: JSON.stringify(ids) }
      : { ok: true, value: ids[0] };
  }

  if (type === "boolean") {
    const value = trimmed.toLowerCase();
    if (["true", "yes", "y", "1"].includes(value)) {
      return { ok: true, value: "true" };
    }
    if (["false", "no", "n", "0"].includes(value)) {
      return { ok: true, value: "false" };
    }
    return { ok: false, message: `"${trimmed}" is not TRUE or FALSE.` };
  }

  if (type === "number_integer" || type === "number_decimal") {
    const value = Number(trimmed.replace(/,/g, ""));
    if (!Number.isFinite(value)) {
      return { ok: false, message: `"${trimmed}" is not a number.` };
    }
    if (type === "number_integer" && !Number.isInteger(value)) {
      return { ok: false, message: `"${trimmed}" is not a whole number.` };
    }
    return { ok: true, value: String(value) };
  }

  // A list of anything else is a JSON array. A cell already holding one is
  // passed through, so a file exported by Shopify's own tooling round-trips.
  if (type.startsWith("list.")) {
    if (trimmed.startsWith("[")) {
      try {
        JSON.parse(trimmed);
        return { ok: true, value: trimmed };
      } catch {
        return { ok: false, message: "Looks like JSON but does not parse." };
      }
    }
    return {
      ok: true,
      value: JSON.stringify(
        trimmed
          .split(";")
          .map((part) => part.trim())
          .filter(Boolean),
      ),
    };
  }

  return { ok: true, value: trimmed };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

// `productUpdate` rather than `productSet`: `productSet` treats list fields as
// the complete state and deletes entries the input omits, which would destroy
// exactly the variants, metafields and collections this feature exists to
// preserve. `productUpdate` touches only the fields it is given.
const UPDATE_PRODUCT = `#graphql
  mutation UpdateProductFields(
    $product: ProductUpdateInput!
    $media: [CreateMediaInput!]
  ) {
    productUpdate(product: $product, media: $media) {
      product { id handle }
      userErrors { field message }
    }
  }
`;

export async function updateProductFields(
  admin: Admin,
  productId: string,
  input: Record<string, unknown>,
  media: { originalSource: string; alt: string; mediaContentType: string }[],
): Promise<{ ok: boolean; errors: string[] }> {
  const data = await query<{
    productUpdate: { userErrors: UserError[] };
  }>(admin, UPDATE_PRODUCT, {
    product: { id: productId, ...input },
    ...(media.length ? { media } : {}),
  });

  const { userErrors } = data.productUpdate;
  return { ok: userErrors.length === 0, errors: formatUserErrors(userErrors) };
}

const UPDATE_VARIANTS = `#graphql
  mutation UpdateProductVariants(
    $productId: ID!
    $variants: [ProductVariantsBulkInput!]!
  ) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku }
      userErrors { field message code }
    }
  }
`;

/**
 * Update variants that already exist.
 *
 * `productVariantsBulkUpdate` only ever touches the variants named in the
 * input — unlike `productSet`, variants left out are not deleted. That is the
 * property this importer depends on, and the reason it is used even for a
 * single-variant change.
 */
export async function updateVariants(
  admin: Admin,
  productId: string,
  variants: Record<string, unknown>[],
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  for (let start = 0; start < variants.length; start += VARIANT_BATCH_SIZE) {
    const batch = variants.slice(start, start + VARIANT_BATCH_SIZE);
    const data = await query<{
      productVariantsBulkUpdate: { userErrors: UserError[] };
    }>(admin, UPDATE_VARIANTS, { productId, variants: batch });

    errors.push(
      ...formatUserErrors(data.productVariantsBulkUpdate.userErrors),
    );
  }

  return { ok: errors.length === 0, errors };
}

const SET_INVENTORY = `#graphql
  mutation SetInventoryQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup { id }
      userErrors { field message code }
    }
  }
`;

/**
 * Set available quantities at one location.
 *
 * `changeFromQuantity` is deliberately omitted from each quantity, which is how
 * the API opts out of the compare-and-swap check. The plan was built against a
 * read taken moments earlier and the merchant has just approved it; failing the
 * whole batch because a single unit sold in between would be worse than
 * applying it.
 */
export async function setInventoryQuantities(
  admin: Admin,
  locationId: string,
  quantities: { inventoryItemId: string; quantity: number }[],
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  for (
    let start = 0;
    start < quantities.length;
    start += INVENTORY_BATCH_SIZE
  ) {
    const batch = quantities.slice(start, start + INVENTORY_BATCH_SIZE);
    const data = await query<{
      inventorySetQuantities: { userErrors: UserError[] };
    }>(admin, SET_INVENTORY, {
      input: {
        name: "available",
        reason: "correction",
        quantities: batch.map((entry) => ({
          inventoryItemId: entry.inventoryItemId,
          locationId,
          quantity: entry.quantity,
        })),
      },
    });

    errors.push(...formatUserErrors(data.inventorySetQuantities.userErrors));
  }

  return { ok: errors.length === 0, errors };
}

const METAFIELDS_SET = `#graphql
  mutation SetProductImportMetafields($metafields: [MetafieldsSetInput!]!) {
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
  type: string;
  value: string;
};

/** Write metafield values for products and variants alike. */
export async function setMetafields(
  admin: Admin,
  writes: MetafieldWrite[],
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  for (let start = 0; start < writes.length; start += METAFIELD_BATCH_SIZE) {
    const batch = writes.slice(start, start + METAFIELD_BATCH_SIZE);
    const data = await query<{
      metafieldsSet: { userErrors: UserError[] };
    }>(admin, METAFIELDS_SET, { metafields: batch });

    errors.push(...formatUserErrors(data.metafieldsSet.userErrors));
  }

  return { ok: errors.length === 0, errors };
}
