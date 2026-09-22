// The variant metafield CSV's column names and plan shape.
//
// Split out from `variant-metafield-csv.server.ts` for one reason: that module
// calls `toMetafieldValue` and friends from `product-write.server.ts`, so
// importing it from a route *component* pulls server code into the client
// bundle and the build refuses. The page needs the column names for its prose
// and the plan type for its review table, and neither of those needs the API.
//
// Everything here is therefore pure data and pure string handling, importable
// from either side.

/** The product's handle. The fallback match key, and the stable one. */
export const HANDLE_COLUMN = "handle";
/** The product's title. Never written — it is here to make the file readable. */
export const TITLE_COLUMN = "title";
/** The primary match key. */
export const SKU_COLUMN = "variant sku";
/** The variant's title, e.g. `Peach / S`. Never written. */
export const VARIANT_TITLE_COLUMN = "variant title";

export const OPTION_COLUMNS: string[] = [1, 2, 3].flatMap((index) => [
  `option${index} name`,
  `option${index} value`,
]);

/**
 * Everything left of the metafield columns.
 *
 * All of it is read-only on import: it identifies the row, and is never
 * written. Editing a cell here does not rename anything — it changes which
 * variant the row matches, or stops it matching at all.
 *
 * There is deliberately no `variant id` column. A gid would be the most robust
 * key, and it is also the one value a merchant cannot sanity-check in a
 * spreadsheet: a stale or hand-mangled gid writes to the wrong variant in
 * silence, where a wrong SKU fails loudly.
 */
export const IDENTITY_COLUMNS: string[] = [
  HANDLE_COLUMN,
  TITLE_COLUMN,
  SKU_COLUMN,
  VARIANT_TITLE_COLUMN,
  ...OPTION_COLUMNS,
];

/**
 * What a product metafield's column is called.
 *
 * Variant metafields keep the bare `namespace.key`, because they are what this
 * section is for; a product's is prefixed so the two owners cannot be confused
 * in a file that carries both — `shopify.color-pattern` is defined on the
 * product, `custom.color_family` on the variant, and writing the wrong one is
 * not a mistake the API would catch.
 *
 * The prefix cannot collide with a variant column. A metafield key may not
 * contain a dot, so a variant column always has exactly two dot-separated
 * segments and a prefixed product column always has three.
 */
export const PRODUCT_COLUMN_PREFIX = "product.";

export function productColumnName(column: string): string {
  return `${PRODUCT_COLUMN_PREFIX}${column}`;
}

/**
 * What an expanded metaobject field's column is called.
 *
 * `custom.color_family > color` holds the `color` field of whatever entry
 * `custom.color_family` points at. Read-only: writing it would mean editing the
 * metaobject entry, which changes the value for every product referencing it —
 * a different operation with different blast radius, and one the metaobject
 * import page on `/app` already does properly.
 */
export const EXPANDED_SEPARATOR = " > ";

export function expandedColumnName(column: string, fieldKey: string): string {
  return `${column}${EXPANDED_SEPARATOR}${fieldKey}`;
}

export function isExpandedColumn(column: string): boolean {
  return column.includes(EXPANDED_SEPARATOR);
}

/** How a metaobject reference is written out. */
export type RefStyle = "name" | "handle";

/** Which optional column groups an export includes. */
export type ExportOptions = {
  refs: RefStyle;
  /** Product metafield columns. Exported and, unlike the next one, importable. */
  productMetafields: boolean;
  /** The referenced entries' own fields, expanded into read-only columns. */
  expandEntries: boolean;
};

/** Normalised form for a display-name comparison. */
export function normalizeDisplayName(value: string): string {
  return value.trim().toLowerCase();
}

export function variantMetafieldExportFilename(
  kind: "values" | "template" | "definitions",
) {
  const date = new Date().toISOString().slice(0, 10);
  return `variant-metafields-${kind}-${date}.csv`;
}

// ---------------------------------------------------------------------------
// The plan, as the review table reads it
// ---------------------------------------------------------------------------

export type MetafieldOwner = "PRODUCT" | "PRODUCTVARIANT";

export type PlannedWrite = {
  column: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
};

export type PlannedDelete = {
  column: string;
  namespace: string;
  key: string;
};

export type VariantRowPlan = {
  rowNumber: number;
  /** How the row is shown in the review table. */
  label: string;
  sku: string;
  /** Resolved once the row matched exactly one variant. */
  variantId?: string;
  productId?: string;
  action: "update" | "unchanged" | "error";
  /** `column: old → new`, one per change, for the review table. */
  changes: string[];
  message?: string;
  writes: PlannedWrite[];
  deletes: PlannedDelete[];
};

/**
 * A product metafield change, hoisted out of the rows that asked for it.
 *
 * One row per variant means every variant of a product repeats that product's
 * metafields, so a file of forty rows for one product asks for the same write
 * forty times. Collapsing them here is what turns that into one write — and
 * what makes a *disagreement* between those rows detectable at all, instead of
 * the last row silently winning.
 */
export type ProductChange = {
  productId: string;
  /** The product's handle, for the review table. */
  label: string;
  /** Rows that asked for this change, for the message when they disagree. */
  rowNumbers: number[];
  writes: PlannedWrite[];
  deletes: PlannedDelete[];
  changes: string[];
};

export type VariantImportPlan = {
  rows: VariantRowPlan[];
  products: ProductChange[];
  counts: { update: number; unchanged: number; error: number };
  /** Columns in the file that match no definition and no identity column. */
  unknownColumns: string[];
  /** Columns that are read and deliberately not written. */
  ignoredColumns: string[];
  writeCount: number;
  deleteCount: number;
  productWriteCount: number;
  productDeleteCount: number;
};
