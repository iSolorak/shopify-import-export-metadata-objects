// Grouping a product CSV into products, and the dry-run planner that decides
// what each one would change.
//
// This is the module the whole feature exists for. Shopify's own "overwrite"
// import deletes the product and recreates it, which takes its metafields,
// videos, translations and collection memberships with it. Everything here is
// built so that cannot happen:
//
//   * a row that matches no product is an error, never a creation;
//   * a variant that matches no existing variant is an error for that variant
//     alone, never a creation and never a deletion;
//   * variants the file does not mention are not touched;
//   * a blank cell is skipped, so a half-filled spreadsheet cannot blank a
//     field that already has content;
//   * a value equal to what the store already holds is not a change at all,
//     which is what makes re-running a file free and a timed-out run safe to
//     repeat.
//
// Pure, like the other planners in this app: it is handed the store's current
// state and returns a diff. Nothing here talks to the Admin API.

import {
  parseBoolean,
  parseNumber,
  parseTags,
  type FieldTarget,
} from "./product-import-columns";
import type { ExistingProduct, ExistingVariant } from "./product-write.server";

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export type ImageRow = { src: string; alt: string };

export type VariantRow = {
  rowNumber: number;
  /** Mapped variant fields, raw cell text, blanks already dropped. */
  values: Map<string, string>;
  /** `Option1 Value` … `Option3 Value`, for matching when there is no SKU. */
  optionValues: string[];
  sku: string;
};

/** Which column a file uses to find the product a row belongs to. */
export type MatchedBy = "handle" | "title" | "sku";

export type ProductRow = {
  /** Whichever of handle/title/SKU the file identifies products by. */
  key: string;
  /** Which of the three that was, so an error can name the right column. */
  matchedBy: MatchedBy;
  handle: string;
  title: string;
  /** Every CSV row that contributed, for error messages. */
  rowNumbers: number[];
  /** Mapped product-level fields, blanks already dropped. */
  values: Map<string, string>;
  variants: VariantRow[];
  images: ImageRow[];
};

/**
 * Read a record's cell for a field, or null when the column is absent or blank.
 *
 * The blank check is the safety property, applied in exactly one place: a cell
 * that trims to nothing never reaches the planner, so it can never become a
 * change.
 */
function cell(
  record: Record<string, string>,
  byColumn: Map<string, FieldTarget>,
  field: string,
): string | null {
  for (const [column, target] of byColumn) {
    if (target.field !== field) continue;
    const value = (record[column] ?? "").trim();
    return value || null;
  }
  return null;
}

/**
 * Collapse CSV rows into one entry per product.
 *
 * A product export is one row per variant, with the product-level fields
 * filled in on exactly one of them — Shopify uses the first, other exporters
 * the last. Taking the **first non-empty** value per field is correct for both
 * and, unlike last-wins, cannot let a trailing blank row erase anything.
 *
 * A row joins the product above it when its identifying cell is blank, which is
 * how a per-variant export marks continuation rows. That means row order is
 * significant, and a file sorted so a product's rows are not adjacent will read
 * as several products — which the planner then reports as duplicates rather
 * than merging blindly.
 *
 * Handle, then Title, then Variant SKU. SKU is last because it identifies a
 * *variant*, and the product is whatever that variant hangs off — so a
 * SKU-keyed file is one row per variant and each row stands alone, with no
 * continuation rows to join. That is exactly what a supplier price list looks
 * like, which is the case it exists for.
 */
export function groupRows(
  records: Record<string, string>[],
  byColumn: Map<string, FieldTarget>,
): { rows: ProductRow[]; errors: string[] } {
  const has = (field: string) =>
    [...byColumn.values()].some((target) => target.field === field);

  const matchedBy: MatchedBy = has("identity.handle")
    ? "handle"
    : has("identity.title")
      ? "title"
      : "sku";
  const identityField =
    matchedBy === "handle"
      ? "identity.handle"
      : matchedBy === "title"
        ? "identity.title"
        : "variant.sku";
  const identityLabel =
    matchedBy === "handle"
      ? "Handle"
      : matchedBy === "title"
        ? "Title"
        : "Variant SKU";

  const rows: ProductRow[] = [];
  const byKey = new Map<string, ProductRow>();
  const errors: string[] = [];
  let current: ProductRow | null = null;

  records.forEach((record, index) => {
    // +2: one for the header row, one because spreadsheets number from 1.
    const rowNumber = index + 2;

    const identity = cell(record, byColumn, identityField);
    const handle = cell(record, byColumn, "identity.handle") ?? "";
    const title = cell(record, byColumn, "identity.title") ?? "";

    if (identity) {
      const key = identity.toLowerCase();
      const seen = byKey.get(key);

      if (seen && seen !== current) {
        // The product's rows are not adjacent. Merging them would be guessing
        // at which block's values win, so say so instead.
        errors.push(
          `Row ${rowNumber}: "${identity}" also appears at row ${seen.rowNumbers[0]}. Sort the file so each product's rows are together.`,
        );
        current = null;
        return;
      }

      if (!seen) {
        current = {
          key,
          matchedBy,
          handle,
          title,
          rowNumbers: [],
          values: new Map(),
          variants: [],
          images: [],
        };
        rows.push(current);
        byKey.set(key, current);
      }
    }

    if (!current) {
      // A continuation row with nothing above it to continue.
      if (rowNumber === 2 || rows.length === 0) {
        errors.push(
          `Row ${rowNumber}: no ${identityLabel}, and no product above it to belong to.`,
        );
      }
      return;
    }

    const product = current;
    product.rowNumbers.push(rowNumber);
    if (!product.handle && handle) product.handle = handle;
    if (!product.title && title) product.title = title;

    // --- Fields, first non-empty wins ------------------------------------
    const variantValues = new Map<string, string>();
    const optionValues: string[] = [];

    for (const [column, target] of byColumn) {
      const value = (record[column] ?? "").trim();
      if (!value) continue;

      if (target.scope === "option") {
        // Only the value columns identify a variant; the name columns describe
        // the option itself and this importer never writes those.
        if (target.field.endsWith(".value") && target.optionIndex) {
          optionValues[target.optionIndex - 1] = value;
        }
        continue;
      }

      if (target.scope === "media") continue; // handled below, as a pair

      if (target.scope === "variant" || target.scope === "inventory") {
        variantValues.set(target.field, value);
        continue;
      }

      if (target.scope === "product" && !product.values.has(target.field)) {
        product.values.set(target.field, value);
      }
    }

    // --- Images ------------------------------------------------------------
    const src = cell(record, byColumn, "media.src");
    if (src) {
      product.images.push({
        src,
        alt: cell(record, byColumn, "media.alt") ?? "",
      });
    }

    // --- Variants ----------------------------------------------------------
    // A row is about a variant when it says something about one. A row that
    // only carries an image or a product-level field is not a variant row, and
    // treating it as one would produce a spurious "no matching variant" error
    // on every image row of a real export.
    const sku = variantValues.get("variant.sku") ?? "";
    if (variantValues.size > 0 || optionValues.some(Boolean)) {
      product.variants.push({
        rowNumber,
        values: variantValues,
        optionValues,
        sku,
      });
    }
  });

  return { rows, errors };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export type FieldChange = {
  field: string;
  label: string;
  from: string;
  to: string;
};

/** One variant's worth of resolved writes, ready for the apply step. */
export type VariantPlan = {
  variantId: string;
  inventoryItemId: string;
  /** `ProductVariantsBulkInput` fragments, already shaped. */
  input: Record<string, unknown>;
  /** Set when the row carried a quantity and the variant is tracked. */
  inventory?: { inventoryItemId: string; quantity: number };
  changes: FieldChange[];
};

export type MetafieldPlan = {
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
};

export type ProductPlan = {
  key: string;
  /** How the row found its product, so the review table can label it. */
  matchedBy: MatchedBy;
  handle: string;
  title: string;
  rowNumbers: number[];
  action: "update" | "unchanged" | "error";
  changes: FieldChange[];
  errors: string[];
  productId?: string;
  /** `ProductUpdateInput` minus the id, which the writer adds. */
  productInput: Record<string, unknown>;
  media: { originalSource: string; alt: string; mediaContentType: "IMAGE" }[];
  variants: VariantPlan[];
  metafields: MetafieldPlan[];
};

export type ImportPlan = {
  products: ProductPlan[];
  counts: { update: number; unchanged: number; error: number };
  /** Products the apply step would actually write to. */
  writeCount: number;
  /** File-level problems that belong to no single product. */
  errors: string[];
};

/** What the planner needs from the caller that it cannot work out itself. */
export type PlanContext = {
  /** Handle or lowercased title → product, as the lookup returned it. */
  products: Map<string, ExistingProduct>;
  /** Titles that matched more than one product, so a row cannot be resolved. */
  ambiguous: Set<string>;
  /** Chosen location for `Variant Inventory Qty`. */
  locationId: string | null;
  /** Metaobject handle → gid, for `metaobject_reference` metafields. */
  metaobjects: Map<string, string>;
  /** Category search term → taxonomy gid. */
  categories: Map<string, string>;
  /**
   * Metafield value converter, injected so this module stays HTML-agnostic.
   *
   * Takes the whole target rather than just the type: a metaobject reference
   * column also needs the definition it is restricted to, which is what lets a
   * bare handle resolve.
   */
  toMetafieldValue: (
    target: FieldTarget,
    cell: string,
    context: PlanContext,
  ) => { ok: true; value: string } | { ok: false; message: string };
};

const FIELD_LABELS = new Map<string, string>([
  ["product.title", "Title"],
  ["product.descriptionHtml", "Body (HTML)"],
  ["product.vendor", "Vendor"],
  ["product.productType", "Type"],
  ["product.tags", "Tags"],
  ["product.status", "Status"],
  ["product.published", "Published"],
  ["product.handle", "Handle"],
  ["product.templateSuffix", "Template Suffix"],
  ["product.category", "Category"],
  ["product.seoTitle", "SEO Title"],
  ["product.seoDescription", "SEO Description"],
  ["variant.sku", "SKU"],
  ["variant.price", "Price"],
  ["variant.compareAtPrice", "Compare at price"],
  ["variant.barcode", "Barcode"],
  ["variant.grams", "Weight (g)"],
  ["variant.weight", "Weight"],
  ["variant.weightUnit", "Weight unit"],
  ["variant.requiresShipping", "Requires shipping"],
  ["variant.taxable", "Taxable"],
  ["variant.inventoryPolicy", "Inventory policy"],
  ["variant.tracked", "Inventory tracked"],
  ["variant.cost", "Cost per item"],
  ["variant.countryOfOrigin", "Country of origin"],
  ["variant.hsCode", "HS code"],
  ["inventory.available", "Inventory quantity"],
]);

function labelFor(field: string, target?: FieldTarget): string {
  return FIELD_LABELS.get(field) ?? target?.label ?? field;
}

/** Money comes back from the API as a decimal string; compare it numerically. */
function sameMoney(a: string | null, b: string): boolean {
  const left = parseNumber(a ?? "");
  const right = parseNumber(b);
  if (left === null || right === null) return (a ?? "") === b;
  return left === right;
}

/**
 * The filename Shopify keeps when it re-hosts an image.
 *
 * A source URL is not recoverable from the CDN URL Shopify serves — it rewrites
 * the host and appends a version query — but the filename survives, so it is
 * the only durable link between "the image in the CSV" and "the image already
 * on the product".
 */
function filenameOf(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0];
  const last = withoutQuery.split("/").pop() ?? "";
  return last.toLowerCase();
}

/**
 * Match a CSV variant row to one that already exists.
 *
 * Order matters and is the safety-critical part of this feature. SKU first
 * because it is the only identifier a merchant controls and keeps stable;
 * option values next; the sole variant last, and only when the row offers no
 * identifying information at all. Anything else is an error — writing a price
 * to the wrong variant is exactly the silent damage this app is meant to avoid.
 */
function matchVariant(
  row: VariantRow,
  product: ExistingProduct,
): ExistingVariant | null {
  if (row.sku) {
    const bySku = product.variants.find(
      (variant) => variant.sku && variant.sku.trim() === row.sku,
    );
    if (bySku) return bySku;
  }

  const wanted = row.optionValues.filter(Boolean).map((v) => v.toLowerCase());
  if (wanted.length) {
    const byOptions = product.variants.find((variant) => {
      const have = variant.selectedOptions.map((option) =>
        option.value.toLowerCase(),
      );
      return (
        have.length === wanted.length &&
        wanted.every((value) => have.includes(value))
      );
    });
    if (byOptions) return byOptions;
  }

  // No SKU column and no option columns: a single-variant product is
  // unambiguous. A multi-variant one is not, and falls through to an error.
  if (!row.sku && !wanted.length && product.variants.length === 1) {
    return product.variants[0];
  }

  return null;
}

/** Build the productUpdate input, recording only genuine differences. */
function planProductFields(
  row: ProductRow,
  product: ExistingProduct,
  context: PlanContext,
  changes: FieldChange[],
  errors: string[],
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const seo: Record<string, string> = {};

  const note = (field: string, from: string, to: string) => {
    changes.push({ field, label: labelFor(field), from, to });
  };

  for (const [field, value] of row.values) {
    switch (field) {
      case "product.title": {
        if (product.title === value) break;
        note(field, product.title, value);
        input.title = value;
        break;
      }
      case "product.handle": {
        if (product.handle === value) break;
        note(field, product.handle, value);
        input.handle = value;
        // Without this the old URL 404s, which silently costs the store any
        // inbound link and search ranking the product had.
        input.redirectNewHandle = true;
        break;
      }
      case "product.descriptionHtml": {
        if (product.descriptionHtml === value) break;
        note(field, truncate(product.descriptionHtml), truncate(value));
        input.descriptionHtml = value;
        break;
      }
      case "product.vendor": {
        if (product.vendor === value) break;
        note(field, product.vendor, value);
        input.vendor = value;
        break;
      }
      case "product.productType": {
        if (product.productType === value) break;
        note(field, product.productType, value);
        input.productType = value;
        break;
      }
      case "product.templateSuffix": {
        if ((product.templateSuffix ?? "") === value) break;
        note(field, product.templateSuffix ?? "", value);
        input.templateSuffix = value;
        break;
      }
      case "product.tags": {
        const tags = parseTags(value);
        const before = [...product.tags].sort();
        const after = [...tags].sort();
        if (before.join(",") === after.join(",")) break;
        // Replacement, matching Shopify's own CSV semantics: the Tags cell is
        // the complete list, so a tag missing from it is a tag removed. The
        // plan shows both sides in full, because that is the one field where
        // "overwrite" quietly deletes something the merchant may still want.
        note(field, before.join(", "), after.join(", "));
        input.tags = tags;
        break;
      }
      case "product.status": {
        const status = value.trim().toUpperCase();
        if (!["ACTIVE", "ARCHIVED", "DRAFT"].includes(status)) {
          errors.push(
            `Status "${value}" is not one of active, draft or archived.`,
          );
          break;
        }
        if (product.status === status) break;
        note(field, product.status, status);
        input.status = status;
        break;
      }
      case "product.published": {
        // Shopify's CSV expresses "is it on the online store" as a boolean;
        // the API models the same thing as ACTIVE vs DRAFT.
        const published = parseBoolean(value);
        if (published === null) {
          errors.push(`Published "${value}" is not TRUE or FALSE.`);
          break;
        }
        const status = published ? "ACTIVE" : "DRAFT";
        // An archived product is deliberately neither, so leave it alone
        // rather than quietly un-archiving it.
        if (product.status === "ARCHIVED" || product.status === status) break;
        note(field, product.status, status);
        input.status = status;
        break;
      }
      case "product.seoTitle": {
        if ((product.seoTitle ?? "") === value) break;
        note(field, product.seoTitle ?? "", value);
        seo.title = value;
        break;
      }
      case "product.seoDescription": {
        if ((product.seoDescription ?? "") === value) break;
        note(field, product.seoDescription ?? "", value);
        seo.description = value;
        break;
      }
      case "product.category": {
        const id = context.categories.get(value.toLowerCase());
        if (!id) {
          errors.push(
            `No Shopify product category matches "${value}" exactly. Use the full path, e.g. "Apparel & Accessories > Clothing".`,
          );
          break;
        }
        if (product.categoryId === id) break;
        note(field, product.categoryName ?? "", value);
        input.category = id;
        break;
      }
      default:
        break;
    }
  }

  if (Object.keys(seo).length) input.seo = seo;
  return input;
}

/** Long HTML in a diff cell is unreadable; the point is that it differs. */
function truncate(value: string, limit = 80): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > limit
    ? `${collapsed.slice(0, limit)}…`
    : collapsed;
}

/** Build the variant input for one matched variant. */
function planVariant(
  row: VariantRow,
  variant: ExistingVariant,
  context: PlanContext,
  errors: string[],
): VariantPlan | null {
  const changes: FieldChange[] = [];
  const input: Record<string, unknown> = { id: variant.id };
  const inventoryItem: Record<string, unknown> = {};
  let inventory: VariantPlan["inventory"];

  const note = (field: string, from: string, to: string) =>
    changes.push({ field, label: labelFor(field), from, to });

  const bool = (field: string, value: string): boolean | null => {
    const parsed = parseBoolean(value);
    if (parsed === null) {
      errors.push(
        `${labelFor(field)} "${value}" on row ${row.rowNumber} is not TRUE or FALSE.`,
      );
    }
    return parsed;
  };

  for (const [field, value] of row.values) {
    switch (field) {
      case "variant.sku": {
        if ((variant.sku ?? "") === value) break;
        note(field, variant.sku ?? "", value);
        inventoryItem.sku = value;
        break;
      }
      case "variant.price": {
        if (sameMoney(variant.price, value)) break;
        const price = parseNumber(value);
        if (price === null) {
          errors.push(`Price "${value}" on row ${row.rowNumber} is not a number.`);
          break;
        }
        note(field, variant.price ?? "", String(price));
        input.price = String(price);
        break;
      }
      case "variant.compareAtPrice": {
        if (sameMoney(variant.compareAtPrice, value)) break;
        const price = parseNumber(value);
        if (price === null) {
          errors.push(
            `Compare at price "${value}" on row ${row.rowNumber} is not a number.`,
          );
          break;
        }
        note(field, variant.compareAtPrice ?? "", String(price));
        input.compareAtPrice = String(price);
        break;
      }
      case "variant.barcode": {
        if ((variant.barcode ?? "") === value) break;
        note(field, variant.barcode ?? "", value);
        input.barcode = value;
        break;
      }
      case "variant.taxable": {
        const taxable = bool(field, value);
        if (taxable === null || variant.taxable === taxable) break;
        note(field, String(variant.taxable), String(taxable));
        input.taxable = taxable;
        break;
      }
      case "variant.inventoryPolicy": {
        const policy = value.trim().toUpperCase();
        if (!["DENY", "CONTINUE"].includes(policy)) {
          errors.push(
            `Inventory policy "${value}" on row ${row.rowNumber} is not deny or continue.`,
          );
          break;
        }
        if (variant.inventoryPolicy === policy) break;
        note(field, variant.inventoryPolicy, policy);
        input.inventoryPolicy = policy;
        break;
      }
      case "variant.tracked": {
        // Shopify's CSV puts the tracker's *name* here ("shopify"), and an
        // empty cell means untracked — but an empty cell never reaches this
        // point, so any value at all means tracked.
        const tracked = value.trim().toLowerCase() !== "false";
        if (variant.tracked === tracked) break;
        note(field, String(variant.tracked), String(tracked));
        inventoryItem.tracked = tracked;
        break;
      }
      case "variant.requiresShipping": {
        const requires = bool(field, value);
        if (requires === null || variant.requiresShipping === requires) break;
        note(field, String(variant.requiresShipping), String(requires));
        inventoryItem.requiresShipping = requires;
        break;
      }
      case "variant.cost": {
        const cost = parseNumber(value);
        if (cost === null) {
          errors.push(`Cost "${value}" on row ${row.rowNumber} is not a number.`);
          break;
        }
        if (sameMoney(variant.cost, value)) break;
        note(field, variant.cost ?? "", String(cost));
        inventoryItem.cost = String(cost);
        break;
      }
      case "variant.countryOfOrigin": {
        const code = value.trim().toUpperCase();
        if ((variant.countryOfOrigin ?? "") === code) break;
        note(field, variant.countryOfOrigin ?? "", code);
        inventoryItem.countryCodeOfOrigin = code;
        break;
      }
      case "variant.hsCode": {
        if ((variant.hsCode ?? "") === value) break;
        note(field, variant.hsCode ?? "", value);
        inventoryItem.harmonizedSystemCode = value;
        break;
      }
      case "inventory.available": {
        const quantity = parseNumber(value);
        if (quantity === null || !Number.isInteger(quantity)) {
          errors.push(
            `Inventory quantity "${value}" on row ${row.rowNumber} is not a whole number.`,
          );
          break;
        }
        if (!context.locationId) {
          errors.push(
            `Row ${row.rowNumber} sets an inventory quantity but no location was chosen.`,
          );
          break;
        }
        // Read from the row rather than from `inventoryItem`, which may not
        // have been filled in yet: the fields are walked in column order, so
        // whether tracking is being switched on in this same row cannot depend
        // on where the tracker column happens to sit in the file.
        const turningOn =
          (row.values.get("variant.tracked") ?? "").trim().toLowerCase() !==
            "" &&
          (row.values.get("variant.tracked") ?? "").trim().toLowerCase() !==
            "false";

        if (!variant.tracked && !turningOn) {
          // Shopify's own export writes `Variant Inventory Qty 0` for every
          // variant, tracked or not, and leaves `Variant Inventory Tracker`
          // blank for the untracked ones. Reading that filler as an
          // instruction turned a straight round-trip of an unedited export
          // into one error per variant and left the file with nothing to do.
          //
          // A zero on an untracked variant carries no information, so it is
          // skipped like any other cell that would change nothing. A real
          // quantity is a request that cannot be honoured, and still reports.
          if (quantity !== 0) {
            errors.push(
              `Row ${row.rowNumber} sets a quantity of ${quantity} but inventory is not tracked for this variant. Set a Variant Inventory Tracker column, or turn tracking on in the admin.`,
            );
          }
          break;
        }
        const current = variant.quantities.get(context.locationId);
        if (current === quantity) break;
        note(field, current === undefined ? "—" : String(current), String(quantity));
        inventory = {
          inventoryItemId: variant.inventoryItemId,
          quantity,
        };
        break;
      }
      default:
        break;
    }
  }

  // --- Weight ------------------------------------------------------------
  // `Variant Grams` and `Variant Weight`/`Variant Weight Unit` describe the
  // same measurement, so they are resolved together rather than in the loop:
  // a file carrying both would otherwise write one and then overwrite it.
  const weight = planWeight(row, variant, note);
  if (weight) inventoryItem.measurement = { weight };

  if (Object.keys(inventoryItem).length) input.inventoryItem = inventoryItem;

  const hasVariantWrite = Object.keys(input).length > 1; // more than just `id`
  if (!hasVariantWrite && !inventory) return null;

  return {
    variantId: variant.id,
    inventoryItemId: variant.inventoryItemId,
    input,
    ...(inventory ? { inventory } : {}),
    changes,
  };
}

function planWeight(
  row: VariantRow,
  variant: ExistingVariant,
  note: (field: string, from: string, to: string) => void,
): { value: number; unit: string } | null {
  const grams = row.values.get("variant.grams");
  const explicit = row.values.get("variant.weight");
  const unitCell = row.values.get("variant.weightUnit");

  let value: number | null = null;
  let unit: string | null = null;

  if (explicit) {
    value = parseNumber(explicit);
    unit = normalizeWeightUnit(unitCell ?? variant.weightUnit ?? "GRAMS");
  } else if (grams) {
    value = parseNumber(grams);
    unit = "GRAMS";
  } else if (unitCell) {
    // A unit with no number: convert the existing weight rather than guessing
    // a value. Shopify stores value and unit together, so the unit alone is
    // not a complete change.
    return null;
  }

  if (value === null || unit === null) return null;
  if (variant.weightValue === value && variant.weightUnit === unit) return null;

  note(
    "variant.weight",
    variant.weightValue === null
      ? ""
      : `${variant.weightValue} ${variant.weightUnit ?? ""}`.trim(),
    `${value} ${unit}`,
  );

  return { value, unit };
}

function normalizeWeightUnit(raw: string): string {
  const unit = raw.trim().toLowerCase();
  if (["g", "grams", "gram"].includes(unit)) return "GRAMS";
  if (["kg", "kilograms", "kilogram"].includes(unit)) return "KILOGRAMS";
  if (["lb", "lbs", "pounds", "pound"].includes(unit)) return "POUNDS";
  if (["oz", "ounces", "ounce"].includes(unit)) return "OUNCES";
  return "GRAMS";
}

/**
 * Decide what every product in the file would change, without writing anything.
 */
export function planProductUpdate(
  rows: ProductRow[],
  byColumn: Map<string, FieldTarget>,
  context: PlanContext,
  fileErrors: string[] = [],
): ImportPlan {
  // Metafield targets, keyed by field id, so a row's metafield cells can be
  // found without walking the column map for each one.
  const metafieldTargets = new Map<string, FieldTarget>();
  for (const target of byColumn.values()) {
    if (target.metafield) metafieldTargets.set(target.field, target);
  }

  const products: ProductPlan[] = rows.map((row) => {
    const changes: FieldChange[] = [];
    const errors: string[] = [];

    const base = {
      key: row.key,
      handle: row.handle,
      title: row.title,
      matchedBy: row.matchedBy,
      rowNumbers: row.rowNumbers,
      changes,
      errors,
      productInput: {},
      media: [],
      variants: [],
      metafields: [],
    };

    if (context.ambiguous.has(row.key)) {
      return {
        ...base,
        action: "error" as const,
        errors: [
          row.matchedBy === "sku"
            ? `The SKU "${row.key}" is on more than one variant in this store, so there is no single product to update. Make the SKU unique, or use a Handle column.`
            : `Several products share the title "${row.title}". Add a Handle column so the right one can be identified.`,
        ],
      };
    }

    const product = context.products.get(row.key);
    if (!product) {
      return {
        ...base,
        action: "error" as const,
        errors: [
          row.matchedBy === "handle"
            ? `No product with the handle "${row.handle}".`
            : row.matchedBy === "title"
              ? `No product with the title "${row.title}".`
              : `No variant with the SKU "${row.key}" in this store.`,
        ],
      };
    }

    // --- Product-level fields ---------------------------------------------
    const productInput = planProductFields(
      row,
      product,
      context,
      changes,
      errors,
    );

    // --- Metafields --------------------------------------------------------
    const metafields: MetafieldPlan[] = [];

    for (const [field, value] of row.values) {
      const target = metafieldTargets.get(field);
      if (!target?.metafield || target.metafield.owner !== "PRODUCT") continue;

      const converted = context.toMetafieldValue(target, value, context);
      if (!converted.ok) {
        errors.push(`${target.label}: ${converted.message}`);
        continue;
      }

      const current = product.metafields.get(
        `${target.metafield.namespace}.${target.metafield.key}`,
      );
      if (current === converted.value) continue;

      changes.push({
        field,
        label: target.label,
        from: truncate(current ?? ""),
        to: truncate(converted.value),
      });
      metafields.push({
        ownerId: product.id,
        namespace: target.metafield.namespace,
        key: target.metafield.key,
        type: target.metafield.type,
        value: converted.value,
      });
    }

    // --- Variants ----------------------------------------------------------
    const variants: VariantPlan[] = [];
    const usedVariantIds = new Set<string>();

    for (const variantRow of row.variants) {
      const matched = matchVariant(variantRow, product);
      if (!matched) {
        errors.push(
          variantRow.sku
            ? `Row ${variantRow.rowNumber}: no variant with SKU "${variantRow.sku}" on this product. Variants are never created — add it in the admin first.`
            : `Row ${variantRow.rowNumber}: could not tell which variant this row means. Add a Variant SKU or the Option columns.`,
        );
        continue;
      }

      if (usedVariantIds.has(matched.id)) {
        errors.push(
          `Row ${variantRow.rowNumber}: an earlier row already updates this variant.`,
        );
        continue;
      }
      usedVariantIds.add(matched.id);

      const planned = planVariant(variantRow, matched, context, errors);
      if (planned) {
        changes.push(...planned.changes);
        variants.push(planned);
      }

      // Variant metafields ride on the same row, but are written through
      // `metafieldsSet` with the variant as owner rather than through the
      // bulk variant mutation.
      for (const [field, value] of variantRow.values) {
        const target = metafieldTargets.get(field);
        if (!target?.metafield || target.metafield.owner !== "PRODUCTVARIANT") {
          continue;
        }

        const converted = context.toMetafieldValue(target, value, context);
        if (!converted.ok) {
          errors.push(`Row ${variantRow.rowNumber} ${target.label}: ${converted.message}`);
          continue;
        }

        const key = `${target.metafield.namespace}.${target.metafield.key}`;
        if (matched.metafields.get(key) === converted.value) continue;

        changes.push({
          field,
          label: `${target.label} (${matched.sku || matched.id})`,
          from: truncate(matched.metafields.get(key) ?? ""),
          to: truncate(converted.value),
        });
        metafields.push({
          ownerId: matched.id,
          namespace: target.metafield.namespace,
          key: target.metafield.key,
          type: target.metafield.type,
          value: converted.value,
        });
      }
    }

    // --- Images, appended only --------------------------------------------
    const media: ProductPlan["media"] = [];
    const seenSources = new Set<string>();

    for (const image of row.images) {
      if (seenSources.has(image.src)) continue;
      seenSources.add(image.src);

      const alt = image.alt.trim().toLowerCase();
      const filename = filenameOf(image.src);

      const already = product.images.some(
        (existing) =>
          (alt && existing.alt.trim().toLowerCase() === alt) ||
          (filename && filenameOf(existing.url) === filename),
      );
      if (already) continue;

      changes.push({
        field: "media.src",
        label: "Image",
        from: "",
        to: filename || image.src,
      });
      media.push({
        originalSource: image.src,
        alt: image.alt,
        mediaContentType: "IMAGE",
      });
    }

    const willWrite =
      Object.keys(productInput).length > 0 ||
      media.length > 0 ||
      variants.length > 0 ||
      metafields.length > 0;

    return {
      ...base,
      productId: product.id,
      productInput,
      media,
      variants,
      metafields,
      changes,
      errors,
      // Errors do not cancel the rest: a bad variant row still lets the
      // product's title change go through, which is what "finish what you can
      // and report the rest" means here. The badge reflects whether anything
      // will be written.
      action: willWrite
        ? ("update" as const)
        : errors.length
          ? ("error" as const)
          : ("unchanged" as const),
    };
  });

  const counts = { update: 0, unchanged: 0, error: 0 };
  for (const product of products) counts[product.action]++;

  return {
    products,
    counts,
    writeCount: counts.update,
    errors: fileErrors,
  };
}
