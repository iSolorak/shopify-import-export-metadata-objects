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

/** How a metaobject reference is written out. */
export type RefStyle = "name" | "handle";

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

export type VariantWrite = {
  column: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
};

export type VariantDelete = {
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
  action: "update" | "unchanged" | "error";
  /** `column: old → new`, one per change, for the review table. */
  changes: string[];
  message?: string;
  writes: VariantWrite[];
  deletes: VariantDelete[];
};

export type VariantImportPlan = {
  rows: VariantRowPlan[];
  counts: { update: number; unchanged: number; error: number };
  /** Columns in the file that are neither an identity column nor a definition. */
  unknownColumns: string[];
  writeCount: number;
  deleteCount: number;
};
