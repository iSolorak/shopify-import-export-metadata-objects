// Validating a metaobject definition built by hand, before it is sent.
//
// Pure, like the other parsing modules here, so the rules can be reasoned about
// without a store attached. Everything it rejects, Shopify would reject too —
// the point is to say so in a sentence that names the field, rather than
// forwarding a `userErrors` entry that says "Value is invalid".

/**
 * The field types offered when building a definition, grouped the way the
 * admin groups them.
 *
 * Deliberately a curated subset of what `metafieldDefinitionTypes` returns.
 * Every type here is one a merchant can fill in from a CSV import on the next
 * page; the ones left out (`dimension`, `volume`, `weight`, `rating`, `money`)
 * store a JSON object with a unit or a scale, and offering them here would
 * invite a definition whose entries this app cannot then import.
 */
export const FIELD_TYPE_GROUPS = [
  {
    label: "Text",
    types: [
      { value: "single_line_text_field", label: "Single line text" },
      { value: "multi_line_text_field", label: "Multi-line text" },
      { value: "rich_text_field", label: "Rich text" },
      { value: "url", label: "URL" },
    ],
  },
  {
    label: "Number",
    types: [
      { value: "number_integer", label: "Integer" },
      { value: "number_decimal", label: "Decimal" },
    ],
  },
  {
    label: "Other",
    types: [
      { value: "boolean", label: "True or false" },
      { value: "date", label: "Date" },
      { value: "date_time", label: "Date and time" },
      { value: "color", label: "Colour" },
      { value: "json", label: "JSON" },
    ],
  },
  {
    label: "Reference",
    types: [
      { value: "file_reference", label: "File" },
      { value: "list.file_reference", label: "File (list)" },
      { value: "product_reference", label: "Product" },
      { value: "list.product_reference", label: "Product (list)" },
      { value: "metaobject_reference", label: "Metaobject" },
      { value: "list.metaobject_reference", label: "Metaobject (list)" },
    ],
  },
] as const;

const VALID_FIELD_TYPES = new Set(
  FIELD_TYPE_GROUPS.flatMap((group) => group.types.map((type) => type.value)),
);

export function isValidFieldType(type: string): boolean {
  return VALID_FIELD_TYPES.has(type as never);
}

/**
 * Prefixes Shopify keeps for itself.
 *
 * `shopify--` is the standard-definition namespace — `shopify--color-pattern`
 * is one, and the platform owns its structure, so `metaobjectDefinitionCreate`
 * refuses it. A merchant enables those in the admin instead. Saying so here is
 * worth a great deal, because the API's own error for this does not mention
 * that the definition already exists as a standard one.
 */
const RESERVED_TYPE_PREFIXES = ["shopify--", "app--", "$app:"];

/** An identifier Shopify accepts for a type or a field key. */
const IDENTIFIER = /^[a-z][a-z0-9_-]*$/;

/** Turn a field's human name into a usable key. */
export function suggestKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

export type FieldDraft = {
  key: string;
  name: string;
  type: string;
  required: boolean;
};

export type DefinitionDraft = {
  type: string;
  name: string;
  description: string;
  displayNameKey: string;
  fields: FieldDraft[];
};

export type DefinitionPlan =
  | {
      ok: true;
      definition: {
        type: string;
        name: string;
        description: string | null;
        displayNameKey: string | null;
        fieldDefinitions: {
          key: string;
          name: string;
          required: boolean;
          type: string;
          validations: { name: string; value: string | null }[];
        }[];
      };
    }
  | { ok: false; message: string; errors: string[] };

/**
 * Check a hand-built definition and shape it for `createDefinition`.
 *
 * Every error is collected rather than thrown on the first one: a merchant who
 * mistyped two field keys should be told about both, not sent round the loop
 * twice.
 */
export function planDefinitionForm(
  draft: DefinitionDraft,
  options: { maxFields: number },
): DefinitionPlan {
  const errors: string[] = [];

  const type = draft.type.trim().toLowerCase();
  const name = draft.name.trim();

  if (!type) {
    errors.push("Type is required — it is how the API addresses this object.");
  } else if (!IDENTIFIER.test(type)) {
    errors.push(
      `"${type}" is not a valid type. Use lowercase letters, digits, underscores and hyphens, starting with a letter.`,
    );
  } else if (RESERVED_TYPE_PREFIXES.some((prefix) => type.startsWith(prefix))) {
    errors.push(
      `"${type}" uses a prefix Shopify reserves. A standard definition like shopify--color-pattern is enabled in the admin rather than created here.`,
    );
  }

  if (!name) errors.push("Name is required.");

  // Blank rows are dropped rather than rejected: the form starts with one and
  // adding a row you then leave empty is a normal thing to do.
  const fields = draft.fields.filter(
    (field) => field.key.trim() || field.name.trim(),
  );

  if (!fields.length) {
    errors.push("A definition needs at least one field.");
  }
  if (fields.length > options.maxFields) {
    errors.push(
      `${fields.length} fields — Shopify allows at most ${options.maxFields} per definition.`,
    );
  }

  const seen = new Set<string>();
  const fieldDefinitions = fields.map((field, index) => {
    const key = (field.key.trim() || suggestKey(field.name)).toLowerCase();
    const label = field.name.trim() || key;
    const position = `Field ${index + 1}`;

    if (!key) {
      errors.push(`${position}: needs a key.`);
    } else if (!IDENTIFIER.test(key)) {
      errors.push(
        `${position}: "${key}" is not a valid key. Use lowercase letters, digits and underscores, starting with a letter.`,
      );
    } else if (seen.has(key)) {
      errors.push(
        `${position}: the key "${key}" is used twice, so one field would silently replace the other.`,
      );
    }
    seen.add(key);

    if (!isValidFieldType(field.type)) {
      errors.push(`${position}: "${field.type}" is not a field type.`);
    }

    return {
      key,
      name: label,
      required: field.required,
      type: field.type,
      validations: [] as { name: string; value: string | null }[],
    };
  });

  // The display name has to be one of this definition's own fields; Shopify
  // derives the entry's label from it, and a key that is not there leaves every
  // entry unnamed.
  const displayNameKey = draft.displayNameKey.trim();
  if (displayNameKey && !seen.has(displayNameKey)) {
    errors.push(
      `The display name field "${displayNameKey}" is not one of the fields above.`,
    );
  }

  if (errors.length) {
    return {
      ok: false,
      message:
        errors.length === 1
          ? "That definition has a problem."
          : `That definition has ${errors.length} problems.`,
      errors,
    };
  }

  return {
    ok: true,
    definition: {
      type,
      name,
      description: draft.description.trim() || null,
      // Falling back to the first field matches what the admin does, and means
      // an entry always has something readable to be called.
      displayNameKey: displayNameKey || fieldDefinitions[0].key,
      fieldDefinitions,
    },
  };
}
