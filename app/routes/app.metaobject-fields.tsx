import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import {
  createDefinition,
  listDefinitions,
} from "../lib/metaobjects.server";
import {
  FIELD_TYPE_GROUPS,
  isValidFieldType,
  planDefinitionForm,
  suggestKey,
  type DefinitionDraft,
} from "../lib/metaobject-fields";
import styles from "./app._index/styles.module.css";

// Create metaobject definitions — the schema — one field at a time.
//
// The import page on `/app` can already create definitions, but only from a
// definition CSV. That is the right tool when another system produced the
// schema; it is the wrong one when a merchant knows they need a "claim" object
// with four fields and has no file to feed it. This page is that second case.
//
// Definitions are additive: `metaobjectDefinitionCreate` refuses a type that
// already exists rather than overwriting it, so there is nothing here to
// destroy and no plan/apply round trip. The existing definitions are listed
// above the form for the same reason a plan step exists elsewhere — so the
// merchant can see what is already there before adding to it.

type ActionData =
  | { step: "created"; type: string; name: string; fields: number }
  | { step: "error"; message: string; errors: string[] };

/** Fields per definition. Shopify's own ceiling, quoted back as the limit. */
const MAX_FIELDS = 40;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  return { definitions: await listDefinitions(admin) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  try {
    const draft: DefinitionDraft = {
      type: String(formData.get("type") ?? ""),
      name: String(formData.get("name") ?? ""),
      description: String(formData.get("description") ?? ""),
      displayNameKey: String(formData.get("displayNameKey") ?? ""),
      fields: formData.getAll("fieldKey").map((key, index) => ({
        key: String(key),
        name: String(formData.getAll("fieldName")[index] ?? ""),
        type: String(formData.getAll("fieldType")[index] ?? ""),
        // An unchecked checkbox posts nothing, so required-ness cannot be read
        // positionally from `getAll`. Each row posts its own indexed name.
        required: formData.get(`fieldRequired.${index}`) === "on",
      })),
    };

    const plan = planDefinitionForm(draft, { maxFields: MAX_FIELDS });
    if (!plan.ok) {
      return { step: "error", message: plan.message, errors: plan.errors } as const;
    }

    const result = await createDefinition(admin, plan.definition);
    if (!result.ok) {
      return {
        step: "error",
        message: `Shopify refused the "${plan.definition.type}" definition.`,
        errors: result.errors,
      } as const;
    }

    return {
      step: "created",
      type: plan.definition.type,
      name: plan.definition.name,
      fields: plan.definition.fieldDefinitions.length,
    } as const;
  } catch (error) {
    return {
      step: "error",
      message: error instanceof Error ? error.message : String(error),
      errors: [],
    } as const;
  }
};

type FieldRow = {
  key: string;
  name: string;
  type: string;
  required: boolean;
};

const BLANK_ROW: FieldRow = {
  key: "",
  name: "",
  type: "single_line_text_field",
  required: false,
};

export default function MetaobjectFieldsPage() {
  const { definitions } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const busy = fetcher.state !== "idle";
  const data = fetcher.data;

  const [rows, setRows] = useState<FieldRow[]>([{ ...BLANK_ROW }]);

  const update = (index: number, patch: Partial<FieldRow>) =>
    setRows((current) =>
      current.map((row, position) =>
        position === index ? { ...row, ...patch } : row,
      ),
    );

  const addRow = () =>
    setRows((current) =>
      current.length >= MAX_FIELDS ? current : [...current, { ...BLANK_ROW }],
    );

  const removeRow = (index: number) =>
    setRows((current) =>
      current.length === 1
        ? current
        : current.filter((_, position) => position !== index),
    );

  // The display name is picked from the fields the merchant has actually
  // named, so it cannot point at a key that does not exist.
  const namedKeys = rows
    .map((row) => row.key.trim())
    .filter((key) => key.length > 0);

  return (
    <s-page heading="Metaobject fields">
      <s-section heading="Your metaobject definitions">
        {definitions.length === 0 ? (
          <s-paragraph>
            This store has no metaobject definitions yet. Create the first one
            below.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              {definitions.length} definition(s) already exist. Creating one
              that is already here reports an error rather than overwriting it.
            </s-paragraph>
            <div className={styles.tableScroll}>
              <s-table>
                <s-table-header-row>
                  <s-table-header>Name</s-table-header>
                  <s-table-header>Type</s-table-header>
                  <s-table-header>Entries</s-table-header>
                  <s-table-header>Fields</s-table-header>
                  <s-table-header>Required</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {definitions.map((definition) => (
                    <s-table-row key={definition.id}>
                      <s-table-cell>{definition.name}</s-table-cell>
                      <s-table-cell>{definition.type}</s-table-cell>
                      <s-table-cell>{definition.entryCount}</s-table-cell>
                      <s-table-cell>
                        {definition.fieldKeys.join(", ") || "—"}
                      </s-table-cell>
                      {/* An import file with no column for a required field
                          fails every new entry, and nothing else in the admin
                          shows this beside the type you import into. */}
                      <s-table-cell>
                        {definition.requiredFieldKeys.length ? (
                          <s-badge tone="warning">
                            {definition.requiredFieldKeys.join(", ")}
                          </s-badge>
                        ) : (
                          "—"
                        )}
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            </div>
          </s-stack>
        )}
      </s-section>

      <s-section heading="Create a definition">
        <fetcher.Form method="post">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              A metaobject is a reusable record with fields of its own — a
              claim badge, a size chart, an ingredient. To add a single value to
              a product instead, use a metafield.
            </s-paragraph>

            <s-text-field
              label="Type"
              name="type"
              placeholder="claim"
              details="Lowercase identifier, used in the API. Cannot start with shopify-- or app--, which are reserved."
              required
            />
            <s-text-field
              label="Name"
              name="name"
              placeholder="Claim"
              details="How it appears in the admin."
              required
            />
            <s-text-field
              label="Description"
              name="description"
              placeholder="A product claim badge, e.g. Vegan."
            />

            <s-heading>Fields</s-heading>
            <s-paragraph>
              Up to {MAX_FIELDS} per definition.
            </s-paragraph>

            <div className={styles.tableScroll}>
              <s-table>
                <s-table-header-row>
                  <s-table-header>Name</s-table-header>
                  <s-table-header>Key</s-table-header>
                  <s-table-header>Type</s-table-header>
                  <s-table-header>Required</s-table-header>
                  <s-table-header />
                </s-table-header-row>
                <s-table-body>
                  {rows.map((row, index) => (
                    <s-table-row key={index}>
                      <s-table-cell>
                        <s-text-field
                          label="Field name"
                          labelAccessibilityVisibility="exclusive"
                          name="fieldName"
                          value={row.name}
                          placeholder="e.g. Usage"
                          onChange={(event: Event) => {
                            const name = (event.target as HTMLInputElement)
                              .value;
                            // The key follows the name until the merchant
                            // edits it, which is the common case and saves
                            // them typing the same word twice.
                            update(index, {
                              name,
                              ...(row.key === "" || row.key === suggestKey(row.name)
                                ? { key: suggestKey(name) }
                                : {}),
                            });
                          }}
                        />
                      </s-table-cell>
                      <s-table-cell>
                        <s-text-field
                          label="Field key"
                          labelAccessibilityVisibility="exclusive"
                          name="fieldKey"
                          value={row.key}
                          placeholder="e.g. usage"
                          onChange={(event: Event) =>
                            update(index, {
                              key: (event.target as HTMLInputElement).value,
                            })
                          }
                        />
                      </s-table-cell>
                      <s-table-cell>
                        <s-select
                          label="Field type"
                          labelAccessibilityVisibility="exclusive"
                          name="fieldType"
                          value={row.type}
                          onChange={(event: Event) =>
                            update(index, {
                              type: (event.target as HTMLSelectElement).value,
                            })
                          }
                        >
                          {FIELD_TYPE_GROUPS.map((group) => (
                            <s-option-group key={group.label} label={group.label}>
                              {group.types.map((type) => (
                                <s-option key={type.value} value={type.value}>
                                  {type.label}
                                </s-option>
                              ))}
                            </s-option-group>
                          ))}
                        </s-select>
                      </s-table-cell>
                      <s-table-cell>
                        <s-checkbox
                          label="Required"
                          labelAccessibilityVisibility="exclusive"
                          name={`fieldRequired.${index}`}
                          {...(row.required ? { checked: true } : {})}
                          onChange={(event: Event) =>
                            update(index, {
                              required: (event.target as HTMLInputElement)
                                .checked,
                            })
                          }
                        />
                      </s-table-cell>
                      <s-table-cell>
                        <s-button
                          variant="tertiary"
                          {...(rows.length === 1 ? { disabled: true } : {})}
                          onClick={() => removeRow(index)}
                        >
                          Remove
                        </s-button>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            </div>

            <div className={styles.actions}>
              <s-button
                onClick={addRow}
                {...(rows.length >= MAX_FIELDS ? { disabled: true } : {})}
              >
                Add field
              </s-button>
            </div>

            <s-select
              label="Display name field"
              name="displayNameKey"
              details="Which field names an entry in the admin. Shopify derives the display name from it, so it cannot be written directly."
            >
              <s-option value="">First field</s-option>
              {namedKeys.map((key) => (
                <s-option key={key} value={key}>
                  {key}
                </s-option>
              ))}
            </s-select>

            <div className={styles.actions}>
              <s-button
                type="submit"
                variant="primary"
                {...(busy ? { loading: true } : {})}
              >
                Create definition
              </s-button>
            </div>
          </s-stack>
        </fetcher.Form>
      </s-section>

      {data?.step === "error" && (
        <s-section heading="Could not create that definition">
          <s-stack direction="block" gap="base">
            <s-banner tone="critical">
              <s-paragraph>{data.message}</s-paragraph>
            </s-banner>
            {data.errors.length > 0 && (
              <s-unordered-list>
                {data.errors.map((error) => (
                  <s-list-item key={error}>{error}</s-list-item>
                ))}
              </s-unordered-list>
            )}
          </s-stack>
        </s-section>
      )}

      {data?.step === "created" && (
        <s-section heading="Definition created">
          <s-banner tone="success">
            <s-paragraph>
              {data.name} ({data.type}) created with {data.fields} field(s).
              Import its entries from the Import &amp; export page — pick{" "}
              {data.type} as the type.
            </s-paragraph>
          </s-banner>
        </s-section>
      )}
    </s-page>
  );
}

/** Field types are checked on the server too; the select is only the UI half. */
export { isValidFieldType };
