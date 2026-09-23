// Colour Family: discovery, CSV building, and the import planner.
//
// The variant metafields section can already carry a colour family column, but
// only as one of however many metafields a store defines, and only ever as an
// *assignment* — the entry behind `Peach Tones` is edited somewhere else
// entirely, on the metaobject page, in a file that knows nothing about which
// variants are affected. This section is both halves in one sheet:
//
//   `color family`      → which family the variant is in
//   `color family hex`  → what that family looks like        (metaobject entry)
//   `shopify color`     → the standard colour on the variant (read-only)
//
// ## The positional list
//
// A store may hold the assignment on the variant, which is simple. This one
// holds it on the **product**, as a list whose Nth entry belongs to the Nth
// variant — exactly the shape Shopify's own `shopify.color-pattern` uses, and
// the reason a row can show a variant's colour at all:
//
//   advanced-care-lipstick-matt   mt-200-mellow-…;mt-201-caramel-…;mt-202-…
//     variant 1  SKU 59103200  →  mt-200-mellow-…
//     variant 2  SKU 59103201  →  mt-201-caramel-…
//
// Two consequences run through everything below. A list cannot have holes, so
// one variant changing family means rewriting the product's whole list, which
// means every variant of that product has to be accounted for — including the
// ones the file never mentions. And the position that decides where a value
// lands is read from the **store**, never from the file: rows are matched by
// SKU and then placed by `ProductVariant.position`, so sorting or filtering the
// spreadsheet cannot misalign anything.
//
// The two writable halves have very different blast radius, which is why the
// planner separates them: assigning a family touches one variant, editing a
// family's hex touches every variant in it. The review step names both.

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
import { METAOBJECT_TYPES } from "./product-write.server";
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
  POSITION_COLUMN,
  READ_ONLY_COLUMNS,
  SHOPIFY_COLOR_COLUMN,
  SHOPIFY_COLOR_HEX_COLUMN,
  familyFieldColumn,
  familyFieldKeyOf,
  type ColorFamilyPlan,
  type ColorFamilyRowPlan,
  type FamilyEntryChange,
  type ProductFamilyChange,
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
 * `color`, `hex` or `swatch`, and may hang the assignment off the variant or
 * off the product. Guessing wrong writes to the wrong place silently, so every
 * one of those is discovered from the store's own definitions, and what was
 * found is shown on the page before anything is exported.
 */
export type ColorFamilySetup = {
  /** The colour family metaobject definition itself. */
  definition: Definition;
  /** The metafield that points at it. Where an assignment is written. */
  metafield: RichTextDefinition;
  owner: MetafieldOwner;
  /**
   * Whether the metafield is a list on the product, lining up with its
   * variants one for one. See this file's header.
   */
  positional: boolean;
  /** The family field holding a hex colour, if it has one. */
  hexFieldKey: string | null;
  /** The family's other fields, in definition order. */
  otherFieldKeys: string[];
  /** The `color-pattern` metafield, for the Shopify standard colour columns. */
  colorPattern: { definition: RichTextDefinition; owner: MetafieldOwner } | null;
  /** Every colour family definition in the store, so the page can offer a swap. */
  candidates: { type: string; name: string; entryCount: number }[];
};

/** Matches `color family`, `colour-family`, `color_families`, `ColorFamily`. */
const FAMILY_TYPE = /colou?r[-_ ]?famil(y|ies)/i;

/** A field whose stored value is a hex colour. */
const COLOR_FIELD_TYPES = ["color", "list.color"];

/** Standard definitions holding a named colour and its hex. */
const STANDARD_COLOR_TYPES = ["shopify--color", "shopify--color-pattern"];

function isColorish(type: string): boolean {
  return STANDARD_COLOR_TYPES.includes(type) || /colou?r/i.test(type);
}

/**
 * Find the family definition, the metafield pointing at it, and the route to a
 * standard colour.
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
    .filter(
      (summary) => FAMILY_TYPE.test(summary.type) || FAMILY_TYPE.test(summary.name),
    )
    .map(({ type: t, name, entryCount }) => ({ type: t, name, entryCount }));

  // An explicit pick is honoured even when its name looks nothing like a
  // colour family; the list is a shortcut, not a restriction.
  const wanted = type
    ? summaries.find((summary) => summary.type === type)
    : (summaries.find((summary) => FAMILY_TYPE.test(summary.type)) ??
      summaries.find((summary) => FAMILY_TYPE.test(summary.name)));

  if (!wanted) {
    return {
      ok: false,
      message: type
        ? `This store has no metaobject definition of type "${type}".`
        : "No colour family metaobject definition found. Create one in Settings → Custom data → Metaobjects — or import its definition CSV on the Import & export page — then define a product or variant metafield that references it.",
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

  const owned = [
    ...variantDefinitions.map((candidate) => ({
      definition: candidate,
      owner: "PRODUCTVARIANT" as const,
    })),
    ...productDefinitions.map((candidate) => ({
      definition: candidate,
      owner: "PRODUCT" as const,
    })),
  ].filter(({ definition: candidate }) =>
    METAOBJECT_TYPES.includes(candidate.type),
  );

  // A variant-owned metafield wins when a store has both: it says which family
  // a variant is in without any positional reasoning, so it is both simpler and
  // safer to write. The product-owned list is the fallback — and, in the store
  // this was built against, the only one that exists.
  const pointing = owned.filter(
    ({ definition: candidate }) =>
      candidate.metaobjectDefinitionId === definition.id,
  );
  const found =
    pointing.find(({ owner }) => owner === "PRODUCTVARIANT") ?? pointing[0];

  if (!found) {
    return {
      ok: false,
      message: `No product or variant metafield references "${definition.name}" (${definition.type}). Create one in Settings → Custom data with type "Metaobject reference", restricted to that definition — without it there is nothing to assign a family to.`,
    };
  }

  // The Shopify standard colour columns. Its metaobject definition's *type*
  // lives behind the metafield's validation id, so the index is what turns the
  // two into a comparison.
  const index = await buildMetaobjectIndex(
    admin,
    owned.map(({ definition: candidate }) => ({
      column: candidate.column,
      definition: candidate,
    })),
    { entries: false },
  );
  const pattern =
    owned.find(({ definition: candidate }) => {
      const referenced = index.typeByColumn.get(candidate.column);
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
      metafield: found.definition,
      owner: found.owner,
      positional:
        found.owner === "PRODUCT" && found.definition.type.startsWith("list."),
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
  const variant: RichTextDefinition[] = [];
  const product: RichTextDefinition[] = [];
  const add = (definition: RichTextDefinition, owner: MetafieldOwner) => {
    const list = owner === "PRODUCT" ? product : variant;
    if (!list.some((existing) => existing.column === definition.column)) {
      list.push(definition);
    }
  };

  add(setup.metafield, setup.owner);
  if (setup.colorPattern) {
    add(setup.colorPattern.definition, setup.colorPattern.owner);
  }

  return { variant, product };
}

// ---------------------------------------------------------------------------
// Reading stored values
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

/** A metafield's stored value for a variant, from whichever owner holds it. */
function storedValue(
  variant: VariantMetafields,
  definition: RichTextDefinition,
  owner: MetafieldOwner,
): string {
  const values = owner === "PRODUCT" ? variant.productValues : variant.values;
  return values[definition.column] ?? "";
}

/**
 * Each variant's 0-based place among its product's variants.
 *
 * Built from `position` rather than the order the connection returned, which
 * is not documented to follow it. Positions are 1-based and may have gaps
 * after a deletion, so they are ranked rather than used directly.
 *
 * Must be computed over **every** variant of a product. Ranking a filtered set
 * would renumber the survivors and point every lookup at the wrong list entry.
 */
export function variantOrdinals(
  variants: VariantMetafields[],
): Map<string, number> {
  const byProduct = new Map<string, VariantMetafields[]>();
  for (const variant of variants) {
    const list = byProduct.get(variant.productId);
    if (list) list.push(variant);
    else byProduct.set(variant.productId, [variant]);
  }

  const ordinals = new Map<string, number>();
  for (const list of byProduct.values()) {
    [...list]
      .sort((a, b) => a.position - b.position)
      .forEach((variant, index) => ordinals.set(variant.id, index));
  }
  return ordinals;
}

/** The gid of the family a variant is in, if any. */
function familyGid(
  setup: ColorFamilySetup,
  variant: VariantMetafields,
  ordinals: Map<string, number>,
): string | null {
  const gids = gidsIn(storedValue(variant, setup.metafield, setup.owner));
  if (!gids.length) return null;
  if (!setup.positional) return gids[0];
  return gids[ordinals.get(variant.id) ?? 0] ?? null;
}

/** The gid of the standard colour on a variant, from the product's list. */
function patternGid(
  setup: ColorFamilySetup,
  variant: VariantMetafields,
  ordinals: Map<string, number>,
): string | null {
  if (!setup.colorPattern) return null;

  const gids = gidsIn(
    storedValue(variant, setup.colorPattern.definition, setup.colorPattern.owner),
  );
  if (!gids.length) return null;

  // A product-owned list lines up with the variants; anything else is a single
  // value that belongs to the whole row.
  if (
    setup.colorPattern.owner === "PRODUCT" &&
    setup.colorPattern.definition.type.startsWith("list.")
  ) {
    return gids[ordinals.get(variant.id) ?? 0] ?? null;
  }
  return gids[0];
}

/** Every metaobject gid the first resolution pass has to fetch. */
export function collectColorIds(
  setup: ColorFamilySetup,
  variants: VariantMetafields[],
  ordinals: Map<string, number>,
): string[] {
  const ids = new Set<string>();
  for (const variant of variants) {
    const family = familyGid(setup, variant, ordinals);
    if (family) ids.add(family);
    const pattern = patternGid(setup, variant, ordinals);
    if (pattern) ids.add(pattern);
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
function hexInFields(ref: MetaobjectRef): string {
  for (const value of Object.values(ref.values)) {
    const trimmed = value.trim();
    if (HEX.test(trimmed)) return trimmed;
  }
  return "";
}

/**
 * The hex a standard colour handle spells out.
 *
 * Shopify's colour-pattern handles carry the swatch in the handle itself —
 * `100-natura-d38f8c-radiant`, `21-8d4f4a-radiant`, `00-ffffff-seventeen`. It
 * is a fallback, not the first choice: the entry's own field is authoritative
 * and this is only reached when the entry carries no hex at all, which happens
 * whenever the second resolution pass came back empty. Six hex digits are
 * required — three would match far too much of an ordinary handle.
 */
export function hexInHandle(handle: string): string {
  const segments = handle.split("-").filter(Boolean);
  for (let index = segments.length - 1; index >= 0; index--) {
    if (/^[0-9a-f]{6}$/i.test(segments[index])) return `#${segments[index]}`;
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
 * Whichever reference is followed, the search walks down to whatever entry
 * actually carries a hex — a colour pattern names the colour but stores the
 * swatch one level below it — and falls back to the handle when the entries
 * carry no hex at all.
 */
function shopifyColorOf(
  starts: string[],
  context: ColorContext,
): { name: string; hex: string } {
  const seen = new Set<string>();
  const queue = starts.filter(Boolean);
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
      if (
        !best ||
        (ref.type === "shopify--color" && best.type !== "shopify--color")
      ) {
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

  let hex = hexInFields(best);
  if (!hex) {
    for (const gid of seen) {
      const ref = context.metaobjects.get(gid);
      if (!ref || !isColorish(ref.type)) continue;
      hex = hexInFields(ref);
      if (hex) break;
    }
  }
  if (!hex) hex = hexInHandle(best.handle);

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
    POSITION_COLUMN,
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
  ordinals: Map<string, number>,
  context: ColorContext,
): string {
  const header = colorFamilyColumns(setup);

  const rows = variants.map((variant) => {
    const gid = familyGid(setup, variant, ordinals);
    const family = gid ? context.metaobjects.get(gid) : undefined;
    const name =
      family &&
      (context.refs === "name" && family.displayName?.trim()
        ? family.displayName.trim()
        : family.handle);

    const pattern = patternGid(setup, variant, ordinals);
    const color = shopifyColorOf([...(pattern ? [pattern] : []), ...(gid ? [gid] : [])], context);

    return [
      ...identityCells(variant),
      String((ordinals.get(variant.id) ?? 0) + 1),
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

/** Keep only variants that are in a family. Ordinals must already be computed. */
export function assignedOnly(
  setup: ColorFamilySetup,
  variants: VariantMetafields[],
  ordinals: Map<string, number>,
): VariantMetafields[] {
  return variants.filter(
    (variant) => familyGid(setup, variant, ordinals) != null,
  );
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

export type ColorFamilyPlanContext = {
  index: MetaobjectIndex;
  /** The store's entries as they are now, by handle, for the field diff. */
  entries: Map<string, FamilyEntry>;
  /**
   * Whether a blank `color family` cell removes the variant from its family.
   *
   * Off — the rule the rest of this app is built on — so a half-filled
   * spreadsheet cannot unassign a catalogue. On, every clear still shows in the
   * review step as a real `Peach Tones → —` diff first. With a positional list
   * a *partial* clear is refused outright: see `planProductLists`.
   */
  clearEmpty: boolean;
};

/**
 * What one row wants its variant's family to be.
 *
 * `undefined` means the row said nothing — no column, or a blank cell with
 * clearing off — and the stored value stands. `null` means "no family".
 */
type Wanted = { handle: string } | null | undefined;

export function planColorFamilyImport(
  setup: ColorFamilySetup,
  records: Record<string, string>[],
  variants: VariantMetafields[],
  context: ColorFamilyPlanContext,
): ColorFamilyPlan {
  const type = setup.definition.type;
  const ordinals = variantOrdinals(variants);

  const fieldColumns = new Map<string, string>();
  if (setup.hexFieldKey) fieldColumns.set(FAMILY_HEX_COLUMN, setup.hexFieldKey);
  for (const key of setup.otherFieldKeys) {
    fieldColumns.set(familyFieldColumn(key), key);
  }

  // Inverted once, not per row: every row renders the family it is moving away
  // from, and rebuilding this inside that loop would walk the whole entry index
  // once per row.
  const handleById = new Map<string, string>();
  for (const [key, id] of context.index.idByHandle) {
    if (key.startsWith(`${type}:`)) {
      handleById.set(id, key.slice(type.length + 1));
    }
  }

  const bySku = new Map<string, VariantMetafields[]>();
  const byTitle = new Map<string, VariantMetafields[]>();
  const byOptions = new Map<string, VariantMetafields[]>();
  const push = <K,>(
    map: Map<K, VariantMetafields[]>,
    key: K,
    variant: VariantMetafields,
  ) => {
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
  /** variantId → what its row wants, for the product list rebuild. */
  const wantedByVariant = new Map<string, { wanted: Wanted; rowNumber: number }>();
  // family handle → column → value → the rows asking for it.
  const familyCells = new Map<
    string,
    Map<
      string,
      Map<string, { value: string; change: string; rowNumbers: number[] }>
    >
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
      matches = byTitle.get(
        `${handle.toLowerCase()}#${variantTitle.toLowerCase()}`,
      );
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
    } else if (
      fallbackHandle &&
      context.index.idByHandle.has(`${type}:${fallbackHandle}`)
    ) {
      target = fallbackHandle;
    }

    // --- What the row wants for this variant -------------------------------
    const storedGid = familyGid(setup, variant, ordinals);
    const storedHandle = storedGid ? (handleById.get(storedGid) ?? "") : "";

    let wanted: Wanted;
    let assign: ColorFamilyRowPlan["assign"];
    if (FAMILY_COLUMN in record && !errors.length) {
      if (cell && target) {
        wanted = { handle: target };
        if (target !== storedHandle) {
          const gid = context.index.idByHandle.get(`${type}:${target}`)!;
          assign = { kind: "write", handle: target, value: gid };
          changes.push(`${FAMILY_COLUMN}: ${storedHandle || "—"} → ${target}`);
        }
      } else if (!cell) {
        if (context.clearEmpty) {
          wanted = null;
          if (storedGid) {
            assign = { kind: "clear" };
            changes.push(`${FAMILY_COLUMN}: ${storedHandle || "—"} → —`);
          }
        }
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

        const value = (record[column] ?? "").trim();
        const stored = (entry?.values[key] ?? "").trim();
        // A blank field cell is always "leave it alone". `clearEmpty` is about
        // the variant's assignment; blanking a shared entry's field from a
        // variant row is not something a spreadsheet should be able to do by
        // omission.
        if (!value || value === stored) continue;

        const columns =
          familyCells.get(target) ??
          new Map<
            string,
            Map<string, { value: string; change: string; rowNumbers: number[] }>
          >();
        familyCells.set(target, columns);
        const slots =
          columns.get(column) ??
          new Map<string, { value: string; change: string; rowNumbers: number[] }>();
        columns.set(column, slots);

        const slot = slots.get(value);
        if (slot) slot.rowNumbers.push(rowNumber);
        else {
          slots.set(value, {
            value,
            change: `${column}: ${shorten(stored) || "—"} → ${shorten(value)}`,
            rowNumbers: [rowNumber],
          });
        }
      }
    }

    if (errors.length) {
      fail(errors.join(" "));
      return;
    }

    wantedByVariant.set(variant.id, { wanted, rowNumber });
    rows.push({
      rowNumber,
      label,
      sku,
      variantId: variant.id,
      productId: variant.productId,
      action: assign ? "update" : "unchanged",
      changes,
      ...(assign ? { assign } : {}),
    });
  });

  // --- Fold the assignments into product writes -----------------------------
  const { products, errors: productErrors } =
    setup.owner === "PRODUCT"
      ? planProductLists(setup, variants, ordinals, wantedByVariant, context, handleById)
      : { products: [] as ProductFamilyChange[], errors: new Map<number, string[]>() };

  // --- Reconcile the family entry edits -------------------------------------
  const families: FamilyEntryChange[] = [];
  const conflicted = new Map<number, string[]>(productErrors);
  const addError = (rowNumber: number, message: string) => {
    const list = conflicted.get(rowNumber) ?? [];
    list.push(message);
    conflicted.set(rowNumber, list);
  };

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
          for (const rowNumber of slot.rowNumbers) addError(rowNumber, message);
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
  // A product list built partly from rows that turned out to be errors would
  // write values the merchant was never shown as valid.
  const liveProducts = products.filter((change) =>
    change.rowNumbers.every((rowNumber) => liveRows.has(rowNumber)),
  );

  const touched = new Set([
    ...liveFamilies.flatMap((change) => change.rowNumbers),
    ...liveProducts.flatMap((change) => change.rowNumbers),
  ]);
  const counts = { update: 0, unchanged: 0, error: 0 };
  for (const row of rows) {
    // A row whose only change is to the family entry, or to its product's
    // list, still changed something.
    if (row.action === "unchanged" && touched.has(row.rowNumber)) {
      row.action = "update";
    }
    counts[row.action]++;
  }

  return {
    type,
    column: setup.metafield.column,
    owner: setup.owner === "PRODUCT" ? "product" : "variant",
    positional: setup.positional,
    rows,
    products: liveProducts,
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

/**
 * Rebuild each product's colour-family metafield from its variants' rows.
 *
 * A positional list cannot have holes: entry N *is* variant N, so a list
 * missing one variant's family silently shifts every later variant onto the
 * wrong colour. Every variant of the product therefore has to end up with a
 * family — from its row, or from the value already stored at its place — and a
 * product where some would and some would not is refused outright rather than
 * written in a shape that cannot be read back.
 *
 * Clearing is all-or-nothing for the same reason: emptying the whole list
 * deletes the metafield, emptying part of it is the gap this refuses.
 */
function planProductLists(
  setup: ColorFamilySetup,
  variants: VariantMetafields[],
  ordinals: Map<string, number>,
  wantedByVariant: Map<string, { wanted: Wanted; rowNumber: number }>,
  context: ColorFamilyPlanContext,
  handleById: Map<string, string>,
): { products: ProductFamilyChange[]; errors: Map<number, string[]> } {
  const type = setup.definition.type;
  const products: ProductFamilyChange[] = [];
  const errors = new Map<number, string[]>();

  const byProduct = new Map<string, VariantMetafields[]>();
  for (const variant of variants) {
    const list = byProduct.get(variant.productId);
    if (list) list.push(variant);
    else byProduct.set(variant.productId, [variant]);
  }

  for (const [productId, list] of byProduct) {
    const ordered = [...list].sort((a, b) => a.position - b.position);
    const rowNumbers = ordered
      .map((variant) => wantedByVariant.get(variant.id)?.rowNumber)
      .filter((rowNumber): rowNumber is number => rowNumber != null);
    if (!rowNumbers.length) continue;

    const stored = gidsIn(
      storedValue(ordered[0], setup.metafield, setup.owner),
    );
    const label = ordered[0].productHandle;

    // A non-positional product metafield is one value for the whole product.
    // Rows that disagree are an error on all of them — the same rule the
    // variant metafields page applies to `product.` columns.
    if (!setup.positional) {
      const asked = new Map<string, number[]>();
      for (const variant of ordered) {
        const entry = wantedByVariant.get(variant.id);
        if (!entry || entry.wanted === undefined) continue;
        const key = entry.wanted === null ? "" : entry.wanted.handle;
        const rows = asked.get(key) ?? [];
        rows.push(entry.rowNumber);
        asked.set(key, rows);
      }
      if (asked.size === 0) continue;
      if (asked.size > 1) {
        const message = `Rows disagree about "${FAMILY_COLUMN}" for ${label}: ${[...asked]
          .map(([handle, rows]) => `row(s) ${rows.join(", ")} → ${handle || "—"}`)
          .join("; ")}. This metafield holds one family for the whole product.`;
        for (const rows of asked.values()) {
          for (const rowNumber of rows) {
            errors.set(rowNumber, [...(errors.get(rowNumber) ?? []), message]);
          }
        }
        continue;
      }

      const [[handle, rows]] = [...asked];
      const storedHandle = stored[0] ? (handleById.get(stored[0]) ?? "") : "";
      if (handle === storedHandle) continue;

      products.push({
        productId,
        label,
        rowNumbers: rows,
        value: handle
          ? valueFor(setup, [context.index.idByHandle.get(`${type}:${handle}`)!])
          : null,
        changes: [`${FAMILY_COLUMN}: ${storedHandle || "—"} → ${handle || "—"}`],
      });
      continue;
    }

    // --- Positional ---------------------------------------------------------
    const desired: (string | null)[] = [];
    const changes: string[] = [];
    let changed = false;

    ordered.forEach((variant, index) => {
      const at = ordinals.get(variant.id) ?? index;
      // A list shorter than the variant count leaves the tail unset, so this
      // genuinely can be absent however `stored` is typed.
      const current: string | null = stored[at] ?? null;
      const entry = wantedByVariant.get(variant.id);

      let next: string | null = current;
      if (entry && entry.wanted !== undefined) {
        next = entry.wanted
          ? (context.index.idByHandle.get(`${type}:${entry.wanted.handle}`) ?? null)
          : null;
      }

      if (next !== current) {
        changed = true;
        changes.push(
          `${variant.title}: ${(current && handleById.get(current)) || "—"} → ${
            (next && handleById.get(next)) || "—"
          }`,
        );
      }
      desired[at] = next;
    });

    if (!changed) continue;

    const filled = desired.filter((gid) => gid != null);
    if (filled.length > 0 && filled.length < ordered.length) {
      const missing = ordered
        .filter((variant) => desired[ordinals.get(variant.id) ?? 0] == null)
        .map((variant) => variant.title);
      const message = `"${setup.metafield.column}" on ${label} is a positional list — entry N belongs to variant N — so every one of its ${ordered.length} variants needs a family. ${missing.length} would have none (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}). Fill them in, or clear the whole product.`;
      for (const rowNumber of rowNumbers) {
        errors.set(rowNumber, [...(errors.get(rowNumber) ?? []), message]);
      }
      continue;
    }

    products.push({
      productId,
      label,
      rowNumbers,
      value: filled.length ? valueFor(setup, filled as string[]) : null,
      changes,
    });
  }

  return { products, errors };
}

/** The stored shape for a set of gids: a JSON array, or a bare gid. */
function valueFor(setup: ColorFamilySetup, gids: string[]): string {
  return setup.metafield.type.startsWith("list.")
    ? JSON.stringify(gids)
    : gids[0];
}
