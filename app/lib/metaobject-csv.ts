// The CSV shapes exported and imported by this app, plus the dry-run planner.
//
// Export and import share this module on purpose: the column layout is written
// once, so a file this app produced is always a file it can read back.

import { toCsv } from "./csv";
import type { Definition, Entry } from "./metaobjects.server";

/**
 * Column holding the entry handle. It is the upsert key — the handle is what
 * decides whether a row updates an existing entry or creates a new one.
 */
export const HANDLE_COLUMN = "handle";

/**
 * Shopify derives the display name from whichever field the definition names in
 * `displayNameKey`, so it cannot be written directly. It is exported for human
 * readability and ignored on import.
 */
export const DISPLAY_NAME_COLUMN = "display_name";

/** Columns of the definition CSV, one row per field definition. */
export const DEFINITION_COLUMNS = [
  "type",
  "name",
  "description",
  "display_name_key",
  "field_key",
  "field_name",
  "field_description",
  "field_type",
  "field_required",
  "field_validations",
] as const;

/** A definition CSV is recognised by a column an entries CSV never has. */
export function isDefinitionCsv(headers: string[]): boolean {
  return headers.includes("field_key") && headers.includes("field_type");
}

export function entriesToCsv(definition: Definition, entries: Entry[]): string {
  const fieldKeys = definition.fieldDefinitions.map((field) => field.key);
  const header = [HANDLE_COLUMN, DISPLAY_NAME_COLUMN, ...fieldKeys];

  const rows = entries.map((entry) => [
    entry.handle,
    entry.displayName ?? "",
    ...fieldKeys.map((key) => entry.values[key] ?? ""),
  ]);

  return toCsv([header, ...rows]);
}

export function definitionToCsv(definition: Definition): string {
  const rows = definition.fieldDefinitions.map((field) => [
    definition.type,
    definition.name,
    definition.description ?? "",
    definition.displayNameKey ?? "",
    field.key,
    field.name,
    field.description ?? "",
    field.type,
    String(field.required),
    // Validations vary in shape per field type (min, max, regex, choices...).
    // JSON keeps them in one cell without inventing a second escaping scheme.
    field.validations.length ? JSON.stringify(field.validations) : "",
  ]);

  return toCsv([[...DEFINITION_COLUMNS], ...rows]);
}

/** Filename that says which store object the file came from. */
export function exportFilename(type: string, kind: "entries" | "definition") {
  const date = new Date().toISOString().slice(0, 10);
  const safeType = type.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${safeType}-${kind}-${date}.csv`;
}

export type RowPlan = {
  rowNumber: number;
  handle: string;
  action: "create" | "update" | "unchanged" | "error";
  /** Field keys whose value differs from what is in the store. */
  changedFields: string[];
  message?: string;
  values: Record<string, string>;
};

export type ImportPlan = {
  type: string;
  rows: RowPlan[];
  counts: { create: number; update: number; unchanged: number; error: number };
  /** Columns in the file that the definition has no field for. */
  unknownColumns: string[];
  /** Field keys the definition requires that the file has no column for. */
  missingRequiredColumns: string[];
};

/**
 * Compare a parsed CSV against the store and decide what each row would do,
 * without writing anything.
 *
 * Unchanged rows are identified so a re-import of an unedited export reports
 * "nothing to do" instead of rewriting every entry, which would otherwise
 * churn `updatedAt` on the whole set and burn the mutation rate limit.
 */
export function planEntryImport(
  definition: Definition,
  records: Record<string, string>[],
  existing: Entry[],
): ImportPlan {
  const fieldKeys = definition.fieldDefinitions.map((field) => field.key);
  const knownKeys = new Set(fieldKeys);
  const byHandle = new Map(existing.map((entry) => [entry.handle, entry]));

  const presentColumns = Object.keys(records[0] ?? {});
  const unknownColumns = presentColumns.filter(
    (column) =>
      column !== HANDLE_COLUMN &&
      column !== DISPLAY_NAME_COLUMN &&
      !knownKeys.has(column),
  );
  const missingRequiredColumns = definition.fieldDefinitions
    .filter((field) => field.required && !presentColumns.includes(field.key))
    .map((field) => field.key);

  // Only columns that map to a real field are written. An unknown column is
  // reported above and then ignored, so a stray spreadsheet column cannot fail
  // every row.
  const writableColumns = presentColumns.filter((column) =>
    knownKeys.has(column),
  );

  const seenHandles = new Set<string>();
  const rows: RowPlan[] = records.map((record, index) => {
    // +2: one for the header row, one because spreadsheets number from 1.
    const rowNumber = index + 2;
    const handle = (record[HANDLE_COLUMN] ?? "").trim();

    const values: Record<string, string> = {};
    for (const column of writableColumns) values[column] = record[column] ?? "";

    const base = { rowNumber, handle, values, changedFields: [] as string[] };

    if (!handle) {
      return {
        ...base,
        action: "error" as const,
        message: `Missing ${HANDLE_COLUMN}. Every row needs one — it decides which entry is written.`,
      };
    }

    if (seenHandles.has(handle)) {
      return {
        ...base,
        action: "error" as const,
        message: `Duplicate handle "${handle}" — an earlier row already writes it, so one would silently overwrite the other.`,
      };
    }
    seenHandles.add(handle);

    const missingRequired = definition.fieldDefinitions
      .filter(
        (field) =>
          field.required &&
          writableColumns.includes(field.key) &&
          values[field.key].trim() === "",
      )
      .map((field) => field.key);

    if (missingRequired.length) {
      return {
        ...base,
        action: "error" as const,
        message: `Required field(s) empty: ${missingRequired.join(", ")}.`,
      };
    }

    const current = byHandle.get(handle);
    if (!current) return { ...base, action: "create" as const };

    const changedFields = writableColumns.filter(
      (column) => (current.values[column] ?? "") !== values[column],
    );

    return changedFields.length
      ? { ...base, action: "update" as const, changedFields }
      : { ...base, action: "unchanged" as const };
  });

  const counts = { create: 0, update: 0, unchanged: 0, error: 0 };
  for (const row of rows) counts[row.action]++;

  return {
    type: definition.type,
    rows,
    counts,
    unknownColumns,
    missingRequiredColumns,
  };
}

/** Group definition-CSV rows into one create input per metaobject type. */
export function planDefinitionImport(records: Record<string, string>[]) {
  const byType = new Map<
    string,
    {
      type: string;
      name: string;
      description: string | null;
      displayNameKey: string | null;
      fieldDefinitions: {
        key: string;
        name: string;
        description: string | null;
        required: boolean;
        type: string;
        validations: { name: string; value: string | null }[];
      }[];
    }
  >();

  records.forEach((record, index) => {
    const type = (record.type ?? "").trim();
    const fieldKey = (record.field_key ?? "").trim();
    if (!type || !fieldKey) {
      throw new Error(
        `Row ${index + 2}: both "type" and "field_key" are required in a definition CSV.`,
      );
    }

    let definition = byType.get(type);
    if (!definition) {
      definition = {
        type,
        name: record.name?.trim() || type,
        description: record.description?.trim() || null,
        displayNameKey: record.display_name_key?.trim() || null,
        fieldDefinitions: [],
      };
      byType.set(type, definition);
    }

    let validations: { name: string; value: string | null }[] = [];
    if (record.field_validations?.trim()) {
      try {
        validations = JSON.parse(record.field_validations);
      } catch {
        throw new Error(
          `Row ${index + 2}: field_validations is not valid JSON.`,
        );
      }
    }

    definition.fieldDefinitions.push({
      key: fieldKey,
      name: record.field_name?.trim() || fieldKey,
      description: record.field_description?.trim() || null,
      required: record.field_required?.trim().toLowerCase() === "true",
      type: record.field_type?.trim(),
      validations,
    });
  });

  return [...byType.values()];
}
