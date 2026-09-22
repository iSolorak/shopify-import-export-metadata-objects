// Colour Family: discovery, CSV building, and the import planner.
//
// The variant metafields section can already carry a colour family column, but
// only as one of however many metafields a store defines, and only ever as an
// *assignment* — the entry behind `Peach Tones` is edited somewhere else
// entirely, on the metaobject page, in a file that knows nothing about which
// variants are affected. This section is the two halves in one sheet:
//
//   `color family`      → which family the variant is in     (variant metafield)
//   `color family hex`  → what that family looks like        (metaobject entry)
//   `shopify color`     → the standard colour behind it      (read-only)
//
// A row is a **variant**, so the third column can exist at all: the Shopify
// standard colour is reached by following the family's own reference, or the
// variant's `color-pattern` metafield, and neither is addressable from a
// family-per-row sheet.
//
// The two writable halves have very different blast radius, which is why the
// planner separates them: assigning a family touches one variant, editing a
// family's hex touches every variant in it. The review step names both, and the
// entry edits are collapsed and cross-checked before anything is written.

import { toCsv } from "./csv";
import {
  getDefinition,
  getEntries,
  listDefinitions,
  type Definition,
} from "./metaobjects.server";
import {
  listMetafieldDefinitions,
  type MetafieldOwner,
  type RichTextDefinition,
} from "./product-metafields.server";
import {
  METAOBJECT_TYPES,
  toMetafieldValue,
} from "./product-write.server";
import {
  buildMetaobjectIndex,
  type MetaobjectIndex,
  type MetaobjectRef,
  type VariantMetafields,
} from "./variant-metafields.server";
import {
  HANDLE_COLUMN,
  SKU_COLUMN,
  TITLE_COLUMN,
  VARIANT_TITLE_COLUMN,
  normalizeDisplayName,
} from "./variant-metafield-columns";
import {
  FAMILY_COLUMN,
  FAMILY_HANDLE_COLUMN,
  FAMILY_HEX_COLUMN,
  IDENTITY_COLUMNS,
  READ_ONLY_COLUMNS,
  SHOPIFY_COLOR_COLUMN,
  SHOPIFY_COLOR_HEX_COLUMN,
  familyFieldColumn,
  familyFieldKeyOf,
  type ColorFamilyPlan,
  type ColorFamilyRowPlan,
  type FamilyEntryChange,
  type RefStyle,
} from "./color-family";

type Admin = Parameters<typeof listDefinitions>[0];

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Everything this section needs to know about how a store models colour.
 *
 * Nothing here is hard-coded to a type string. A store may call the definition
 * `color_family`, `colour_family` or `shade_family`, may key the hex field
 * `color`, `hex` or `swatch`, and may hang the standard colour off the family
 * or off the product. Guessing wrong writes to the wrong place silently, so
 * every one of those is discovered from the store's own definitions and the
 * result is shown on the page before anything is exported.
 */
export type ColorFamilySetup = {
  /** The colour family metaobject definition itself. */
  definition: Definition;
  /** The variant metafield that points at it. Where an assignment is written. */
  metafield: RichTextDefinition;
  /** The family field holding a hex colour, if it has one. */
  hexFieldKey: string | null;
  /** The family's other fields, in definition order. */
  otherFieldKeys: string[];
  /**
   * A `color-pattern` metafield, used only as a fallback when the family
   * carries no link to a standard colour of its own.
   */
  colorPattern: { definition: RichTextDefinition; owner: MetafieldOwner } | null;
  /** Every colour family definition in the store, so the page can offer a swap. */
  candidates: { type: string; name: string; entryCount: number }[];
};

/** Matches `color family`, `colour-family`, `color_family`, `ColorFamily`. */
const FAMILY_TYPE = /colou?r[-_ ]?family/i;

/** A field whose stored value is a hex colour. */
const COLOR_FIELD_TYPES = ["color", "list.color"];

/** Standard definitions holding a named colour and its hex. */
const STANDARD_COLOR_TYPES = ["shopify--color", "shopify--color-pattern"];

function isColorish(type: string): boolean {
  return STANDARD_COLOR_TYPES.includes(type) || /colou?r/i.test(type);
}

/**
 * Find the colour family definition, the metafield pointing at it, and the
 * route to a standard colour.
 *
 * `type` overrides the name match, for a store whose definition is called
 * something this would not guess — the page passes whatever the merchant
 * picked from `candidates`.
 */
export async function discoverColorFamily(
  admin: Admin,
  type?: string,
): Promise<
  { ok: true; setup: ColorFamilySetup } | { ok: false; message: string }
> {
  const summaries = await listDefinitions(admin);
  const candidates = summaries
    .filter((summary) => FAMILY_TYPE.test(summary.type) || FAMILY_TYPE.test(summary.name))
    .map(({ type: t, name, entryCount }) => ({ type: t, name, entryCount }));

  // An explicit pick is honoured even when its name looks nothing like a
  // colour family; the list is a shortcut, not a restriction.
  const wanted = type
    ? summaries.find((summary) => summary.type === type)
    : summaries.find((summary) => FAMILY_TYPE.test(summary.type)) ??
      summaries.find((summary) => FAMILY_TYPE.test(summary.name));

  if (!wanted) {
    return {
      ok: false,
      message: type
        ? `This store has no metaobject definition of type "${type}".`
        : "No colour family metaobject definition found. Create one in Settings → Custom data → Metaobjects — or import its definition CSV on the Import & export page — then define a variant metafield that references it.",
    };
  }

  const definition = await getDefinition(admin, wanted.type);
  if (!definition) {
    return {
      ok: false,
      message: `This store has no metaobject definition of type "${wanted.type}".`,
    };
  }

  const [variantDefinitions, productDefinitions] = await Promise.all([
    listMetafieldDefinitions(admin, "PRODUCTVARIANT"),
    listMetafieldDefinitions(admin, "PRODUCT"),
  ]);

  const pointing = variantDefinitions.filter(
    (candidate) =>
      METAOBJECT_TYPES.includes(candidate.type) &&
      candidate.metaobjectDefinitionId === definition.id,
  );
  // A single reference wins over a list one. A variant is in one family, and
  // the list form would let a sheet hold several with only the first of them
  // ever shown in a cell — see `familyGid`.
  const metafield =
    pointing.find((candidate) => !candidate.type.startsWith("list.")) ??
    pointing[0];
  if (!metafield) {
    return {
      ok: false,
      message: `No variant metafield references "${definition.name}" (${definition.type}). Create one in Settings → Custom data → Variants with type "Metaobject reference", restricted to that definition — without it there is nothing on a variant to assign a family to.`,
    };
  }

  // The `color-pattern` fallback. Its metaobject definition's *type* lives
  // behind the metafield's validation id, so the index is what turns the two
  // into a comparison.
  const columns = [
    ...variantDefinitions.map((candidate) => ({
      column: candidate.column,
      definition: candidate,
      owner: "PRODUCTVARIANT" as const,
    })),
    ...productDefinitions.map((candidate) => ({
      column: candidate.column,
      definition: candidate,
      owner: "PRODUCT" as const,
    })),
  ].filter(({ definition: candidate }) =>
    METAOBJECT_TYPES.includes(candidate.type),
  );

  const index = await buildMetaobjectIndex(admin, columns, { entries: false });
  const pattern =
    columns.find(({ column, definition: candidate }) => {
      const referenced = index.typeByColumn.get(column);
      return (
        candidate.metaobjectDefinitionId !== definition.id &&
        referenced != null &&
        STANDARD_COLOR_TYPES.includes(referenced)
      );
    }) ?? null;

  const hexFieldKey =
    definition.fieldDefinitions.find((field) =>
      COLOR_FIELD_TYPES.includes(field.type),
    )?.key ?? null;

  return {
    ok: true,
    setup: {
      definition,
      metafield,
      hexFieldKey,
      otherFieldKeys: definition.fieldDefinitions
        .map((field) => field.key)
        .filter((key) => key !== hexFieldKey),
      colorPattern: pattern
        ? { definition: pattern.definition, owner: pattern.owner }
        : null,
      candidates,
    },
  };
}

/** The definitions an export has to read to fill every column. */
export function readDefinitions(setup: ColorFamilySetup): {
  variant: RichTextDefinition[];
  product: RichTextDefinition[];
} {
  const variant = [setup.metafield];
  const product: RichTextDefinition[] = [];

  if (setup.colorPattern) {
    if (setup.colorPattern.owner === "PRODUCT") {
      product.push(setup.colorPattern.definition);
    } else if (setup.colorPattern.definition.column !== setup.metafield.column) {
      variant.push(setup.colorPattern.definition);
    }
  }

  return { variant, product };
}

// ---------------------------------------------------------------------------
// Reading a stored value
// ---------------------------------------------------------------------------

/**
 * The gids in a metafield value.
 *
 * A `metaobject_reference` stores one bare gid; the list variants store a JSON
 * array. Both are handled here so nothing downstream has to branch on which
 * shape a store happened to define.
 */
function gidsIn(raw: string): string[] {
  const value = raw.trim();
  if (!value) return [];
  if (!value.startsWith("[")) return [value];

  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [value];
  } catch {
    return [value];
  }
}

/** The family a variant is in, if any. */
function familyGid(
  setup: ColorFamilySetup,
  variant: VariantMetafields,
): string | null {
  return gidsIn(variant.values[setup.metafield.column] ?? "")[0] ?? null;
}

function patternGids(
  setup: ColorFamilySetup,
  variant: VariantMetafields,
): string[] {
  if (!setup.colorPattern) return [];
  const column = setup.colorPattern.definition.column;
  const raw =
    setup.colorPattern.owner === "PRODUCT"
      ? variant.productValues[column]
      : variant.values[column];
  return gidsIn(raw ?? "");
}

/** Every metaobject gid the first resolution pass has to fetch. */
export function collectColorIds(
  setup: ColorFamilySetup,
  variants: VariantMetafields[],
): string[] {
  const ids = new Set<string>();
  for (const variant of variants) {
    const family = familyGid(setup, variant);
    if (family) ids.add(family);
    for (const gid of patternGids(setup, variant)) ids.add(gid);
  }
  return [...ids];
}

/**
 * Gids sitting inside already-resolved entries.
 *
 * A `shopify--color-pattern` entry's `color` field is itself a reference to a
 * `shopify--color` entry, and that second entry is where the hex actually is —
 * so resolution runs twice. It stops there: a third level has no known payload
 * and no obvious place to stop after it.
 */
export function collectNestedIds(refs: Map<string, MetaobjectRef>): string[] {
  const ids = new Set<string>();
  for (const ref of refs.values()) {
    for (const value of Object.values(ref.values)) {
      for (const gid of gidsIn(value)) {
        if (gid.startsWith("gid://shopify/Metaobject/") && !refs.has(gid)) {
          ids.add(gid);
        }
      }
    }
  }
  return [...ids];
}

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** The first hex-looking value among an entry's fields. */
function hexOf(ref: MetaobjectRef): string {
  for (const value of Object.values(ref.values)) {
    const trimmed = value.trim();
    if (HEX.test(trimmed)) return trimmed;
  }
  return "";
}

export type ColorContext = {
  metaobjects: Map<string, MetaobjectRef>;
  refs: RefStyle;
};

/**
 * The Shopify standard colour behind a variant, and its hex.
 *
 * Tried in order: the family's own reference first, because a family that
 * names its standard colour is saying something specific about *that family*;
 * the variant's or product's `color-pattern` metafield second, which is the
 * store-wide fallback. Whichever is found, the search walks down to whatever
 * entry actually carries a hex — a colour pattern's hex is one level below it.
 */
function shopifyColorOf(
  starts: string[],
  context: ColorContext,
): { name: string; hex: string } {
  const seen = new Set<string>();
  const queue = [...starts];
  let best: MetaobjectRef | null = null;

  while (queue.length) {
    const gid = queue.shift()!;
    if (seen.has(gid)) continue;
    seen.add(gid);

    const ref = context.metaobjects.get(gid);
    if (!ref) continue;

    if (isColorish(ref.type)) {
      // A `shopify--color` beats a `shopify--color-pattern`: it is the entry
      // that names one colour, and the one that carries the hex.
      if (!best || (ref.type === "shopify--color" && best.type !== "shopify--color")) {
        best = ref;
      }
    }

    for (const value of Object.values(ref.values)) {
      for (const nested of gidsIn(value)) {
        if (nested.startsWith("gid://shopify/Metaobject/")) queue.push(nested);
      }
    }
  }

  if (!best) return { name: "", hex: "" };

  // The hex may sit on the entry itself or on what it points at — a pattern
  // entry names the colour but stores the swatch one level down.
  let hex = hexOf(best);
  if (!hex) {
    for (const gid of seen) {
      const ref = context.metaobjects.get(gid);
      if (!ref || !isColorish(ref.type)) continue;
      hex = hexOf(ref);
      if (hex) break;
    }
  }

  return { name: best.displayName?.trim() || best.handle, hex };
}

/** Render a family field for the CSV, naming any entry it points at. */
function renderFieldValue(value: string, context: ColorContext): string {
  const gids = gidsIn(value);
  if (!gids.length) return "";
  if (gids.length === 1 && !gids[0].startsWith("gid://")) return gids[0];

  const parts = gids.map((gid) => {
    if (!gid.startsWith("gid://shopify/Metaobject/")) return gid;
    const ref = context.metaobjects.get(gid);
    if (!ref) return gid;
    return context.refs === "name" && ref.displayName?.trim()
      ? ref.displayName.trim()
      : ref.handle;
  });

  // A value containing the separator cannot be round-tripped through a joined
  // cell, so it is left exactly as stored rather than silently mangled.
  return parts.some((part) => part.includes(";")) ? value : parts.join(";");
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function colorFamilyColumns(setup: ColorFamilySetup): string[] {
  return [
    ...IDENTITY_COLUMNS,
    FAMILY_COLUMN,
    FAMILY_HANDLE_COLUMN,
    ...(setup.hexFieldKey ? [FAMILY_HEX_COLUMN] : []),
    ...setup.otherFieldKeys.map(familyFieldColumn),
    SHOPIFY_COLOR_COLUMN,
    SHOPIFY_COLOR_HEX_COLUMN,
  ];
}

function identityCells(variant: VariantMetafields): string[] {
  const options = [0, 1, 2].flatMap((index) => {
    const option = variant.selectedOptions[index];
    return [option?.name ?? "", option?.value ?? ""];
  });

  return [
    variant.productHandle,
    variant.productTitle,
    variant.sku ?? "",
    variant.title,
    ...options,
  ];
}

export function colorFamilyCsv(
  setup: ColorFamilySetup,
  variants: VariantMetafields[],
  context: ColorContext,
): string {
  const header = colorFamilyColumns(setup);

  const rows = variants.map((variant) => {
    const gid = familyGid(setup, variant);
    const family = gid ? context.metaobjects.get(gid) : undefined;
    const name =
      family &&
      (context.refs === "name" && family.displayName?.trim()
        ? family.displayName.trim()
        : family.handle);

    const color = shopifyColorOf(
      [...(gid ? [gid] : []), ...patternGids(setup, variant)],
      context,
    );

    return [
      ...identityCells(variant),
      name ?? "",
      family?.handle ?? "",
      ...(setup.hexFieldKey
        ? [family?.values[setup.hexFieldKey]?.trim() ?? ""]
        : []),
      ...setup.otherFieldKeys.map((key) =>
        family ? renderFieldValue(family.values[key] ?? "", context) : "",
      ),
      color.name,
      color.hex,
    ];
  });

  return toCsv([header, ...rows]);
}

export function colorFamilyTemplateCsv(setup: ColorFamilySetup): string {
  return toCsv([colorFamilyColumns(setup)]);
}

/** Keep only variants that are in a family. */
export function assignedOnly(
  setup: ColorFamilySetup,
  variants: VariantMetafields[],
): VariantMetafields[] {
  return variants.filter((variant) => familyGid(setup, variant) != null);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

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
 * Turn whatever a `color family` cell holds into a family handle.
 *
 * Handles win over display names, so a round trip of a handle-style export
 * writes back what it read. An ambiguous display name is always an error:
 * names are not unique, and quietly picking the first of two "Peach" families
 * would reassign variants with no sign a choice was ever made.
 *
 * A family that does not exist is an error too. Creating one from a name alone
 * would mean inventing a handle and leaving every other field blank, which is
 * a worse outcome than a row that says so.
 */
export function resolveFamilyHandle(
  cell: string,
  type: string,
  index: MetaobjectIndex,
): { ok: true; handle: string } | { ok: false; message: string } {
  const value = cell.trim();

  if (index.idByHandle.has(`${type}:${value}`)) {
    return { ok: true, handle: value };
  }

  const handles = index.handlesByDisplayName.get(
    `${type}:${normalizeDisplayName(value)}`,
  );
  if (!handles?.length) {
    return {
      ok: false,
      message: `No "${type}" entry called "${value}". Create it on the Import & export page first — this page does not invent families.`,
    };
  }
  if (handles.length > 1) {
    return {
      ok: false,
      message: `"${value}" matches ${handles.length} families (${handles.join(", ")}). Use the handle instead.`,
    };
  }

  return { ok: true, handle: handles[0] };
}

/** A family entry as the planner needs it: what it is called, and what is in it. */
export type FamilyEntry = {
  displayName: string | null;
  values: Record<string, string>;
};

export type ColorFamilyPlanContext = {
  index: MetaobjectIndex;
  /** The store's entries as they are now, by handle, for the field diff. */
  entries: Map<string, FamilyEntry>;
  /**
   * Whether a blank `color family` cell removes the variant from its family.
   *
   * Off — the rule the rest of this app is built on — so a half-filled
   * spreadsheet cannot unassign a catalogue. On, every clear still shows in the
   * review step as a real `Peach Tones → —` diff first.
   */
  clearEmpty: boolean;
};

/**
 * Read every family entry once, for both the name lookup and the field diff.
 *
 * `buildMetaobjectIndex` would give the first of those, but it keeps only
 * handles and display names — and the planner also needs each entry's current
 * field values to tell a real edit from a cell that was never touched. Since
 * the type is already known from the setup, the index is built here from the
 * same read rather than paying for a second one.
 */
export async function loadFamilyEntries(
  admin: Admin,
  setup: ColorFamilySetup,
): Promise<{ index: MetaobjectIndex; entries: Map<string, FamilyEntry> }> {
  const type = setup.definition.type;
  const list = await getEntries(admin, type);

  const index: MetaobjectIndex = {
    typeByColumn: new Map([[setup.metafield.column, type]]),
    idByHandle: new Map(),
    handlesByDisplayName: new Map(),
    fieldKeysByType: new Map([
      [type, setup.definition.fieldDefinitions.map((field) => field.key)],
    ]),
  };
  const entries = new Map<string, FamilyEntry>();

  for (const entry of list) {
    index.idByHandle.set(`${type}:${entry.handle}`, entry.id);
    entries.set(entry.handle, {
      displayName: entry.displayName,
      values: entry.values,
    });

    if (!entry.displayName) continue;
    const key = `${type}:${normalizeDisplayName(entry.displayName)}`;
    const handles = index.handlesByDisplayName.get(key);
    if (handles) handles.push(entry.handle);
    else index.handlesByDisplayName.set(key, [entry.handle]);
  }

  return { index, entries };
}

export function planColorFamilyImport(
  setup: ColorFamilySetup,
  records: Record<string, string>[],
  variants: VariantMetafields[],
  context: ColorFamilyPlanContext,
): ColorFamilyPlan {
  const type = setup.definition.type;
  const fieldColumns = new Map<string, string>();
  if (setup.hexFieldKey) fieldColumns.set(FAMILY_HEX_COLUMN, setup.hexFieldKey);
  for (const key of setup.otherFieldKeys) {
    fieldColumns.set(familyFieldColumn(key), key);
  }

  // Inverted once, not per row: every row renders the family it is moving
  // *away* from, and rebuilding this inside that loop would walk the whole
  // entry index once per row.
  const handleById = new Map<string, string>();
  for (const [key, id] of context.index.idByHandle) {
    if (key.startsWith(`${type}:`)) handleById.set(id, key.slice(type.length + 1));
  }

  const bySku = new Map<string, VariantMetafields[]>();
  const byTitle = new Map<string, VariantMetafields[]>();
  const byOptions = new Map<string, VariantMetafields[]>();
  const push = <K,>(map: Map<K, VariantMetafields[]>, key: K, variant: VariantMetafields) => {
    const list = map.get(key);
    if (list) list.push(variant);
    else map.set(key, [variant]);
  };

  for (const variant of variants) {
    if (variant.sku?.trim()) push(bySku, variant.sku.trim(), variant);
    const handle = variant.productHandle.trim().toLowerCase();
    push(byTitle, `${handle}#${variant.title.trim().toLowerCase()}`, variant);
    push(byOptions, `${handle}#${optionKey(variant.selectedOptions)}`, variant);
  }

  const presentColumns = Object.keys(records[0] ?? {});
  const known = new Set([
    ...IDENTITY_COLUMNS,
    FAMILY_COLUMN,
    ...READ_ONLY_COLUMNS,
    ...fieldColumns.keys(),
  ]);
  const unknownColumns = presentColumns.filter(
    (column) => !known.has(column) && familyFieldKeyOf(column) == null,
  );
  // A field column for a key this definition does not have is named as ignored
  // rather than unknown: the file is for this page, just for a different
  // version of the definition.
  const ignoredColumns = presentColumns.filter(
    (column) =>
      READ_ONLY_COLUMNS.includes(column) ||
      (familyFieldKeyOf(column) != null && !fieldColumns.has(column)),
  );

  const rows: ColorFamilyRowPlan[] = [];
  // family handle → column → value → the rows asking for it.
  const familyCells = new Map<
    string,
    Map<string, Map<string, { value: string; change: string; rowNumbers: number[] }>>
  >();

  records.forEach((record, position) => {
    // +2: one for the header row, one because a spreadsheet counts from 1.
    const rowNumber = position + 2;
    const sku = (record[SKU_COLUMN] ?? "").trim();
    const handle = (record[HANDLE_COLUMN] ?? "").trim();
    const variantTitle = (record[VARIANT_TITLE_COLUMN] ?? "").trim();
    const label =
      [record[TITLE_COLUMN], record[VARIANT_TITLE_COLUMN]]
        .map((part) => (part ?? "").trim())
        .filter(Boolean)
        .join(" — ") ||
      sku ||
      handle;

    const fail = (message: string) => {
      rows.push({ rowNumber, label, sku, action: "error", changes: [], message });
    };

    // SKU first — it is the one key that identifies a variant on its own.
    // Handle plus variant title next, then handle plus the option columns,
    // which is what a store that does not use SKUs has to rely on.
    let matches: VariantMetafields[] | undefined;
    let how = "";
    if (sku) {
      matches = bySku.get(sku);
      how = `the SKU "${sku}"`;
    } else if (handle && variantTitle) {
      matches = byTitle.get(`${handle.toLowerCase()}#${variantTitle.toLowerCase()}`);
      how = `"${handle}" / "${variantTitle}"`;
    } else if (handle) {
      matches = byOptions.get(`${handle.toLowerCase()}#${rowOptionKey(record)}`);
      how = `"${handle}" with those option values`;
    } else {
      fail(
        `This row names no variant. Fill in ${SKU_COLUMN}, or ${HANDLE_COLUMN} plus ${VARIANT_TITLE_COLUMN}.`,
      );
      return;
    }

    if (!matches?.length) {
      fail(`No variant matched by ${how}.`);
      return;
    }
    if (matches.length > 1) {
      fail(
        `${matches.length} variants match ${how} (${matches
          .map((variant) => `${variant.productHandle} / ${variant.title}`)
          .join(", ")}). ${sku ? "Two variants share this SKU." : `Add a ${SKU_COLUMN} column to tell them apart.`}`,
      );
      return;
    }

    const variant = matches[0];
    const changes: string[] = [];
    const errors: string[] = [];

    // --- Which family does this row talk about? ---------------------------
    // The writable column decides, not the read-only handle column: a row that
    // moves a variant to Peach Tones *and* sets a hex means that hex for Peach
    // Tones. The handle column only stands in when the name cell is blank.
    const cell = (record[FAMILY_COLUMN] ?? "").trim();
    const fallbackHandle = (record[FAMILY_HANDLE_COLUMN] ?? "").trim();

    let target: string | null = null;
    if (cell) {
      const resolved = resolveFamilyHandle(cell, type, context.index);
      if (resolved.ok) target = resolved.handle;
      else errors.push(`${FAMILY_COLUMN}: ${resolved.message}`);
    } else if (fallbackHandle && context.index.idByHandle.has(`${type}:${fallbackHandle}`)) {
      target = fallbackHandle;
    }

    // --- The assignment ----------------------------------------------------
    const storedGid = familyGid(setup, variant);
    const storedHandle = storedGid ? handleById.get(storedGid) ?? "" : "";

    let assign: ColorFamilyRowPlan["assign"];
    if (FAMILY_COLUMN in record) {
      if (cell && target && target !== storedHandle) {
        const value = toMetafieldValue(
          setup.metafield.type,
          target,
          context.index.idByHandle,
          type,
        );
        if (value.ok) {
          assign = { kind: "write", value: value.value, handle: target };
          changes.push(`${FAMILY_COLUMN}: ${storedHandle || "—"} → ${target}`);
        } else {
          errors.push(`${FAMILY_COLUMN}: ${value.message}`);
        }
      } else if (!cell && context.clearEmpty && storedGid) {
        assign = { kind: "clear" };
        changes.push(`${FAMILY_COLUMN}: ${storedHandle || "—"} → —`);
      }
    }

    // --- The family's own fields ------------------------------------------
    // Held back until every row has been read, so the forty rows of a
    // forty-variant family become one write and any disagreement between them
    // is caught rather than resolved by whichever row came last.
    if (target) {
      const entry = context.entries.get(target);
      for (const [column, key] of fieldColumns) {
        if (!(column in record)) continue;

        const wanted = (record[column] ?? "").trim();
        const stored = (entry?.values[key] ?? "").trim();
        // A blank field cell is always "leave it alone". `clearEmpty` is about
        // the variant's assignment; blanking a shared entry's field from a
        // variant row is not something a spreadsheet should be able to do by
        // omission.
        if (!wanted || wanted === stored) continue;

        const columns =
          familyCells.get(target) ??
          new Map<string, Map<string, { value: string; change: string; rowNumbers: number[] }>>();
        familyCells.set(target, columns);
        const slots = columns.get(column) ?? new Map<string, { value: string; change: string; rowNumbers: number[] }>();
        columns.set(column, slots);

        const slot = slots.get(wanted);
        if (slot) slot.rowNumbers.push(rowNumber);
        else {
          slots.set(wanted, {
            value: wanted,
            change: `${column}: ${shorten(stored) || "—"} → ${shorten(wanted)}`,
            rowNumbers: [rowNumber],
          });
        }
      }
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
      action: assign ? "update" : "unchanged",
      changes,
      ...(assign ? { assign } : {}),
    });
  });

  // --- Reconcile the family entry edits -------------------------------------
  const families: FamilyEntryChange[] = [];
  const conflicted = new Map<number, string[]>();

  for (const [handle, columns] of familyCells) {
    const change: FamilyEntryChange = {
      handle,
      label: context.entries.get(handle)?.displayName?.trim() || handle,
      rowNumbers: [],
      values: {},
      changes: [],
    };

    for (const [column, slots] of columns) {
      const wanted = [...slots.values()];

      if (wanted.length > 1) {
        const message = `Rows disagree about "${column}" for ${change.label}: ${wanted
          .map(
            (slot) =>
              `row${slot.rowNumbers.length > 1 ? "s" : ""} ${slot.rowNumbers.join(", ")} → ${shorten(slot.value)}`,
          )
          .join("; ")}. A family holds one value for every variant in it.`;

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
      change.values[fieldColumns.get(column)!] = only.value;
    }

    if (Object.keys(change.values).length) families.push(change);
  }

  // A row caught in a conflict is an error even if its own assignment was
  // fine: half-applying a row the merchant has to come back and fix anyway is
  // worse than reporting it whole.
  for (const row of rows) {
    const messages = conflicted.get(row.rowNumber);
    if (!messages) continue;
    row.action = "error";
    row.message = [row.message, ...messages].filter(Boolean).join(" ");
    row.changes = [];
    delete row.assign;
  }

  const liveRows = new Set(
    rows.filter((row) => row.action !== "error").map((row) => row.rowNumber),
  );
  const liveFamilies = families.filter((change) =>
    change.rowNumbers.some((rowNumber) => liveRows.has(rowNumber)),
  );

  const familyRows = new Set(liveFamilies.flatMap((change) => change.rowNumbers));
  const counts = { update: 0, unchanged: 0, error: 0 };
  for (const row of rows) {
    // A row whose only change is to the family entry still changed something.
    if (row.action === "unchanged" && familyRows.has(row.rowNumber)) {
      row.action = "update";
    }
    counts[row.action]++;
  }

  return {
    type,
    column: setup.metafield.column,
    rows,
    families: liveFamilies,
    counts,
    unknownColumns,
    ignoredColumns,
    assignCount: rows.filter((row) => row.assign?.kind === "write").length,
    clearCount: rows.filter((row) => row.assign?.kind === "clear").length,
    familyFieldCount: liveFamilies.reduce(
      (total, change) => total + Object.keys(change.values).length,
      0,
    ),
  };
}
