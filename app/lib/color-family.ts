// The Colour Family CSV's column names and plan shape.
//
// Split from `color-family.server.ts` for the same reason
// `variant-metafield-columns.ts` is split from its own server module: the page
// component needs the column names for its prose and the plan type for its
// review table, and pulling the server module into the client bundle for that
// would drag `product-write.server.ts` along with it.
//
// Everything here is pure data and pure string handling.

import { IDENTITY_COLUMNS } from "./variant-metafield-columns";

export { IDENTITY_COLUMNS };

/**
 * The family this variant is in, written the way a person reads it —
 * `Peach Tones`, not a gid.
 *
 * The one writable reference column. Where it lands depends on how the store
 * models families: on the variant's own metafield, or at this variant's place
 * in its product's list. A handle is accepted too, and wins over a display name
 * when both could match, so a round trip of a handle-style export writes back
 * exactly what it read.
 */
export const FAMILY_COLUMN = "color family";

/**
 * The assigned family's handle.
 *
 * Read-only, and present because display names are not unique: when two
 * families share a name this is the only cell that says which one the variant
 * actually points at. It is *not* what decides which family a row edits — see
 * `FAMILY_HEX_COLUMN`.
 */
export const FAMILY_HANDLE_COLUMN = "color family handle";

/**
 * The variant's place in its product, 1-based.
 *
 * Read-only, and informational only: the importer takes a variant's position
 * from the store after matching the row by SKU, never from this cell or from
 * where the row sits in the file. Sorting or filtering the spreadsheet is
 * therefore safe. It is exported because with a positional list this is the
 * number that explains *why* a given colour is on a given row.
 */
export const POSITION_COLUMN = "variant position";

/**
 * The family's own colour value, as hex.
 *
 * Writable, and it edits the **metaobject entry** rather than the variant — so
 * every variant in that family changes with it. The entry edited is the one
 * named by `FAMILY_COLUMN` on the same row, not the one in
 * `FAMILY_HANDLE_COLUMN`: a row that both moves a variant to `Peach Tones` and
 * sets a hex means that hex for `Peach Tones`.
 *
 * Only emitted when the definition actually has a `color` field.
 */
export const FAMILY_HEX_COLUMN = "color family hex";

/** Every other field of the family entry, also writable, also entry-wide. */
export const FAMILY_FIELD_PREFIX = "color family: ";

export function familyFieldColumn(key: string): string {
  return `${FAMILY_FIELD_PREFIX}${key}`;
}

export function familyFieldKeyOf(column: string): string | null {
  return column.startsWith(FAMILY_FIELD_PREFIX)
    ? column.slice(FAMILY_FIELD_PREFIX.length)
    : null;
}

/**
 * The Shopify standard colour on this variant, and its hex.
 *
 * Both read-only. They come from the product's `shopify.color-pattern` list at
 * this variant's position, falling back to a link the family carries itself.
 * Writing either would mean editing a standard definition's entries, which is
 * a far wider change than anything this page offers.
 */
export const SHOPIFY_COLOR_COLUMN = "shopify color";
export const SHOPIFY_COLOR_HEX_COLUMN = "shopify color hex";

/** Columns read for context and never written back. */
export const READ_ONLY_COLUMNS: string[] = [
  FAMILY_HANDLE_COLUMN,
  POSITION_COLUMN,
  SHOPIFY_COLOR_COLUMN,
  SHOPIFY_COLOR_HEX_COLUMN,
];

/** How a family is written out: its display name, or its handle. */
export type RefStyle = "name" | "handle";

export function colorFamilyExportFilename(kind: "values" | "template") {
  const date = new Date().toISOString().slice(0, 10);
  return `color-family-${kind}-${date}.csv`;
}

// ---------------------------------------------------------------------------
// The plan, as the review table reads it
// ---------------------------------------------------------------------------

/**
 * What a row wants done about its variant's family.
 *
 * Always the row's *intent*, for the review table. Whether it becomes a write
 * of its own depends on where the metafield lives: a variant-owned one is
 * written straight from here, a product-owned one is folded into a
 * `ProductFamilyChange` first.
 */
export type FamilyAssignment =
  | { kind: "write"; handle: string; value: string }
  | { kind: "clear" };

export type ColorFamilyRowPlan = {
  rowNumber: number;
  /** How the row is shown in the review table. */
  label: string;
  sku: string;
  /** Resolved once the row matched exactly one variant. */
  variantId?: string;
  productId?: string;
  action: "update" | "unchanged" | "error";
  /** `column: old → new`, one per change. */
  changes: string[];
  message?: string;
  assign?: FamilyAssignment;
};

/**
 * One product's colour-family metafield, rebuilt from the rows that named its
 * variants.
 *
 * Only used when the metafield lives on the **product**. In this store's model
 * it is a list whose Nth entry belongs to the Nth variant, so a single variant
 * changing family means rewriting the whole list — which in turn means every
 * variant of that product has to be accounted for, including the ones the file
 * never mentions. `value` is the finished list; `null` deletes the metafield.
 */
export type ProductFamilyChange = {
  productId: string;
  /** The product's handle, for the review table. */
  label: string;
  /** Rows that contributed, for the message when they disagree. */
  rowNumbers: number[];
  value: string | null;
  changes: string[];
};

/**
 * An edit to a family entry, hoisted out of the rows that asked for it.
 *
 * One row per variant means every variant of a family repeats that family's
 * fields, so a file of forty Peach rows asks for the same entry write forty
 * times. Collapsing them here is what turns that into one `metaobjectUpsert` —
 * and what makes a *disagreement* between those rows detectable at all,
 * instead of the last row silently winning.
 */
export type FamilyEntryChange = {
  handle: string;
  /** The family's display name where it has one, for the review table. */
  label: string;
  rowNumbers: number[];
  /** Field key → new value, ready for `upsertEntry`. */
  values: Record<string, string>;
  changes: string[];
};

export type ColorFamilyPlan = {
  /** The metaobject type being edited, e.g. `color_family`. */
  type: string;
  /** The metafield being assigned, as `namespace.key`. */
  column: string;
  owner: "product" | "variant";
  /** Whether the product's list lines up with its variants, one each. */
  positional: boolean;
  rows: ColorFamilyRowPlan[];
  products: ProductFamilyChange[];
  families: FamilyEntryChange[];
  counts: { update: number; unchanged: number; error: number };
  /** Columns in the file matching nothing this page knows about. */
  unknownColumns: string[];
  /** Columns that are read and deliberately not written. */
  ignoredColumns: string[];
  assignCount: number;
  clearCount: number;
  /** Field values across every family entry that would be written. */
  familyFieldCount: number;
};
