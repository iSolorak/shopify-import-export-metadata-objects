// The catalogue of product CSV columns this app can write, and the header
// resolver that maps a file's columns onto them.
//
// Shopify's own Products → Export is the reference format, so a file straight
// out of the admin needs no configuration at all: every column it emits either
// resolves here by name or is listed as deliberately ignored. A file from
// anywhere else — a supplier's price list, a spreadsheet someone maintains by
// hand — resolves nothing automatically, and the page's mapping UI lets the
// user point each column at a field instead. Both paths end in the same
// `Map<columnName, FieldTarget>`, so nothing downstream knows which it was.
//
// Every field here is *writable*. Columns Shopify exports but the Admin API
// will not accept back — `Gift Card`, the per-market price columns — are listed
// in IGNORED_COLUMNS instead, so the UI can say "read and ignored" rather than
// "unrecognised". Silently dropping them is what makes an unrecognised-column
// warning worth reading.

import { METAFIELD_COLUMN } from "./shopify-export-csv";
import type { RichTextDefinition } from "./product-metafields.server";

/** Where a value lands, which decides which mutation carries it. */
export type FieldScope =
  | "identity"
  | "product"
  | "variant"
  | "inventory"
  | "media"
  | "option";

export type FieldTarget = {
  /** Stable id used in the mapping form and the plan, e.g. `variant.price`. */
  field: string;
  /** How the column is named in Shopify's own export. */
  label: string;
  scope: FieldScope;
  /** Set for metafield targets; drives value conversion and the owner. */
  metafield?: { namespace: string; key: string; type: string; owner: "PRODUCT" | "PRODUCTVARIANT" };
  /** 1-3 for the option columns, so option name and value pair up. */
  optionIndex?: number;
};

/**
 * Reduce a header to its comparable form.
 *
 * Borrowed from `product-video-csv.ts`: the same file re-saved through a
 * different tool turns `Variant Price` into `variant_price` or `variantPrice`,
 * and matching on letters and digits alone accepts all of them without keeping
 * a list of spellings.
 */
export function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The fixed part of the catalogue, in the order the mapping dropdown lists it.
 *
 * `Handle` and `Title` are `identity` rather than `product`: they are how a row
 * finds its product, and writing them is a separate decision. Title is in fact
 * writable and is offered as `product.title` too — see PRODUCT_FIELDS — but the
 * identity role comes first, because a file that maps Title only to a rename
 * has nothing left to match on.
 */
export const IDENTITY_FIELDS: FieldTarget[] = [
  { field: "identity.handle", label: "Handle", scope: "identity" },
  { field: "identity.title", label: "Title", scope: "identity" },
];

export const PRODUCT_FIELDS: FieldTarget[] = [
  { field: "product.title", label: "Title (rename)", scope: "product" },
  { field: "product.descriptionHtml", label: "Body (HTML)", scope: "product" },
  { field: "product.vendor", label: "Vendor", scope: "product" },
  { field: "product.productType", label: "Type", scope: "product" },
  { field: "product.tags", label: "Tags", scope: "product" },
  { field: "product.status", label: "Status", scope: "product" },
  { field: "product.published", label: "Published", scope: "product" },
  { field: "product.handle", label: "Handle (rename)", scope: "product" },
  { field: "product.templateSuffix", label: "Template Suffix", scope: "product" },
  { field: "product.category", label: "Product Category", scope: "product" },
  { field: "product.seoTitle", label: "SEO Title", scope: "product" },
  { field: "product.seoDescription", label: "SEO Description", scope: "product" },
];

export const VARIANT_FIELDS: FieldTarget[] = [
  { field: "variant.sku", label: "Variant SKU", scope: "variant" },
  { field: "variant.price", label: "Variant Price", scope: "variant" },
  {
    field: "variant.compareAtPrice",
    label: "Variant Compare At Price",
    scope: "variant",
  },
  { field: "variant.barcode", label: "Variant Barcode", scope: "variant" },
  { field: "variant.grams", label: "Variant Grams", scope: "variant" },
  { field: "variant.weight", label: "Variant Weight", scope: "variant" },
  { field: "variant.weightUnit", label: "Variant Weight Unit", scope: "variant" },
  {
    field: "variant.requiresShipping",
    label: "Variant Requires Shipping",
    scope: "variant",
  },
  { field: "variant.taxable", label: "Variant Taxable", scope: "variant" },
  {
    field: "variant.inventoryPolicy",
    label: "Variant Inventory Policy",
    scope: "variant",
  },
  {
    field: "variant.tracked",
    label: "Variant Inventory Tracker",
    scope: "variant",
  },
  { field: "variant.cost", label: "Cost per item", scope: "variant" },
  {
    field: "variant.countryOfOrigin",
    label: "Variant Country of Origin",
    scope: "variant",
  },
  {
    field: "variant.hsCode",
    label: "Variant HS Code",
    scope: "variant",
  },
];

export const INVENTORY_FIELDS: FieldTarget[] = [
  {
    field: "inventory.available",
    label: "Variant Inventory Qty",
    scope: "inventory",
  },
];

export const MEDIA_FIELDS: FieldTarget[] = [
  { field: "media.src", label: "Image Src", scope: "media" },
  { field: "media.alt", label: "Image Alt Text", scope: "media" },
];

/**
 * Option columns, which exist to *match* a variant rather than to change it.
 *
 * `Option1 Value` and friends are how a row identifies which variant it means
 * when there is no SKU to go on. Renaming an option or changing a value would
 * be a structural edit — it can reshape or destroy variants — so this importer
 * reads them and never writes them.
 */
export const OPTION_FIELDS: FieldTarget[] = [1, 2, 3].flatMap((index) => [
  {
    field: `option${index}.name`,
    label: `Option${index} Name`,
    scope: "option" as const,
    optionIndex: index,
  },
  {
    field: `option${index}.value`,
    label: `Option${index} Value`,
    scope: "option" as const,
    optionIndex: index,
  },
]);

/** Everything mappable that does not depend on the store's own metafields. */
export const STATIC_FIELDS: FieldTarget[] = [
  ...IDENTITY_FIELDS,
  ...PRODUCT_FIELDS,
  ...VARIANT_FIELDS,
  ...INVENTORY_FIELDS,
  ...MEDIA_FIELDS,
  ...OPTION_FIELDS,
];

/**
 * Columns read, understood, and deliberately not written — with the reason,
 * because "ignored" without one reads like a bug.
 */
export const IGNORED_COLUMNS: Record<string, string> = {
  giftcard: "Gift Card cannot be changed on an existing product.",
  varianttaxcode:
    "Variant Tax Code is deprecated on this Admin API version.",
  variantfulfillmentservice:
    "Fulfillment service is managed through the location, not the product CSV.",
  variantimage:
    "Per-variant images are not assigned by this importer; images are appended to the product gallery.",
  imageposition:
    "Images are appended in file order; existing media is never reordered.",
};

/** Prefixes of column families exported by Shopify that this app never writes. */
const IGNORED_PREFIXES = [
  "googleshopping",
  "compareatprice",
  "price",
  "included",
];

/**
 * Is this a column we knowingly skip rather than one we failed to recognise?
 *
 * The prefix list covers the per-market families (`Price / United States`,
 * `Included / International`), which vary by store and cannot be enumerated.
 */
export function ignoredReason(header: string): string | null {
  const normalized = normalizeHeader(header);
  const exact = IGNORED_COLUMNS[normalized];
  if (exact) return exact;

  // A market column is `Price / <market>`, so the slash is what distinguishes
  // it from the plain `Price` a generic CSV might use for the variant price.
  if (header.includes("/")) {
    const family = normalizeHeader(header.split("/")[0]);
    if (IGNORED_PREFIXES.includes(family)) {
      return "Market-specific pricing and publishing are out of scope.";
    }
  }

  return null;
}

/** Turn a store's metafield definitions into mappable targets. */
export function metafieldTargets(
  definitions: RichTextDefinition[],
  owner: "PRODUCT" | "PRODUCTVARIANT",
): FieldTarget[] {
  const prefix = owner === "PRODUCT" ? "product" : "variant";
  return definitions.map((definition) => ({
    field: `metafield.${prefix}.${definition.column}`,
    label: `${definition.name} (${prefix}.metafields.${definition.column})`,
    scope: owner === "PRODUCT" ? "product" : "variant",
    metafield: {
      namespace: definition.namespace,
      key: definition.key,
      type: definition.type,
      owner,
    },
  }));
}

export type ResolvedHeaders = {
  /** CSV column name → the field it feeds. */
  byColumn: Map<string, FieldTarget>;
  /** Columns auto-detected from Shopify's names, for the "nothing to do" note. */
  autoMatched: string[];
  /** Columns understood and skipped on purpose, with the reason. */
  ignored: { column: string; reason: string }[];
  /** Columns nothing was made of. Mappable by hand. */
  unrecognised: string[];
};

/**
 * Work out which CSV column feeds which field.
 *
 * Three sources, in increasing precedence:
 *
 *  1. Shopify's column names, matched loosely on letters and digits.
 *  2. `… (product.metafields.ns.key)` columns, resolved against the store's own
 *     definitions — an export carries a column for every metafield the product
 *     has, including ones no definition covers, and those are unrecognised
 *     rather than silently written to a namespace the admin cannot display.
 *  3. The user's explicit mapping, which overrides both. Mapping a column to
 *     the empty string is how the UI says "don't import this one", and it wins
 *     over auto-detection so a bad guess can always be switched off.
 */
export function resolveHeaders(
  headers: string[],
  targets: FieldTarget[],
  userMapping: Record<string, string> = {},
): ResolvedHeaders {
  const byField = new Map(targets.map((target) => [target.field, target]));

  // Auto-detection matches on the label, which is the Shopify column name.
  // Built from `targets` rather than STATIC_FIELDS so a metafield column in
  // Shopify's own spelling resolves through the same path.
  const byLabel = new Map<string, FieldTarget>();
  for (const target of targets) {
    const key = normalizeHeader(target.label);
    // First wins, and the identity fields are listed first, so a bare `Title`
    // column resolves to matching rather than to renaming. The rename targets
    // are deliberately labelled `Title (rename)` / `Handle (rename)` so they
    // normalize differently and stay reachable from the dropdown.
    if (!byLabel.has(key)) byLabel.set(key, target);
  }

  const byColumn = new Map<string, FieldTarget>();
  const autoMatched: string[] = [];
  const ignored: { column: string; reason: string }[] = [];
  const unrecognised: string[] = [];
  // One field per column and one column per field: a file carrying both
  // `Body (HTML)` and `Body HTML` would otherwise have the second silently win.
  const claimed = new Set<string>();

  for (const raw of headers) {
    const column = raw.trim();
    if (!column) continue;

    // --- The user's decision, first and last ------------------------------
    if (Object.prototype.hasOwnProperty.call(userMapping, column)) {
      const field = userMapping[column];
      if (!field) continue; // explicitly "don't import"

      const target = byField.get(field);
      if (target && !claimed.has(field)) {
        claimed.add(field);
        byColumn.set(column, target);
      }
      continue;
    }

    // --- Shopify's own column names ---------------------------------------
    const auto = byLabel.get(normalizeHeader(column));
    if (auto && !claimed.has(auto.field)) {
      claimed.add(auto.field);
      byColumn.set(column, auto);
      autoMatched.push(column);
      continue;
    }

    // --- `Label (product.metafields.ns.key)` ------------------------------
    const match = METAFIELD_COLUMN.exec(column);
    if (match) {
      const owner = match[1] === "variant" ? "PRODUCTVARIANT" : "PRODUCT";
      const prefix = owner === "PRODUCT" ? "product" : "variant";
      const target = byField.get(`metafield.${prefix}.${match[2]}.${match[3]}`);

      if (target && !claimed.has(target.field)) {
        claimed.add(target.field);
        byColumn.set(column, target);
        autoMatched.push(column);
      } else if (!target) {
        // A metafield the store has no definition for. Writing it would put a
        // value somewhere the admin will not show it, so it is surfaced rather
        // than guessed at.
        ignored.push({
          column,
          reason: `No ${prefix} metafield definition for ${match[2]}.${match[3]} on this store.`,
        });
      }
      continue;
    }

    const reason = ignoredReason(column);
    if (reason) ignored.push({ column, reason });
    else unrecognised.push(column);
  }

  return { byColumn, autoMatched, ignored, unrecognised };
}

// ---------------------------------------------------------------------------
// Cell parsing
// ---------------------------------------------------------------------------

/**
 * Shopify writes booleans as TRUE/FALSE, spreadsheets as true/1/yes.
 * Returns null for anything unrecognised so the planner can say so rather than
 * quietly reading a typo as `false`.
 */
export function parseBoolean(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(value)) return true;
  if (["false", "no", "n", "0"].includes(value)) return false;
  return null;
}

export function parseNumber(raw: string): number | null {
  // Tolerate a thousands separator and a currency symbol, which is what a
  // supplier's price list tends to carry.
  const cleaned = raw.trim().replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Shopify's Tags column is one comma-separated list per product. */
export function parseTags(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}
