// The variant metafield CSV builders and the dry-run planner.
//
// Mirrors `rich-text-csv.ts` in structure — a row per owner, a column per
// metafield, and a plan that says what each row would do before anything is
// written — and differs in the one place that matters: the owner is a
// **variant**, and a reference cell is written the way a person reads it.
//
// `shopify.color-family` comes out of Shopify's own export as
// `01-peach-radiant`. Here it comes out as `Peach`, and `Peach` typed back into
// the cell resolves to the same entry. That round trip is the whole point of
// the section; everything else below exists to make it safe.
//
// `.server` because the value conversion is `toMetafieldValue`'s, and that
// lives in `product-write.server.ts`. The column names and the plan type a page
// component needs are in `variant-metafield-columns.ts` instead, which is
// importable from either side.

import { toCsv } from "./csv";
import {
  METAOBJECT_TYPES,
  PRODUCT_REFERENCE_TYPES,
  metaobjectRefsIn,
  productRefsIn,
  toMetafieldValue,
} from "./product-write.server";
import type { RichTextDefinition } from "./product-metafields.server";
import type { MetaobjectIndex, MetaobjectRef, VariantMetafields } from "./variant-metafields.server";
import {
  HANDLE_COLUMN,
  IDENTITY_COLUMNS,
  SKU_COLUMN,
  TITLE_COLUMN,
  VARIANT_TITLE_COLUMN,
  normalizeDisplayName,
  type RefStyle,
  type VariantDelete,
  type VariantImportPlan,
  type VariantRowPlan,
  type VariantWrite,
} from "./variant-metafield-columns";

/** A variant metafield CSV is recognised by its identifying columns. */
export function isVariantMetafieldCsv(headers: string[]): boolean {
  return headers.includes(SKU_COLUMN) || headers.includes(HANDLE_COLUMN);
}

// ---------------------------------------------------------------------------
// Rendering a stored value into a cell
// ---------------------------------------------------------------------------

/** Lookups the export needs to turn gids into something readable. */
export type RenderContext = {
  metaobjects: Map<string, MetaobjectRef>;
  products: Map<string, string>;
  refs: RefStyle;
};

/**
 * Split a stored value into its parts.
 *
 * A `list.*` metafield is stored as a JSON array; everything else is a single
 * value. Returns null when a list does not parse, so the caller can fall back
 * to emitting the raw value rather than inventing one.
 */
function decodeList(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[")) return [trimmed];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

/**
 * A part that cannot be written into a `;`-joined cell without changing its
 * meaning. Rendering it as a handle, or as raw JSON, loses readability but
 * keeps the file importable — which is the right way round.
 */
function joinable(part: string): boolean {
  return !part.includes(";");
}

function renderMetaobjectPart(
  gid: string,
  definition: RichTextDefinition,
  context: RenderContext,
): string {
  const ref = context.metaobjects.get(gid);
  if (!ref) return gid;

  // A `mixed_reference` may point at several definitions, so a bare name or
  // handle would not say which. Those keep the `type:handle` form the importer
  // already understands, in both directions.
  if (!definition.metaobjectDefinitionId) return `${ref.type}:${ref.handle}`;

  if (
    context.refs === "name" &&
    ref.displayName &&
    joinable(ref.displayName)
  ) {
    return ref.displayName;
  }
  return ref.handle;
}

/** Turn one stored metafield value into a CSV cell. */
export function renderCell(
  definition: RichTextDefinition,
  raw: string,
  context: RenderContext,
): string {
  if (!raw) return "";

  const isList = definition.type.startsWith("list.");

  if (METAOBJECT_TYPES.includes(definition.type)) {
    const parts = decodeList(raw);
    if (!parts) return raw;
    return parts
      .map((gid) => renderMetaobjectPart(gid, definition, context))
      .join(";");
  }

  if (PRODUCT_REFERENCE_TYPES.includes(definition.type)) {
    const parts = decodeList(raw);
    if (!parts) return raw;
    return parts.map((gid) => context.products.get(gid) ?? gid).join(";");
  }

  if (isList) {
    const parts = decodeList(raw);
    // A list of objects — dimensions, money, ratings — has no readable
    // `;`-joined form, and `toMetafieldValue` passes a cell that already holds
    // JSON straight through, so the raw value round-trips untouched.
    if (!parts || !parts.every(joinable)) return raw;
    return parts.join(";");
  }

  return raw;
}

/** Every gid an export will need to resolve, gathered in one pass. */
export function collectReferenceIds(
  definitions: RichTextDefinition[],
  variants: VariantMetafields[],
): { metaobjectIds: string[]; productIds: string[] } {
  const metaobjectIds = new Set<string>();
  const productIds = new Set<string>();

  for (const variant of variants) {
    for (const definition of definitions) {
      const raw = variant.values[definition.column];
      if (!raw) continue;

      const isMetaobject = METAOBJECT_TYPES.includes(definition.type);
      const isProduct = PRODUCT_REFERENCE_TYPES.includes(definition.type);
      if (!isMetaobject && !isProduct) continue;

      for (const part of decodeList(raw) ?? []) {
        if (!part.startsWith("gid://")) continue;
        if (isMetaobject) metaobjectIds.add(part);
        else productIds.add(part);
      }
    }
  }

  return { metaobjectIds: [...metaobjectIds], productIds: [...productIds] };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function optionCells(variant: VariantMetafields): string[] {
  const cells: string[] = [];
  for (let index = 0; index < 3; index++) {
    const option = variant.selectedOptions[index];
    cells.push(option?.name ?? "", option?.value ?? "");
  }
  return cells;
}

export function variantMetafieldsToCsv(
  definitions: RichTextDefinition[],
  variants: VariantMetafields[],
  context: RenderContext,
): string {
  const columns = definitions.map((definition) => definition.column);
  const header = [...IDENTITY_COLUMNS, ...columns];

  const rows = variants.map((variant) => [
    variant.productHandle,
    variant.productTitle,
    variant.sku ?? "",
    variant.title,
    ...optionCells(variant),
    ...definitions.map((definition) =>
      renderCell(definition, variant.values[definition.column] ?? "", context),
    ),
  ]);

  return toCsv([header, ...rows]);
}

/** A template with the columns but no variants, for starting from scratch. */
export function variantMetafieldTemplateCsv(
  definitions: RichTextDefinition[],
): string {
  return toCsv([
    [...IDENTITY_COLUMNS, ...definitions.map((d) => d.column)],
  ]);
}

/**
 * The definitions themselves, one row each.
 *
 * `pinned` and `storefront access` are here because both are invisible failure
 * modes the rest of this codebase already documents: an unpinned definition
 * accepts writes but never appears on the variant, and one without public
 * storefront access is unreadable by the theme. A definition that looks
 * imported but shows nowhere is almost always one of those two.
 *
 * Read-only. This file is documentation, not an import format.
 */
export function variantDefinitionsToCsv(
  definitions: RichTextDefinition[],
  typeByColumn: Map<string, string>,
): string {
  const header = [
    "name",
    "namespace",
    "key",
    "column",
    "type",
    "pinned",
    "storefront access",
    "metaobject definition",
  ];

  const rows = definitions.map((definition) => [
    definition.name,
    definition.namespace,
    definition.key,
    definition.column,
    definition.type,
    definition.pinned ? "TRUE" : "FALSE",
    definition.storefrontAccess ?? "",
    typeByColumn.get(definition.column) ?? "",
  ]);

  return toCsv([header, ...rows]);
}

// ---------------------------------------------------------------------------
// Import — resolving a cell back to an API value
// ---------------------------------------------------------------------------

/**
 * Rewrite metaobject display names in a cell to their handles.
 *
 * The resolution order is what lets the same column accept both forms:
 *
 *   1. `type:handle` — an explicit prefix is never second-guessed;
 *   2. a handle of the metafield's own metaobject definition;
 *   3. a display name of that definition, compared case-insensitively.
 *
 * Handles win over names so that a straight round trip of Shopify's own export,
 * whose cells are bare handles, behaves exactly as it did before this section
 * existed. A name that is not found is left alone rather than rejected here, so
 * the error the merchant reads comes from `toMetafieldValue` and names the
 * handle it looked for.
 *
 * Ambiguity is always an error. Display names are not unique, and quietly
 * picking the first of two "Peach" entries would write the wrong reference with
 * no sign that a choice was ever made.
 */
export function resolveDisplayNames(
  cell: string,
  type: string,
  index: MetaobjectIndex,
): { ok: true; cell: string } | { ok: false; message: string } {
  const parts = cell
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);

  const resolved: string[] = [];

  for (const part of parts) {
    if (part.includes(":")) {
      resolved.push(part);
      continue;
    }
    if (index.idByHandle.has(`${type}:${part}`)) {
      resolved.push(part);
      continue;
    }

    const handles = index.handlesByDisplayName.get(
      `${type}:${normalizeDisplayName(part)}`,
    );
    if (!handles || handles.length === 0) {
      resolved.push(part);
      continue;
    }
    if (handles.length > 1) {
      return {
        ok: false,
        message: `"${part}" matches ${handles.length} "${type}" entries (${handles.join(", ")}). Use the handle instead.`,
      };
    }
    resolved.push(handles[0]);
  }

  return { ok: true, cell: resolved.join(";") };
}

/**
 * Every reference a file names, so they can be resolved in one pass before
 * planning rather than one query at a time inside it.
 *
 * Runs the same display-name rewrite the planner will, so the handles collected
 * here are exactly the ones it will look up.
 */
export function collectImportRefs(
  definitions: RichTextDefinition[],
  records: Record<string, string>[],
  index: MetaobjectIndex,
): { metaobjects: { type: string; handle: string }[]; productHandles: string[] } {
  const metaobjects: { type: string; handle: string }[] = [];
  const productHandles: string[] = [];

  for (const record of records) {
    for (const definition of definitions) {
      const cell = (record[definition.column] ?? "").trim();
      if (!cell) continue;

      if (PRODUCT_REFERENCE_TYPES.includes(definition.type)) {
        productHandles.push(...productRefsIn(cell));
        continue;
      }
      if (!METAOBJECT_TYPES.includes(definition.type)) continue;

      const type = index.typeByColumn.get(definition.column);
      const normalised = type ? resolveDisplayNames(cell, type, index) : null;
      // An ambiguous name is reported by the planner; here it just contributes
      // no refs, because there is no single entry to look up.
      if (normalised && !normalised.ok) continue;

      metaobjects.push(
        ...metaobjectRefsIn(normalised ? normalised.cell : cell, type),
      );
    }
  }

  return { metaobjects, productHandles };
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

export type PlanContext = {
  /** `type:handle` → metaobject gid. */
  metaobjects: Map<string, string>;
  /** Lowercased product handle → product gid. */
  products: Map<string, string>;
  index: MetaobjectIndex;
  /**
   * Whether a blank cell erases the stored value.
   *
   * Off — the default, and the rule the rest of this app is built on — a
   * half-filled spreadsheet cannot destroy anything. On, a blank cell in a
   * metafield column deletes the metafield, which is what a merchant clearing a
   * discontinued colour family across a catalogue actually wants. Every clear
   * shows in the review step as a real `value → —` diff first.
   */
  clearEmpty: boolean;
};

/** A variant's option values, normalised for comparison. */
function optionKey(options: { name: string; value: string }[]): string {
  return options
    .map((option) => `${option.name.trim().toLowerCase()}=${option.value.trim().toLowerCase()}`)
    .sort()
    .join("|");
}

/** The option values a row names, in the same normalised form. */
function rowOptionKey(record: Record<string, string>): string {
  const options: { name: string; value: string }[] = [];
  for (let index = 1; index <= 3; index++) {
    const name = (record[`option${index} name`] ?? "").trim();
    const value = (record[`option${index} value`] ?? "").trim();
    if (name && value) options.push({ name, value });
  }
  return optionKey(options);
}

function shorten(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > 60 ? `${collapsed.slice(0, 57)}…` : collapsed;
}

/**
 * Compare a parsed CSV against the store and decide what each row would do,
 * without writing anything.
 *
 * Rows are matched by SKU first, then by product handle plus option values.
 * SKU comparison is case-sensitive — a SKU is a code, and two differing only in
 * case are two different variants — while handles and option values are not,
 * because a spreadsheet round trip changes their case and whitespace routinely
 * and changes nothing that matters.
 */
export function planVariantMetafieldImport(
  definitions: RichTextDefinition[],
  records: Record<string, string>[],
  variants: VariantMetafields[],
  context: PlanContext,
): VariantImportPlan {
  const byColumn = new Map(definitions.map((d) => [d.column, d]));

  // Inverted once, not per cell: the review table renders the *stored* value
  // for every change, and rebuilding this inside that loop would walk the whole
  // entry index once per metaobject cell in the file.
  const handleById = new Map<string, string>();
  for (const [key, id] of context.index.idByHandle) {
    handleById.set(id, key.slice(key.indexOf(":") + 1));
  }

  const bySku = new Map<string, VariantMetafields[]>();
  const byHandleAndOptions = new Map<string, VariantMetafields[]>();
  for (const variant of variants) {
    if (variant.sku?.trim()) {
      const key = variant.sku.trim();
      const list = bySku.get(key);
      if (list) list.push(variant);
      else bySku.set(key, [variant]);
    }

    const key = `${variant.productHandle.trim().toLowerCase()}#${optionKey(variant.selectedOptions)}`;
    const list = byHandleAndOptions.get(key);
    if (list) list.push(variant);
    else byHandleAndOptions.set(key, [variant]);
  }

  const presentColumns = Object.keys(records[0] ?? {});
  const unknownColumns = presentColumns.filter(
    (column) => !IDENTITY_COLUMNS.includes(column) && !byColumn.has(column),
  );

  const rows: VariantRowPlan[] = [];
  const counts = { update: 0, unchanged: 0, error: 0 };
  let writeCount = 0;
  let deleteCount = 0;

  records.forEach((record, position) => {
    // +2: one for the header row, one because a spreadsheet counts from 1.
    const rowNumber = position + 2;
    const sku = (record[SKU_COLUMN] ?? "").trim();
    const handle = (record[HANDLE_COLUMN] ?? "").trim();
    const label =
      [record[TITLE_COLUMN], record[VARIANT_TITLE_COLUMN]]
        .map((part) => (part ?? "").trim())
        .filter(Boolean)
        .join(" — ") ||
      sku ||
      handle;

    const fail = (message: string) => {
      counts.error++;
      rows.push({
        rowNumber,
        label,
        sku,
        action: "error",
        changes: [],
        message,
        writes: [],
        deletes: [],
      });
    };

    let matches: VariantMetafields[] | undefined;
    if (sku) {
      matches = bySku.get(sku);
      if (!matches?.length) {
        fail(`No variant with the SKU "${sku}".`);
        return;
      }
    } else if (handle) {
      const key = `${handle.toLowerCase()}#${rowOptionKey(record)}`;
      matches = byHandleAndOptions.get(key);
      if (!matches?.length) {
        fail(
          `No variant of "${handle}" with those option values. Add a ${SKU_COLUMN} column, or check the option name and value cells.`,
        );
        return;
      }
    } else {
      fail(
        `This row names no variant. Fill in ${SKU_COLUMN}, or ${HANDLE_COLUMN} plus the option columns.`,
      );
      return;
    }

    if (matches.length > 1) {
      fail(
        `${matches.length} variants match this row (${matches
          .map((variant) => `${variant.productHandle} / ${variant.title}`)
          .join(", ")}). ${sku ? "Two variants share this SKU." : `Add a ${SKU_COLUMN} column to tell them apart.`}`,
      );
      return;
    }

    const variant = matches[0];
    const writes: VariantWrite[] = [];
    const deletes: VariantDelete[] = [];
    const changes: string[] = [];
    const errors: string[] = [];

    for (const definition of definitions) {
      if (!(definition.column in record)) continue;

      const cell = (record[definition.column] ?? "").trim();
      const stored = (variant.values[definition.column] ?? "").trim();

      if (!cell) {
        // Blank means "leave this alone" unless the run says otherwise, and a
        // blank against a metafield that was never set is not a write either
        // way.
        if (!context.clearEmpty || !stored) continue;
        deletes.push({
          column: definition.column,
          namespace: definition.namespace,
          key: definition.key,
        });
        changes.push(
          `${definition.column}: ${shorten(
            renderStoredForDiff(definition, stored, handleById),
          )} → —`,
        );
        continue;
      }

      const metaobjectType = context.index.typeByColumn.get(definition.column);
      let source = cell;
      if (METAOBJECT_TYPES.includes(definition.type) && metaobjectType) {
        const resolved = resolveDisplayNames(cell, metaobjectType, context.index);
        if (!resolved.ok) {
          errors.push(`${definition.column}: ${resolved.message}`);
          continue;
        }
        source = resolved.cell;
      }

      const converted = toMetafieldValue(
        definition.type,
        source,
        context.metaobjects,
        metaobjectType,
        context.products,
      );
      if (!converted.ok) {
        errors.push(`${definition.column}: ${converted.message}`);
        continue;
      }

      if (converted.value === stored) continue;

      writes.push({
        column: definition.column,
        namespace: definition.namespace,
        key: definition.key,
        type: definition.type,
        value: converted.value,
      });
      changes.push(
        `${definition.column}: ${
          stored
            ? shorten(renderStoredForDiff(definition, stored, handleById))
            : "—"
        } → ${shorten(cell)}`,
      );
    }

    if (errors.length) {
      fail(errors.join(" "));
      return;
    }

    const action = writes.length || deletes.length ? "update" : "unchanged";
    counts[action]++;
    writeCount += writes.length;
    deleteCount += deletes.length;

    rows.push({
      rowNumber,
      label,
      sku,
      variantId: variant.id,
      action,
      changes,
      writes,
      deletes,
    });
  });

  return { rows, counts, unknownColumns, writeCount, deleteCount };
}

/**
 * The stored value, written the way the file writes it, for the diff.
 *
 * The planner has handles and names for everything the *file* named, but not
 * necessarily for what the store already holds — resolving those too would mean
 * a second round of lookups purely to render a review table. So a gid that
 * cannot be named is shown as its handle if the index happens to know it, and
 * otherwise as the gid: the diff stays honest about what is there rather than
 * pretending the old value was empty.
 */
function renderStoredForDiff(
  definition: RichTextDefinition,
  stored: string,
  handleById: Map<string, string>,
): string {
  if (!METAOBJECT_TYPES.includes(definition.type)) return stored;

  const parts = decodeList(stored);
  if (!parts) return stored;
  return parts.map((gid) => handleById.get(gid) ?? gid).join(";");
}
