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
} from "../lib/translation-csv";
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
    } & Counts)
  | { step: "error"; message: string };

/**
 * What both non-error steps carry, so the mapping section keeps its shape once
 * the file has been built rather than losing its counts and column table.
 */
type Counts = {
  columns: string[];
  mapping: ColumnMapping;
  productCount: number;
  sourceCount: number;
  locales: string[];
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

function suggestMapping(columns: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const taken = new Set<string>();

  for (const column of columns) {
    const field = SUGGESTED[column.trim().toLowerCase()];
    // One field per column and one column per field: a file with both
    // `Body (HTML)` and `Body HTML` would otherwise silently pick the last.
    if (!field || taken.has(field)) continue;
    taken.add(field);
    mapping[column] = field;
  }

  return mapping;
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
  await authenticate.admin(request);

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

    // Both files read; a submit with no mapping is the first pass, whose only
    // job is to report the columns available to map.
    const counts = {
      columns: source.columns,
      productCount: translations.products.length,
      sourceCount: source.records.length,
      locales: translations.locales,
    };

    const mapping = readMapping(formData);
    if (Object.keys(mapping).length === 0) {
      return {
        step: "inspect",
        ...counts,
        mapping: suggestMapping(source.columns),
      } as const;
    }

    return {
      step: "built",
      ...counts,
      mapping,
      ...buildTranslationCsv({ translations, source, mapping }),
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
              Only product fields are filled in — title, description, handle,
              product type and the two SEO fields. Metafield rows are left
              alone: the export identifies them by metafield ID with no
              reference to the product they belong to, so they cannot be matched
              from these two files.
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
                            {PRODUCT_FIELDS.map((target) => (
                              <s-option
                                key={target.field}
                                value={target.field}
                                {...(mapping[column] === target.field
                                  ? { defaultSelected: true }
                                  : {})}
                              >
                                {target.label}
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

            {data.missingFields.length > 0 && (
              <s-banner tone="warning">
                <s-paragraph>
                  The translations export has no rows for:{" "}
                  {data.missingFields.join(", ")}. Shopify only lists a field
                  once the product has content in it, so nothing was written
                  there.
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
