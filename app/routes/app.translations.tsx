import { useEffect, useRef } from "react";
import type { ActionFunctionArgs } from "react-router";
import { useFetcher } from "react-router";

import { authenticate } from "../shopify.server";
import { parseCsv } from "../lib/csv";
import {
  PRODUCT_FIELDS,
  buildTranslationCsv,
  parseSource,
  parseTranslations,
  type ColumnMapping,
  type ParsedTranslations,
  type TranslationTarget,
} from "../lib/translation-csv";
import {
  RICH_TEXT_TYPE,
  listProductMetafieldDefinitions,
  resolveMetafieldOwners,
} from "../lib/translation-metafields.server";
import { saveCsv } from "../lib/download-csv";
import styles from "./app._index/styles.module.css";

// Build a Shopify translations import file from a shop's own product export.
//
// Both files are uploaded on every submit rather than the first one being
// echoed back in a hidden field the way the other import pages do it. Those
// pages carry a few hundred kilobytes; these two are a couple of megabytes
// together, and re-posting them through the browser on each step is pure waste
// when the file inputs are still sitting in the form and can just be sent
// again.
//
// Which step is running is inferred from the form rather than declared: a
// submit carrying `map:` fields is a build, anything else is a first read. That
// avoids having to mutate a hidden intent field from a click handler, where the
// state update loses the race against the native form submit.
const MAPPING_PREFIX = "map:";

type ActionData =
  | ({ step: "inspect" } & Counts)
  | ({
      step: "built";
      csv: string;
      filled: number;
      matched: number;
      unmatched: string[];
      ambiguous: string[];
      missingFields: string[];
      /** Metafield rows the store could not account for, if any were mapped. */
      unresolvedMetafields: number;
    } & Counts)
  | { step: "error"; message: string };

/**
 * What both non-error steps carry, so the mapping section keeps its shape once
 * the file has been built rather than losing its counts and column table.
 */
type Counts = {
  columns: string[];
  mapping: ColumnMapping;
  /** Product fields plus this store's metafields, for the dropdown. */
  targets: TranslationTarget[];
  productCount: number;
  sourceCount: number;
  locales: string[];
  metafieldRowCount: number;
};

/** Column names worth pre-selecting, keyed by the field they obviously feed. */
const SUGGESTED: Record<string, string> = {
  title: "title",
  "body (html)": "body_html",
  "body html": "body_html",
  "seo title": "meta_title",
  "seo description": "meta_description",
  type: "product_type",
};

/**
 * A metafield column in a Shopify-shaped export, e.g.
 * `Usage (product.metafields.custom.usage)`.
 *
 * The namespace cannot contain a dot so it is matched non-greedily up to the
 * first one; the key takes the rest. Namespaces are gnarlier than they look —
 * `shopify--discovery--product_recommendation` is one Shopify emits itself.
 */
const METAFIELD_COLUMN = /^.*?\(product\.metafields\.([^.)]+)\.([^)]+)\)$/;

/**
 * Pre-fill the obvious pairs, so the common case is a glance rather than
 * forty dropdowns.
 *
 * A source export that already labels its metafield columns the Shopify way
 * names its own destination, so those map straight across when the store has a
 * metafield of the same `namespace.key`. Everything else is left unmapped for
 * the user to decide.
 */
function suggestMapping(
  columns: string[],
  targets: TranslationTarget[],
): ColumnMapping {
  const known = new Set(targets.map((target) => target.field));
  const mapping: ColumnMapping = {};
  const taken = new Set<string>();

  for (const column of columns) {
    const trimmed = column.trim();
    const metafield = METAFIELD_COLUMN.exec(trimmed);
    const field = metafield
      ? `${metafield[1]}.${metafield[2]}`
      : SUGGESTED[trimmed.toLowerCase()];

    // One field per column and one column per field: a file with both
    // `Body (HTML)` and `Body HTML` would otherwise silently pick the last.
    if (!field || taken.has(field) || !known.has(field)) continue;
    taken.add(field);
    mapping[column] = field;
  }

  return mapping;
}

/**
 * Turn the store's metafield definitions into mappable targets.
 *
 * The type matters: a `rich_text_field` needs its value converted to Shopify's
 * JSON document shape, which is what `format` carries downstream.
 */
function metafieldTargets(
  definitions: { column: string; name: string; type: string }[],
): TranslationTarget[] {
  return definitions.map((definition) => ({
    field: definition.column,
    label: `${definition.name} (${definition.column})`,
    format: definition.type === RICH_TEXT_TYPE ? "rich_text" : "text",
    kind: "metafield",
  }));
}

/**
 * Which products own which metafield rows, for the fields actually mapped.
 *
 * The lookup is the only Admin API call this feature makes per product, so it
 * is skipped outright unless a metafield was mapped — a run touching nothing
 * but title and description costs nothing extra.
 */
async function resolveMetafieldRows(
  admin: Parameters<typeof resolveMetafieldOwners>[0],
  translations: ParsedTranslations,
) {
  const owners = await resolveMetafieldOwners(admin, [
    ...translations.metafieldRows.keys(),
  ]);

  const byProduct = new Map<string, Map<string, number>>();
  for (const [metafieldId, rowIndex] of translations.metafieldRows) {
    const owner = owners.get(metafieldId);
    if (!owner) continue;

    let columns = byProduct.get(owner.productId);
    if (!columns) {
      columns = new Map();
      byProduct.set(owner.productId, columns);
    }
    columns.set(owner.column, rowIndex);
  }

  return {
    byProduct,
    unresolved: translations.metafieldRows.size - owners.size,
  };
}

function readMapping(formData: FormData): ColumnMapping {
  const mapping: ColumnMapping = {};

  for (const [key, value] of formData.entries()) {
    if (!key.startsWith(MAPPING_PREFIX)) continue;
    const field = String(value);
    if (field) mapping[key.slice(MAPPING_PREFIX.length)] = field;
  }

  return mapping;
}

async function readUpload(formData: FormData, name: string, label: string) {
  const file = formData.get(name);
  if (!(file instanceof File) || file.size === 0) {
    throw new Error(`Choose a ${label} first.`);
  }

  const rows = parseCsv(await file.text());
  if (rows.length < 2) {
    throw new Error(`The ${label} has a header row but no data rows.`);
  }

  return rows;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  try {
    const formData = await request.formData();

    const translations = parseTranslations(
      await readUpload(formData, "translations", "Shopify translations export"),
    );
    const source = parseSource(
      await readUpload(formData, "source", "product export"),
    );

    if (translations.products.length === 0) {
      return {
        step: "error",
        message:
          "That translations export has no PRODUCT rows, so there is nothing to fill in. Export product translations from Apps → Translate & Adapt.",
      } as const;
    }

    // One cheap paged query. It populates the dropdown, and its types decide
    // which targets need rich text conversion.
    const targets = [
      ...PRODUCT_FIELDS,
      ...metafieldTargets(await listProductMetafieldDefinitions(admin)),
    ];

    // Both files read; a submit with no mapping is the first pass, whose only
    // job is to report what can be mapped where.
    const counts = {
      columns: source.columns,
      targets,
      productCount: translations.products.length,
      sourceCount: source.records.length,
      locales: translations.locales,
      metafieldRowCount: translations.metafieldRows.size,
    };

    const mapping = readMapping(formData);
    if (Object.keys(mapping).length === 0) {
      return {
        step: "inspect",
        ...counts,
        mapping: suggestMapping(source.columns, targets),
      } as const;
    }

    // The ID → product lookup is the expensive step, so it only runs when
    // something is actually aimed at a metafield.
    const byField = new Map(targets.map((target) => [target.field, target]));
    const usesMetafields = Object.values(mapping).some(
      (field) => byField.get(field)?.kind === "metafield",
    );
    const resolved = usesMetafields
      ? await resolveMetafieldRows(admin, translations)
      : null;

    return {
      step: "built",
      ...counts,
      mapping,
      unresolvedMetafields: resolved?.unresolved ?? 0,
      ...buildTranslationCsv({
        translations,
        source,
        mapping,
        targets,
        ...(resolved ? { metafieldRowsByProduct: resolved.byProduct } : {}),
      }),
    } as const;
  } catch (error) {
    return {
      step: "error",
      message: error instanceof Error ? error.message : String(error),
    } as const;
  }
};

export default function TranslationsPage() {
  const fetcher = useFetcher<ActionData>();
  const data = fetcher.data;
  const busy = fetcher.state !== "idle";

  // Only the freshly built file should download. Without this, every later
  // re-render — changing a select, say — would re-trigger the save.
  const downloaded = useRef<string | null>(null);

  useEffect(() => {
    if (data?.step !== "built" || data.filled === 0) return;
    if (downloaded.current === data.csv) return;

    downloaded.current = data.csv;
    saveCsv(data.csv, "shopify-translations-import.csv");
  }, [data]);

  const columns = data && data.step !== "error" ? data.columns : null;
  const mapping = data && data.step !== "error" ? data.mapping : {};

  return (
    <s-page heading="Translation CSV builder">
      {/* One form spanning both sections. The mapping controls read better in
          their own section, but they have to post alongside the file inputs:
          the files are re-sent from disk on every submit rather than echoed
          back through a hidden field, which keeps a couple of megabytes off
          the wire. */}
      <fetcher.Form method="post" encType="multipart/form-data">
        <s-section heading="Your two files">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Your shop&rsquo;s product export and Shopify&rsquo;s translations
              export describe the same products under different IDs, so the two
              cannot be joined directly. Products are matched by{" "}
              <strong>handle</strong>, falling back to <strong>title</strong>,
              which recovers the Shopify ID each translation row needs.
            </s-paragraph>

            <s-paragraph>
              Product fields — title, description, handle, product type and the
              two SEO fields — plus this store&rsquo;s product metafields.
              Metafield rows carry only a metafield ID, so the product they
              belong to is looked up from the store when you map one.
            </s-paragraph>

            <s-paragraph>
              A metafield of type <s-text>rich_text_field</s-text> is converted
              to the JSON document Shopify stores, so plain text or HTML from
              your export imports cleanly. Those targets are marked{" "}
              <s-text>rich text</s-text> in the list.
            </s-paragraph>

            <s-paragraph>
              An <strong>empty cell is skipped</strong>, never written as a
              blank translation, so you can fill one field without disturbing
              the others.
            </s-paragraph>

            <label className={styles.fileField}>
              <span className={styles.fileLabel}>
                Shopify translations export (the file to fill in)
              </span>
              <input
                className={styles.fileInput}
                type="file"
                name="translations"
                accept=".csv,text/csv"
                required
              />
            </label>

            <label className={styles.fileField}>
              <span className={styles.fileLabel}>
                Product export (where the translated text comes from)
              </span>
              <input
                className={styles.fileInput}
                type="file"
                name="source"
                accept=".csv,text/csv"
                required
              />
            </label>

            {!columns && (
              <div className={styles.actions}>
                <s-button type="submit" {...(busy ? { loading: true } : {})}>
                  Read columns
                </s-button>
              </div>
            )}
          </s-stack>
        </s-section>

        {data && data.step !== "error" && (
          <s-section heading="Match the columns">
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="small-300">
                <s-badge tone="info">
                  {data.productCount} products to translate
                </s-badge>
                <s-badge tone="neutral">
                  {data.sourceCount} products in your export
                </s-badge>
                {data.metafieldRowCount > 0 && (
                  <s-badge tone="neutral">
                    {data.metafieldRowCount} metafield rows
                  </s-badge>
                )}
                {data.locales.length === 1 && (
                  <s-badge tone="neutral">{data.locales[0]}</s-badge>
                )}
              </s-stack>

              {data.locales.length > 1 && (
                <s-banner tone="warning">
                  <s-paragraph>
                    This export covers several languages (
                    {data.locales.join(", ")}) and one column of text cannot be
                    right for all of them. Export a single language from
                    Translate &amp; Adapt and build one file per language.
                  </s-paragraph>
                </s-banner>
              )}

              <s-paragraph>
                Choose which column of the product export goes into which
                translation field. Anything left on{" "}
                <s-text>Don&rsquo;t import</s-text> is ignored.
              </s-paragraph>

              {/* A wide mapping table would otherwise push the whole embedded
                  page sideways on a narrow screen. */}
              <div className={styles.tableScroll}>
                <s-table>
                  <s-table-header-row>
                    <s-table-header>Column in your export</s-table-header>
                    <s-table-header>Goes to</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {data.columns.map((column) => (
                      <s-table-row key={column}>
                        <s-table-cell>{column}</s-table-cell>
                        <s-table-cell>
                          <s-select
                            name={`${MAPPING_PREFIX}${column}`}
                            label=""
                            labelAccessibilityVisibility="exclusive"
                          >
                            {/* The selection lives on the option rather than
                                the select: `s-select` omits `defaultValue`,
                                and a controlled `value` would fight the user's
                                edits between submits. */}
                            <s-option
                              value=""
                              {...(mapping[column]
                                ? {}
                                : { defaultSelected: true })}
                            >
                              Don&rsquo;t import
                            </s-option>
                            {data.targets.map((target) => (
                              <s-option
                                key={target.field}
                                value={target.field}
                                {...(mapping[column] === target.field
                                  ? { defaultSelected: true }
                                  : {})}
                              >
                                {target.kind === "metafield"
                                  ? `Metafield — ${target.label}`
                                  : target.label}
                                {target.format === "rich_text"
                                  ? " · rich text"
                                  : ""}
                              </s-option>
                            ))}
                          </s-select>
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              </div>

              <div className={styles.actions}>
                <s-button
                  type="submit"
                  variant="primary"
                  {...(busy ? { loading: true } : {})}
                >
                  Build translation CSV
                </s-button>
              </div>
            </s-stack>
          </s-section>
        )}
      </fetcher.Form>

      {data?.step === "error" && (
        <s-section heading="Could not read those files">
          <s-banner tone="critical">
            <s-paragraph>{data.message}</s-paragraph>
          </s-banner>
        </s-section>
      )}

      {data?.step === "built" && (
        <s-section heading="Your translation file">
          <s-stack direction="block" gap="base">
            <s-banner tone={data.filled === 0 ? "warning" : "success"}>
              <s-paragraph>
                {data.filled === 0
                  ? "No rows could be filled in. Check that the columns above are mapped and that the two files describe the same products."
                  : `${data.filled} translation(s) written across ${data.matched} product(s). The file has started downloading — import it under Apps → Translate & Adapt.`}
              </s-paragraph>
            </s-banner>

            {data.filled > 0 && (
              <div className={styles.actions}>
                <s-button
                  onClick={() =>
                    saveCsv(data.csv, "shopify-translations-import.csv")
                  }
                >
                  Download again
                </s-button>
              </div>
            )}

            {data.unresolvedMetafields > 0 && (
              <s-banner tone="warning">
                <s-paragraph>
                  {data.unresolvedMetafields} metafield row(s) in the export
                  could not be traced to a product on this store. That is
                  expected for metafields deleted since the export was taken —
                  but if it covers nearly all of them, the translations file
                  probably came from a different store than the one this app is
                  installed on.
                </s-paragraph>
              </s-banner>
            )}

            {data.missingFields.length > 0 && (
              <s-banner tone="warning">
                <s-paragraph>
                  Nothing was written for:{" "}
                  {data.missingFields.join(", ")}. Shopify only lists a field
                  in the export once the product already has content in it, so
                  there was no row to fill.
                </s-paragraph>
              </s-banner>
            )}

            {data.ambiguous.length > 0 && (
              <s-stack direction="block" gap="small-300">
                <s-paragraph>
                  Skipped — several products in your export share these titles
                  and have no matching handle, so the right one cannot be told
                  apart:
                </s-paragraph>
                <s-unordered-list>
                  {data.ambiguous.map((title) => (
                    <s-list-item key={title}>{title}</s-list-item>
                  ))}
                </s-unordered-list>
              </s-stack>
            )}

            {data.unmatched.length > 0 && (
              <s-stack direction="block" gap="small-300">
                <s-paragraph>
                  {data.unmatched.length} product(s) had no match in your export
                  and were left out:
                </s-paragraph>
                <s-unordered-list>
                  {data.unmatched.slice(0, 50).map((title) => (
                    <s-list-item key={title}>{title}</s-list-item>
                  ))}
                </s-unordered-list>
                {data.unmatched.length > 50 && (
                  <s-paragraph>
                    Showing the first 50 of {data.unmatched.length}.
                  </s-paragraph>
                )}
              </s-stack>
            )}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}
