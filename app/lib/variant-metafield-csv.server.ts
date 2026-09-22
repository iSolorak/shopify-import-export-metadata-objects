// The variant metafield CSV builders and the dry-run planner.
//
// Mirrors `rich-text-csv.ts` in structure — a row per owner, a column per
// metafield, and a plan that says what each row would do before anything is
// written — and differs in the one place that matters: the owner is a
// **variant**, and a reference cell is written the way a person reads it.
//
// `shopify.color-pattern` comes out of Shopify's own export as
// `01-peach-radiant`. Here it comes out as `Peach`, and `Peach` typed back into
// the cell resolves to the same entry. That round trip is the whole point of
// the section; everything else below exists to make it safe.
//
// Three kinds of metafield column can appear:
//
//   `custom.color_family`            a variant metafield — written
//   `product.shopify.color-pattern`  a product metafield — written once per
//                                    product, not once per row
//   `custom.color_family > color`    a field *inside* the referenced entry —
//                                    read-only
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
import type {
  DefinitionSet,
  MetaobjectIndex,
  MetaobjectRef,
  VariantMetafields,
} from "./variant-metafields.server";
import {
  HANDLE_COLUMN,
  IDENTITY_COLUMNS,
  SKU_COLUMN,
  TITLE_COLUMN,
  VARIANT_TITLE_COLUMN,
  expandedColumnName,
  isExpandedColumn,
  normalizeDisplayName,
  productColumnName,
  type ExportOptions,
  type MetafieldOwner,
  type PlannedDelete,
  type PlannedWrite,
  type ProductChange,
  type VariantImportPlan,
  type VariantRowPlan,
} from "./variant-metafield-columns";

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/**
 * One metafield column: where it came from and where a value written into it
 * would land.
 *
 * Both owners are handled through the same list so that nothing downstream has
 * to branch on which one it is until the moment a write is addressed.
 */
export type ColumnTarget = {
  column: string;
  definition: RichTextDefinition;
  owner: MetafieldOwner;
};

export function metafieldColumns(
  definitions: DefinitionSet,
  includeProduct: boolean,
): ColumnTarget[] {
  const targets: ColumnTarget[] = definitions.variant.map((definition) => ({
    column: definition.column,
    definition,
    owner: "PRODUCTVARIANT" as const,
  }));

  if (includeProduct) {
    for (const definition of definitions.product) {
      targets.push({
        column: productColumnName(definition.column),
        definition,
        owner: "PRODUCT",
      });
    }
  }

  return targets;
}

/** The stored value behind a target, for one variant. */
function storedValue(variant: VariantMetafields, target: ColumnTarget): string {
  return target.owner === "PRODUCT"
    ? (variant.productValues[target.definition.column] ?? "")
    : (variant.values[target.definition.column] ?? "");
}

/**
 * The read-only columns a reference target expands into.
 *
 * Only targets restricted to a single metaobject definition expand: those are
 * the only ones whose field keys are known before the data is read. A
 * `mixed_reference` may point at several definitions with different fields, so
 * its column set would change with the contents of the store.
 */
export function expandedColumns(
  targets: ColumnTarget[],
  index: MetaobjectIndex,
): { column: string; target: ColumnTarget; fieldKey: string }[] {
  const columns: { column: string; target: ColumnTarget; fieldKey: string }[] =
    [];

  for (const target of targets) {
    const type = index.typeByColumn.get(target.column);
    if (!type) continue;
    for (const fieldKey of index.fieldKeysByType.get(type) ?? []) {
      columns.push({
        column: expandedColumnName(target.column, fieldKey),
        target,
        fieldKey,
      });
    }
  }

  return columns;
}

// ---------------------------------------------------------------------------
// Rendering a stored value into a cell
// ---------------------------------------------------------------------------

/** Lookups the export needs to turn gids into something readable. */
export type RenderContext = {
  metaobjects: Map<string, MetaobjectRef>;
  products: Map<string, string>;
  refs: ExportOptions["refs"];
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

  if (context.refs === "name" && ref.displayName && joinable(ref.displayName)) {
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

  if (definition.type.startsWith("list.")) {
    const parts = decodeList(raw);
    // A list of objects — dimensions, money, ratings — has no readable
    // `;`-joined form, and `toMetafieldValue` passes a cell that already holds
    // JSON straight through, so the raw value round-trips untouched.
    if (!parts || !parts.every(joinable)) return raw;
    return parts.join(";");
  }

  return raw;
}

/**
 * One field of a referenced entry, rendered.
 *
 * Resolution stops one level down. A `shopify--color-pattern` entry's `color`
 * field is itself a reference to a `shopify--color` entry, and *that* one is
 * named here — but a third level is left as its gid rather than fanning out a
 * lookup per level with no obvious place to stop.
 */
function renderFieldValue(value: string, context: RenderContext): string {
  if (!value) return "";

  const parts = decodeList(value);
  if (!parts) return value;

  const rendered = parts.map((part) => {
    if (!part.startsWith("gid://shopify/Metaobject/")) return part;
    const ref = context.metaobjects.get(part);
    if (!ref) return part;
    return context.refs === "name" && ref.displayName && joinable(ref.displayName)
      ? ref.displayName
      : ref.handle;
  });

  return rendered.every(joinable) ? rendered.join(";") : value;
}

/** The expanded cell for one target's `fieldKey`, across every entry it names. */
export function renderExpandedCell(
  raw: string,
  fieldKey: string,
  context: RenderContext,
): string {
  if (!raw) return "";

  const gids = decodeList(raw);
  if (!gids) return "";

  return gids
    .map((gid) => {
      const ref = context.metaobjects.get(gid);
      if (!ref) return "";
      return renderFieldValue(ref.values[fieldKey] ?? "", context);
    })
    .join(";");
}

/** Every gid an export will need to resolve, gathered in one pass. */
export function collectReferenceIds(
  targets: ColumnTarget[],
  variants: VariantMetafields[],
): { metaobjectIds: string[]; productIds: string[] } {
  const metaobjectIds = new Set<string>();
  const productIds = new Set<string>();

  for (const variant of variants) {
    for (const target of targets) {
      const raw = storedValue(variant, target);
      if (!raw) continue;

      const isMetaobject = METAOBJECT_TYPES.includes(target.definition.type);
      const isProduct = PRODUCT_REFERENCE_TYPES.includes(target.definition.type);
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

/**
 * Metaobject gids sitting inside already-resolved entries' fields.
 *
 * The second and final level of reference resolution — see `renderFieldValue`.
 */
export function collectEntryFieldIds(
  refs: Map<string, MetaobjectRef>,
): string[] {
  const ids = new Set<string>();

  for (const ref of refs.values()) {
    for (const value of Object.values(ref.values)) {
      for (const part of decodeList(value) ?? []) {
        if (part.startsWith("gid://shopify/Metaobject/") && !refs.has(part)) {
          ids.add(part);
        }
      }
    }
  }

  return [...ids];
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
  targets: ColumnTarget[],
  expanded: { target: ColumnTarget; fieldKey: string; column: string }[],
  variants: VariantMetafields[],
  context: RenderContext,
): string {
  const header = [
    ...IDENTITY_COLUMNS,
    ...targets.map((target) => target.column),
    ...expanded.map((column) => column.column),
  ];

  const rows = variants.map((variant) => [
    variant.productHandle,
    variant.productTitle,
    variant.sku ?? "",
    variant.title,
    ...optionCells(variant),
    ...targets.map((target) =>
      renderCell(target.definition, storedValue(variant, target), context),
    ),
    ...expanded.map((column) =>
      renderExpandedCell(
        storedValue(variant, column.target),
        column.fieldKey,
        context,
      ),
    ),
  ]);

  return toCsv([header, ...rows]);
}

/**
 * A template with the columns but no variants, for starting from scratch.
 *
 * The expanded columns are deliberately absent: they are read-only, and a
 * template is a file to be filled in.
 */
export function variantMetafieldTemplateCsv(targets: ColumnTarget[]): string {
  return toCsv([[...IDENTITY_COLUMNS, ...targets.map((t) => t.column)]]);
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
  targets: ColumnTarget[],
  index: MetaobjectIndex,
): string {
  const header = [
    "owner",
    "name",
    "namespace",
    "key",
    "column",
    "type",
    "pinned",
    "storefront access",
    "metaobject definition",
    "entry fields",
  ];

  const rows = targets.map((target) => {
    const type = index.typeByColumn.get(target.column) ?? "";
    return [
      target.owner === "PRODUCT" ? "product" : "variant",
      target.definition.name,
      target.definition.namespace,
      target.definition.key,
      target.column,
      target.definition.type,
      target.definition.pinned ? "TRUE" : "FALSE",
      target.definition.storefrontAccess ?? "",
      type,
      (index.fieldKeysByType.get(type) ?? []).join(";"),
    ];
  });

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
  targets: ColumnTarget[],
  records: Record<string, string>[],
  index: MetaobjectIndex,
): { metaobjects: { type: string; handle: string }[]; productHandles: string[] } {
  const metaobjects: { type: string; handle: string }[] = [];
  const productHandles: string[] = [];

  for (const record of records) {
    for (const target of targets) {
      const cell = (record[target.column] ?? "").trim();
      if (!cell) continue;

      if (PRODUCT_REFERENCE_TYPES.includes(target.definition.type)) {
        productHandles.push(...productRefsIn(cell));
        continue;
      }
      if (!METAOBJECT_TYPES.includes(target.definition.type)) continue;

      const type = index.typeByColumn.get(target.column);
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
    .map(
      (option) =>
        `${option.name.trim().toLowerCase()}=${option.value.trim().toLowerCase()}`,
    )
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
 * The stored value, written roughly the way the file writes it, for the diff.
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

/** What one cell asks for, before it is known whether the rows agree. */
type CellIntent =
  | { kind: "write"; write: PlannedWrite }
  | { kind: "delete"; remove: PlannedDelete };

function intentSignature(intent: CellIntent): string {
  return intent.kind === "write" ? `w:${intent.write.value}` : "d";
}

/** One cell's asked-for change, or `null` when it asks for nothing. */
type CellSlot = {
  intent: CellIntent;
  change: string;
  rowNumbers: number[];
};

/**
 * Convert one cell against one target.
 *
 * Returns a null intent when the cell asks for nothing — blank with
 * `clearEmpty` off, or a value equal to what is already stored.
 */
function planCell(
  target: ColumnTarget,
  cell: string,
  stored: string,
  context: PlanContext,
): { ok: true; intent: CellIntent | null } | { ok: false; message: string } {
  const { definition } = target;

  if (!cell) {
    if (!context.clearEmpty || !stored) return { ok: true, intent: null };
    return {
      ok: true,
      intent: {
        kind: "delete",
        remove: {
          column: target.column,
          namespace: definition.namespace,
          key: definition.key,
        },
      },
    };
  }

  const metaobjectType = context.index.typeByColumn.get(target.column);
  let source = cell;
  if (METAOBJECT_TYPES.includes(definition.type) && metaobjectType) {
    const resolved = resolveDisplayNames(cell, metaobjectType, context.index);
    if (!resolved.ok) return { ok: false, message: resolved.message };
    source = resolved.cell;
  }

  const converted = toMetafieldValue(
    definition.type,
    source,
    context.metaobjects,
    metaobjectType,
    context.products,
  );
  if (!converted.ok) return { ok: false, message: converted.message };
  if (converted.value === stored) return { ok: true, intent: null };

  return {
    ok: true,
    intent: {
      kind: "write",
      write: {
        column: target.column,
        namespace: definition.namespace,
        key: definition.key,
        type: definition.type,
        value: converted.value,
      },
    },
  };
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
 *
 * Product metafield columns are collected across rows and reconciled at the
 * end. A file with forty rows for one product repeats that product's cells
 * forty times; writing them forty times would be waste, and letting the last
 * row win when two disagree would be a silent wrong answer. So agreement means
 * one write, and disagreement makes every row involved an error.
 */
export function planVariantMetafieldImport(
  targets: ColumnTarget[],
  records: Record<string, string>[],
  variants: VariantMetafields[],
  context: PlanContext,
): VariantImportPlan {
  const byColumn = new Map(targets.map((target) => [target.column, target]));

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
    (column) =>
      !IDENTITY_COLUMNS.includes(column) &&
      !byColumn.has(column) &&
      !isExpandedColumn(column),
  );
  const ignoredColumns = presentColumns.filter(isExpandedColumn);

  const rows: VariantRowPlan[] = [];

  // productId → column → intent signature → the intent and the rows wanting it.
  const productCells = new Map<string, Map<string, Map<string, CellSlot>>>();
  const productLabels = new Map<string, string>();

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
    productLabels.set(variant.productId, variant.productHandle);

    const writes: PlannedWrite[] = [];
    const deletes: PlannedDelete[] = [];
    const changes: string[] = [];
    const errors: string[] = [];

    for (const target of targets) {
      if (!(target.column in record)) continue;

      const cell = (record[target.column] ?? "").trim();
      const stored = storedValue(variant, target).trim();
      const result = planCell(target, cell, stored, context);

      if (!result.ok) {
        errors.push(`${target.column}: ${result.message}`);
        continue;
      }
      if (!result.intent) continue;

      const change = `${target.column}: ${
        stored
          ? shorten(renderStoredForDiff(target.definition, stored, handleById))
          : "—"
      } → ${result.intent.kind === "delete" ? "—" : shorten(cell)}`;

      if (target.owner === "PRODUCT") {
        // Held back until every row has been read — see the doc comment.
        const columns =
          productCells.get(variant.productId) ??
          new Map<string, Map<string, CellSlot>>();
        productCells.set(variant.productId, columns);

        const slots = columns.get(target.column) ?? new Map<string, CellSlot>();
        columns.set(target.column, slots);

        const signature = intentSignature(result.intent);
        const slot = slots.get(signature);
        if (slot) slot.rowNumbers.push(rowNumber);
        else {
          slots.set(signature, {
            intent: result.intent,
            change,
            rowNumbers: [rowNumber],
          });
        }
        continue;
      }

      if (result.intent.kind === "write") writes.push(result.intent.write);
      else deletes.push(result.intent.remove);
      changes.push(change);
    }

    if (errors.length) {
      fail(errors.join(" "));
      return;
    }

    rows.push({
      rowNumber,
      label,
      sku,
      variantId: variant.id,
      productId: variant.productId,
      action: writes.length || deletes.length ? "update" : "unchanged",
      changes,
      writes,
      deletes,
    });
  });

  // --- Reconcile the product columns ---------------------------------------
  const products: ProductChange[] = [];
  const conflicted = new Map<number, string[]>();

  for (const [productId, columns] of productCells) {
    const change: ProductChange = {
      productId,
      label: productLabels.get(productId) ?? productId,
      rowNumbers: [],
      writes: [],
      deletes: [],
      changes: [],
    };

    for (const [column, slots] of columns) {
      const wanted = [...slots.values()];

      if (wanted.length > 1) {
        const message = `Rows disagree about "${column}" for ${change.label}: ${wanted
          .map(
            (slot) =>
              `row${slot.rowNumbers.length > 1 ? "s" : ""} ${slot.rowNumbers.join(", ")} → ${slot.change.slice(slot.change.indexOf("→") + 1).trim()}`,
          )
          .join("; ")}. A product metafield holds one value for every variant.`;

        for (const slot of wanted) {
          for (const rowNumber of slot.rowNumbers) {
            const list = conflicted.get(rowNumber) ?? [];
            list.push(message);
            conflicted.set(rowNumber, list);
          }
        }
        continue;
      }

      const only = wanted[0];
      if (!only) continue;
      change.rowNumbers.push(...only.rowNumbers);
      change.changes.push(only.change);
      if (only.intent.kind === "write") change.writes.push(only.intent.write);
      else change.deletes.push(only.intent.remove);
    }

    if (change.writes.length || change.deletes.length) products.push(change);
  }

  // A row caught in a conflict is an error, even if its own variant cells were
  // fine: half-applying a row the merchant has to come back and fix anyway is
  // worse than reporting it whole.
  for (const row of rows) {
    const messages = conflicted.get(row.rowNumber);
    if (!messages) continue;
    row.action = "error";
    row.message = [row.message, ...messages].filter(Boolean).join(" ");
    row.writes = [];
    row.deletes = [];
    row.changes = [];
  }

  // A product change whose every row turned out to be an error is dropped:
  // nothing is left standing behind it.
  const liveRows = new Set(
    rows.filter((row) => row.action !== "error").map((row) => row.rowNumber),
  );
  const liveProducts = products.filter((change) =>
    change.rowNumbers.some((rowNumber) => liveRows.has(rowNumber)),
  );

  const productRows = new Set(
    liveProducts.flatMap((change) => change.rowNumbers),
  );
  const counts = { update: 0, unchanged: 0, error: 0 };
  for (const row of rows) {
    // A row whose only change is a product metafield still changed something.
    if (row.action === "unchanged" && productRows.has(row.rowNumber)) {
      row.action = "update";
    }
    counts[row.action]++;
  }

  return {
    rows,
    products: liveProducts,
    counts,
    unknownColumns,
    ignoredColumns,
    writeCount: rows.reduce((total, row) => total + row.writes.length, 0),
    deleteCount: rows.reduce((total, row) => total + row.deletes.length, 0),
    productWriteCount: liveProducts.reduce(
      (total, change) => total + change.writes.length,
      0,
    ),
    productDeleteCount: liveProducts.reduce(
      (total, change) => total + change.deletes.length,
      0,
    ),
  };
}
