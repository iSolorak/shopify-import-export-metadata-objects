// Turn products into the CSV the product importer reads back.
//
// Pure: no Admin API, no `query`, nothing async. The route does the fetching and
// hands the results here, which is the arrangement `variant-metafield-csv.server.ts`
// uses and for the same reason — the column rules are where the bugs live, and
// they are worth being able to reason about without a store in front of you.
//
// **The headings are `FieldTarget.label`**, which is Shopify's own column
// spelling and exactly what `resolveHeaders` auto-matches on. That is what
// closes the loop: a file out of here goes back through Update products with no
// mapping step, and a re-import of an unedited file plans no changes at all.
//
// The row shape is Shopify's too — one row per variant, product-level columns
// filled only on the product's first row, images continuing past the last
// variant in rows of their own. The importer reads that shape natively:
// `groupRows` keeps appending to the product opened by the first row, takes the
// first non-empty value for a product-level field, and treats a row that
// states nothing about a variant as an image row.

import type { ExistingProduct, ExistingVariant } from "./product-write.server";
import {
  METAOBJECT_TYPES,
  PRODUCT_REFERENCE_TYPES,
} from "./product-write.server";
import type { FieldTarget } from "./product-import-columns";

export type ProductExportOptions = {
  /**
   * Which location `Variant Inventory Qty` reports.
   *
   * Shopify's export writes one column per location; this app writes one
   * column, because that is what `setInventoryQuantities` writes back. Without
   * a location the column is exported empty rather than guessed at.
   */
  locationId?: string | null;
  /** Metaobject gid → handle, for reference metafields. */
  metaobjects?: Map<string, string>;
  /** Product gid → handle, for product reference metafields. */
  products?: Map<string, string>;
};

/** The separator both reference parsers split a cell on. */
const REFERENCE_SEPARATOR = ";";

/**
 * Is this metafield stored as gids the importer expects as handles?
 *
 * A reference metafield holds `gid://shopify/Metaobject/5`, and the importer
 * reads handles — `metaobjectRefsIn` splits on `;` and then on the first `:`,
 * which turns a gid into the type `["gid` and a handle of the rest. Exporting
 * the stored value verbatim therefore produces a file that fails on every row
 * of that column, and the failure takes the whole cell with it.
 */
function referenceKind(
  target: FieldTarget,
): "metaobject" | "product" | null {
  const type = target.metafield?.type;
  if (!type) return null;
  if (METAOBJECT_TYPES.includes(type)) return "metaobject";
  if (PRODUCT_REFERENCE_TYPES.includes(type)) return "product";
  return null;
}

/**
 * A stored reference value, rewritten as the handles the importer reads.
 *
 * A gid nothing resolves is dropped rather than passed through: a cell naming
 * one unknown handle is rejected *entirely* by the importer, so carrying a
 * broken reference would cost the product every other reference beside it.
 */
function referenceCell(
  stored: string,
  handles: Map<string, string>,
): string {
  if (!stored) return "";

  // A list is JSON; a single reference is the bare gid.
  let gids: string[];
  if (stored.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(stored);
      gids = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return "";
    }
  } else {
    gids = [stored];
  }

  return gids
    .map((gid) => handles.get(gid) ?? "")
    .filter(Boolean)
    .join(REFERENCE_SEPARATOR);
}

/**
 * Every gid a product's chosen reference columns hold.
 *
 * The route resolves these to handles in one pass before serializing, the way
 * the variant metafield export does — resolved from the gids actually present
 * rather than by enumerating every entry of every referenced definition.
 */
export function collectReferenceGids(
  targets: FieldTarget[],
  product: ExistingProduct,
): { metaobjects: string[]; products: string[] } {
  const metaobjects: string[] = [];
  const products: string[] = [];

  const read = (stored: string | undefined, into: string[]) => {
    if (!stored) return;
    if (stored.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(stored);
        if (Array.isArray(parsed)) into.push(...parsed.map(String));
      } catch {
        // A value that is not the JSON the type promises has no gids to take.
      }
      return;
    }
    if (stored.startsWith("gid://")) into.push(stored);
  };

  for (const target of targets) {
    const kind = referenceKind(target);
    if (!kind || !target.metafield) continue;

    const key = `${target.metafield.namespace}.${target.metafield.key}`;
    const into = kind === "metaobject" ? metaobjects : products;

    if (target.metafield.owner === "PRODUCT") {
      read(product.metafields.get(key), into);
    } else {
      for (const variant of product.variants) {
        read(variant.metafields.get(key), into);
      }
    }
  }

  return { metaobjects, products };
}

/** The header row: Shopify's spelling for each chosen field, in picker order. */
export function productExportColumns(targets: FieldTarget[]): string[] {
  return targets.map((target) => target.label);
}

/**
 * Which column repeats on every row.
 *
 * `groupRows` picks its match key in this order, and the key has to be on each
 * row or the continuation rows belong to nothing. Every other product-level
 * column is written once, on the first row, the way Shopify does it.
 */
function identityField(targets: FieldTarget[]): string | null {
  const has = (field: string) =>
    targets.some((target) => target.field === field);
  if (has("identity.handle")) return "identity.handle";
  if (has("identity.title")) return "identity.title";
  if (has("variant.sku")) return "variant.sku";
  return null;
}

const WEIGHT_IN_GRAMS: Record<string, number> = {
  GRAMS: 1,
  KILOGRAMS: 1000,
  POUNDS: 453.59237,
  OUNCES: 28.349523125,
};

function grams(variant: ExistingVariant): string {
  if (variant.weightValue === null) return "";
  const factor = WEIGHT_IN_GRAMS[variant.weightUnit ?? "GRAMS"];
  if (!factor) return "";
  // Trimmed rather than fixed: 100 g should read "100", not "100.000".
  return String(Number((variant.weightValue * factor).toFixed(4)));
}

/** Shopify writes booleans as TRUE/FALSE; `parseBoolean` reads them back. */
function bool(value: boolean): string {
  return value ? "TRUE" : "FALSE";
}

function productCell(
  target: FieldTarget,
  product: ExistingProduct,
): string {
  switch (target.field) {
    case "identity.handle":
    case "product.handle":
      return product.handle;
    case "identity.title":
    case "product.title":
      return product.title;
    case "product.descriptionHtml":
      return product.descriptionHtml;
    case "product.vendor":
      return product.vendor;
    case "product.productType":
      return product.productType;
    // The complete list, which is what the Tags cell means on import: a tag
    // missing from it is a tag removed.
    case "product.tags":
      return product.tags.join(", ");
    case "product.status":
      return product.status.toLowerCase();
    // Shopify's CSV expresses "on the online store" as a boolean; the API
    // models it as ACTIVE vs DRAFT. An archived product is neither, and the
    // importer leaves those alone rather than un-archiving them.
    case "product.published":
      return bool(product.status === "ACTIVE");
    case "product.templateSuffix":
      return product.templateSuffix ?? "";
    case "product.category":
      return product.categoryName ?? "";
    case "product.seoTitle":
      return product.seoTitle ?? "";
    case "product.seoDescription":
      return product.seoDescription ?? "";
    default:
      return "";
  }
}

function variantCell(
  target: FieldTarget,
  variant: ExistingVariant,
  options: ProductExportOptions,
): string {
  switch (target.field) {
    case "variant.sku":
      return variant.sku ?? "";
    case "variant.price":
      return variant.price ?? "";
    case "variant.compareAtPrice":
      return variant.compareAtPrice ?? "";
    case "variant.barcode":
      return variant.barcode ?? "";
    case "variant.grams":
      return grams(variant);
    // Exported beside `Variant Grams` on purpose: the importer prefers the
    // explicit weight and unit when both are present, so this pair is what
    // makes a pound round-trip as a pound rather than as 453.59 grams.
    case "variant.weight":
      return variant.weightValue === null ? "" : String(variant.weightValue);
    case "variant.weightUnit":
      return variant.weightUnit ?? "";
    case "variant.requiresShipping":
      return bool(variant.requiresShipping);
    case "variant.taxable":
      return bool(variant.taxable);
    case "variant.inventoryPolicy":
      return variant.inventoryPolicy.toLowerCase();
    // Shopify's column holds the *tracker's name*, and blank means untracked.
    // Blank is also what the importer skips, so an untracked variant round-
    // trips as "no change" — which is right, because it is already untracked.
    case "variant.tracked":
      return variant.tracked ? "shopify" : "";
    case "variant.cost":
      return variant.cost ?? "";
    case "variant.countryOfOrigin":
      return variant.countryOfOrigin ?? "";
    case "variant.hsCode":
      return variant.hsCode ?? "";
    case "inventory.available": {
      if (!options.locationId) return "";
      const quantity = variant.quantities.get(options.locationId);
      return quantity === undefined ? "" : String(quantity);
    }
    default:
      return "";
  }
}

/**
 * One product's rows.
 *
 * As many rows as it has variants, extended to cover its images when there are
 * more images than variants. A product with no variants at all still gets one
 * row, so its product-level columns have somewhere to sit.
 */
export function productExportRows(
  targets: FieldTarget[],
  product: ExistingProduct,
  options: ProductExportOptions = {},
): string[][] {
  const identity = identityField(targets);
  const wantsMedia = targets.some((target) => target.scope === "media");
  const optionNames = product.variants[0]?.selectedOptions ?? [];

  const rowCount = Math.max(
    1,
    product.variants.length,
    wantsMedia ? product.images.length : 0,
  );

  const rows: string[][] = [];

  for (let index = 0; index < rowCount; index += 1) {
    const variant = product.variants[index];
    const image = product.images[index];
    const first = index === 0;

    rows.push(
      targets.map((target) => {
        // Metafields first, and that order matters: a metafield target carries
        // the `product` or `variant` scope of its owner rather than a scope of
        // its own, so a switch on scope alone would send it to `productCell`
        // and get an empty string back. The import planner checks
        // `target.metafield` first for the same reason.
        if (target.metafield) {
          const key = `${target.metafield.namespace}.${target.metafield.key}`;
          const stored =
            target.metafield.owner === "PRODUCTVARIANT"
              ? (variant?.metafields.get(key) ?? "")
              : // A product metafield is written once, like every other
                // product-level column: the importer takes the first non-empty
                // value and a repeat would only make the file bigger.
                first
                ? (product.metafields.get(key) ?? "")
                : "";

          const kind = referenceKind(target);
          if (!kind) return stored;
          return referenceCell(
            stored,
            (kind === "metaobject" ? options.metaobjects : options.products) ??
              new Map(),
          );
        }

        // The match key, on every row — without it a continuation row belongs
        // to no product.
        if (target.field === identity) {
          return target.scope === "variant"
            ? (variant?.sku ?? "")
            : productCell(target, product);
        }

        switch (target.scope) {
          case "identity":
          case "product":
            return first ? productCell(target, product) : "";

          case "variant":
            return variant ? variantCell(target, variant, options) : "";

          case "inventory":
            return variant ? variantCell(target, variant, options) : "";

          case "option": {
            const position = (target.optionIndex ?? 1) - 1;
            // The name describes the option and is written once; the value
            // identifies the variant and so belongs on every row.
            if (target.field.endsWith(".name")) {
              return first ? (optionNames[position]?.name ?? "") : "";
            }
            return variant?.selectedOptions[position]?.value ?? "";
          }

          case "media":
            if (!image) return "";
            return target.field === "media.src" ? image.url : image.alt;

          default:
            return "";
        }
      }),
    );
  }

  return rows;
}
