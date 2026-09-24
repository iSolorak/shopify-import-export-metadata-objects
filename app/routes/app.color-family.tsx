import { useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { parseCsv, rowsToRecords } from "../lib/csv";
import { downloadCsv } from "../lib/download-csv";
import { upsertEntry } from "../lib/metaobjects.server";
import {
  METAFIELD_BATCH_SIZE,
  deleteMetafields,
  setMetafields,
  type MetafieldDelete,
  type MetafieldWrite,
} from "../lib/product-write.server";
import {
  getVariantMetafieldsByProductHandles,
  getVariantMetafieldsBySkus,
  type VariantMetafields,
} from "../lib/variant-metafields.server";
import {
  HANDLE_COLUMN,
  SKU_COLUMN,
  VARIANT_TITLE_COLUMN,
} from "../lib/variant-metafield-columns";
import {
  discoverColorFamily,
  loadFamilyEntries,
  planColorFamilyImport,
  readDefinitions,
  type ColorFamilySetup,
} from "../lib/color-family.server";
import {
  FAMILY_COLUMN,
  FAMILY_HEX_COLUMN,
  READ_ONLY_COLUMNS,
  SHOPIFY_COLOR_COLUMN,
  SHOPIFY_COLOR_HEX_COLUMN,
  familyFieldColumn,
  type ColorFamilyPlan,
} from "../lib/color-family";
import { Guide } from "../components/ui/Guide";
import {
  Actions,
  CsvDropZone,
  readForm,
  Steps,
  TableScroll,
} from "../components/ui/ImportFlow";

// Colour families, both halves in one sheet.
//
// `app.variant-metafields.tsx` can already assign a family to a variant, as one
// of however many metafields a store defines; `app._index` can already edit a
// family entry, in a file that knows nothing about which variants are in it.
// Neither can answer "what does this variant actually look like" — that needs
// the family *and* the standard colour behind it *and* the variant on one row,
// which is what this page exports.
//
// The import writes both halves, and they have very different blast radius:
//
//   `color family`      assigns one variant to a family
//   `color family hex`  edits the family entry — every variant in it changes
//
// So the review step names them separately, and the entry edits are collapsed
// across the rows that repeat them and cross-checked for disagreement before a
// single `metaobjectUpsert` goes out. Families are never created: a name the
// store does not have is an error on that row, not an invention.
//
// Two steps, both posting the same form:
//
//   intent=plan   → read the file, report what would change, write nothing
//   intent=apply  → re-plan against the store as it is now, then write
//
// Every submit is made programmatically from the button's click handler, for
// the reason `app.product-update.tsx:60` explains at length: `s-button` is a
// custom element whose submit runs before React's delegated click handler, so
// writing an intent into a hidden field on click serialises the *previous*
// click's value.

/** See `ColorFamilyPlanContext.clearEmpty`. Off, a blank cell erases nothing. */
const CLEAR_EMPTY_FIELD = "clearEmpty";

/** Which definition to use, when a store has more than one candidate. */
const TYPE_FIELD = "type";

/** One row per variant, so a modest catalogue is long. Matches the other imports. */
const MAX_ROWS = 5000;

type ActionData =
  | { step: "plan"; plan: ColorFamilyPlan; clearEmpty: boolean }
  | {
      step: "applied";
      /** Variants whose family changed, however few writes that took. */
      variants: number;
      /** Metafield writes that landed — one per product when product-owned. */
      assigned: number;
      cleared: number;
      families: number;
      owner: "product" | "variant";
      failures: string[];
    }
  | { step: "error"; message: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const found = await discoverColorFamily(
    admin,
    url.searchParams.get("type") ?? undefined,
  );

  if (!found.ok) return { ok: false as const, message: found.message };

  const {
    definition,
    metafield,
    owner,
    positional,
    hexFieldKey,
    otherFieldKeys,
    colorPattern,
    candidates,
  } = found.setup;

  // Only what the page renders. The full `Definition` carries validations and
  // descriptions no part of this UI reads.
  return {
    ok: true as const,
    type: definition.type,
    name: definition.name,
    column: metafield.column,
    metafieldName: metafield.name,
    owner: owner === "PRODUCT" ? ("product" as const) : ("variant" as const),
    positional,
    pinned: metafield.pinned,
    hexFieldKey,
    otherFieldKeys,
    colorPattern: colorPattern
      ? {
          column: colorPattern.definition.column,
          owner: colorPattern.owner === "PRODUCT" ? "product" : "variant",
        }
      : null,
    candidates,
  };
};

type Admin = Parameters<typeof discoverColorFamily>[0];

/**
 * Turn CSV text into a plan.
 *
 * Shared by both steps so that "apply" re-derives everything from the store as
 * it is now rather than trusting what the browser echoes back — the same
 * reasoning as every other import page here.
 */
async function buildPlan(
  admin: Admin,
  setup: ColorFamilySetup,
  csv: string,
  clearEmpty: boolean,
): Promise<
  { ok: true; plan: ColorFamilyPlan } | { ok: false; message: string }
> {
  const rows = parseCsv(csv);
  if (rows.length < 2) {
    return {
      ok: false,
      message: "That file has a header row but no data rows.",
    };
  }

  const records = rowsToRecords(rows);
  if (records.length > MAX_ROWS) {
    return {
      ok: false,
      message: `That file has ${records.length} rows. Import at most ${MAX_ROWS} at a time.`,
    };
  }

  const headers = Object.keys(records[0] ?? {});
  if (!headers.includes(SKU_COLUMN) && !headers.includes(HANDLE_COLUMN)) {
    return {
      ok: false,
      message: `This file has neither a "${SKU_COLUMN}" nor a "${HANDLE_COLUMN}" column, so its rows cannot be matched to variants. Download the export or the template to see the expected columns.`,
    };
  }

  // Rows with a SKU are looked up by SKU; the rest by their product's handle,
  // and narrowed to one variant by title or option values in the planner.
  const skus: string[] = [];
  const handles: string[] = [];
  for (const record of records) {
    const sku = (record[SKU_COLUMN] ?? "").trim();
    if (sku) skus.push(sku);
    else if ((record[HANDLE_COLUMN] ?? "").trim()) {
      handles.push((record[HANDLE_COLUMN] ?? "").trim());
    }
  }

  const reads = readDefinitions(setup);
  const [bySku, byHandle, families] = await Promise.all([
    getVariantMetafieldsBySkus(admin, reads, skus),
    getVariantMetafieldsByProductHandles(admin, reads, handles),
    loadFamilyEntries(admin, setup),
  ]);

  const variants: VariantMetafields[] = [];
  const seen = new Set<string>();
  const add = (found: VariantMetafields[]) => {
    for (const variant of found) {
      if (seen.has(variant.id)) continue;
      seen.add(variant.id);
      variants.push(variant);
    }
  };
  add(bySku);
  add(byHandle);

  // A product-owned metafield is written for the product as a whole, so the
  // planner has to see **every** variant of every product the file touches —
  // including the ones it never mentions. With a positional list that is not a
  // nicety: rebuilding a list from a partial set would drop the unmentioned
  // variants' families and shift every later variant onto the wrong colour.
  //
  // The SKU lookup returns single variants, so which products are involved is
  // only known after it. This second pass fills in their siblings; a
  // variant-owned metafield needs none of it and pays nothing.
  if (setup.owner === "PRODUCT") {
    const wanted = [
      ...new Set(variants.map((variant) => variant.productHandle)),
    ].filter((handle) => !handles.includes(handle));

    if (wanted.length) {
      add(await getVariantMetafieldsByProductHandles(admin, reads, wanted));
    }
  }

  return {
    ok: true,
    plan: planColorFamilyImport(setup, records, variants, {
      index: families.index,
      entries: families.entries,
      clearEmpty,
    }),
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const clearEmpty = formData.get(CLEAR_EMPTY_FIELD) != null;
  const type = String(formData.get(TYPE_FIELD) ?? "") || undefined;

  try {
    const found = await discoverColorFamily(admin, type);
    if (!found.ok) return { step: "error", message: found.message } as const;

    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { step: "error", message: "Choose a CSV file first." } as const;
    }

    const result = await buildPlan(
      admin,
      found.setup,
      await file.text(),
      clearEmpty,
    );
    if (!result.ok) return { step: "error", message: result.message } as const;

    if (intent !== "apply") {
      return { step: "plan", plan: result.plan, clearEmpty } as const;
    }

    // --- Write --------------------------------------------------------------
    const { namespace, key, type: metafieldType } = found.setup.metafield;
    const writes: { write: MetafieldWrite; label: string }[] = [];
    const removals: { remove: MetafieldDelete; label: string }[] = [];
    const failures: string[] = [];
    let variants = 0;

    for (const row of result.plan.rows) {
      if (row.action === "error") {
        failures.push(`Row ${row.rowNumber}: ${row.message}`);
        continue;
      }
      if (!row.variantId || !row.assign) continue;
      variants++;

      // A product-owned metafield is never written from a row: the planner has
      // folded these intents into one value per product, which is the only
      // shape a positional list can be written in. `row.assign` stays as the
      // row's intent for the review table.
      if (result.plan.owner === "product") continue;

      if (row.assign.kind === "write") {
        writes.push({
          write: {
            ownerId: row.variantId,
            namespace,
            key,
            type: metafieldType,
            value: row.assign.value,
          },
          label: `Row ${row.rowNumber} (${row.label})`,
        });
      } else {
        removals.push({
          remove: { ownerId: row.variantId, namespace, key },
          label: `Row ${row.rowNumber} (${row.label})`,
        });
      }
    }

    // One write per product, however many of its variants the file listed.
    for (const change of result.plan.products) {
      if (change.value == null) {
        removals.push({
          remove: { ownerId: change.productId, namespace, key },
          label: `Product ${change.label}`,
        });
      } else {
        writes.push({
          write: {
            ownerId: change.productId,
            namespace,
            key,
            type: metafieldType,
            value: change.value,
          },
          label: `Product ${change.label}`,
        });
      }
    }

    // The family entries go first. A variant moved into a family whose hex was
    // also edited should not, if the run dies halfway, be sitting in a family
    // still showing the old swatch — and an entry write is one call per family
    // rather than one per row, so it is the cheap half to get out of the way.
    let familiesWritten = 0;
    for (const change of result.plan.families) {
      const outcome = await upsertEntry(
        admin,
        result.plan.type,
        change.handle,
        change.values,
      );
      if (outcome.ok) familiesWritten++;
      else
        failures.push(`Family ${change.label}: ${outcome.errors.join("; ")}`);
    }

    // Batched, then sequential. `metafieldsSet` takes 25 per call and these
    // mutations share a leaky-bucket rate limit — a burst of parallel calls
    // gets throttled into failures that read like data errors.
    let assigned = 0;
    for (let start = 0; start < writes.length; start += METAFIELD_BATCH_SIZE) {
      const batch = writes.slice(start, start + METAFIELD_BATCH_SIZE);
      const outcome = await setMetafields(
        admin,
        batch.map((item) => item.write),
      );

      if (outcome.ok) {
        assigned += batch.length;
      } else {
        // The API reports errors against a position in the input array, so the
        // batch is named as a whole rather than mis-attributing them.
        failures.push(
          `${batch[0].label}${batch.length > 1 ? ` and ${batch.length - 1} more` : ""}: ${outcome.errors.join("; ")}`,
        );
      }
    }

    let cleared = 0;
    for (
      let start = 0;
      start < removals.length;
      start += METAFIELD_BATCH_SIZE
    ) {
      const batch = removals.slice(start, start + METAFIELD_BATCH_SIZE);
      const outcome = await deleteMetafields(
        admin,
        batch.map((item) => item.remove),
      );

      if (outcome.ok) {
        cleared += batch.length;
      } else {
        failures.push(
          `${batch[0].label}${batch.length > 1 ? ` and ${batch.length - 1} more` : ""}: ${outcome.errors.join("; ")}`,
        );
      }
    }

    return {
      step: "applied",
      owner: result.plan.owner,
      variants,
      assigned,
      cleared,
      families: familiesWritten,
      failures,
    } as const;
  } catch (error) {
    return {
      step: "error",
      message: error instanceof Error ? error.message : String(error),
    } as const;
  }
};

export default function ColorFamilyPage() {
  const setup = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const formRef = useRef<HTMLFormElement>(null);

  const [exporting, setExporting] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [refs, setRefs] = useState<"name" | "handle">("name");
  const [onlyAssigned, setOnlyAssigned] = useState(false);

  const data = fetcher.data;
  const busy = fetcher.state !== "idle";

  // Derived from the response rather than kept in state, so back-navigation and
  // a re-submitted form cannot leave the indicator out of step with the page.
  const step: 1 | 2 | 3 =
    data?.step === "applied" ? 3 : data?.step === "plan" ? 2 : 1;
  const plan = data?.step === "plan" ? data.plan : null;

  const runExport = async (kind: string) => {
    if (!setup.ok) return;
    setExporting(kind);
    setExportError(null);
    try {
      await downloadCsv(
        `/app/export-color-family?kind=${kind}&refs=${refs}&assigned=${
          onlyAssigned ? 1 : 0
        }&type=${encodeURIComponent(setup.type)}`,
      );
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(null);
    }
  };

  const submitWith = (intent: string) => () => {
    const form = formRef.current;
    if (!form) return;
    // A programmatic submit skips the constraint validation a native one runs,
    // and the CSV field is `required` — without this, forgetting to choose a
    // file would round-trip to the server just to be told so.
    //
    // `readForm` rather than `reportValidity()` + `new FormData(form)`: the
    // field is an `s-drop-zone`, and neither of those handles a form-associated
    // custom element reliably. See `readForm` in components/ui/ImportFlow.
    const formData = readForm(form);
    if (!formData) return;
    formData.set("intent", intent);
    fetcher.submit(formData, {
      method: "post",
      encType: "multipart/form-data",
    });
  };

  // Enter in a field still submits natively; treat that as "review", which is
  // the step that writes nothing.
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitWith("plan")();
  };

  if (!setup.ok) {
    return (
      <s-page heading="Colour families">
        <s-section heading="Nothing to work with yet">
          <s-stack direction="block" gap="base">
            <s-banner tone="warning">
              <s-paragraph>{setup.message}</s-paragraph>
            </s-banner>
            <s-paragraph>
              This page needs two things: a metaobject definition holding your
              colour families, and a product or variant metafield restricted to
              it. With both in place it exports one row per variant — its
              family, that family&rsquo;s own fields, and the Shopify standard
              colour and hex behind it — and imports the same file back.
            </s-paragraph>
          </s-stack>
        </s-section>
      </s-page>
    );
  }

  const fieldColumns = [
    ...(setup.hexFieldKey ? [FAMILY_HEX_COLUMN] : []),
    ...setup.otherFieldKeys.map(familyFieldColumn),
  ];

  return (
    <s-page heading="Colour families">
      <s-section heading="What this store uses">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Families live in <s-text>{setup.type}</s-text> ({setup.name}), and{" "}
            <s-text>{setup.column}</s-text> ({setup.metafieldName}) is the{" "}
            {setup.owner} metafield that points at them.
            {setup.hexFieldKey ? (
              <>
                {" "}
                Its <s-text>{setup.hexFieldKey}</s-text> field is the hex
                swatch, exported as <s-text>{FAMILY_HEX_COLUMN}</s-text>.
              </>
            ) : (
              <>
                {" "}
                It has no colour field, so there is no hex column of its own.
              </>
            )}
          </s-paragraph>

          {setup.positional && (
            <s-banner tone="info">
              <s-paragraph>
                <s-text>{setup.column}</s-text> is a{" "}
                <strong>list on the product</strong>, so entry N belongs to
                variant N — the same shape{" "}
                <s-text>shopify.color-pattern</s-text> uses. A row is placed by
                its variant&rsquo;s position as the store reports it, never by
                where the row sits in the file, so sorting or filtering the
                spreadsheet is safe.
              </s-paragraph>
              <s-paragraph>
                Because a list cannot have holes, changing one variant rewrites
                its product&rsquo;s whole list, and every variant of that
                product has to end up with a family. A product where some would
                and some would not is reported as an error rather than written
                in a shape that cannot be read back.
              </s-paragraph>
            </s-banner>
          )}

          {setup.owner === "product" && !setup.positional && (
            <s-banner tone="warning">
              <s-paragraph>
                <s-text>{setup.column}</s-text> is a single reference on the{" "}
                <strong>product</strong>, so it holds one family for all of its
                variants. Rows of the same product asking for different families
                are an error on all of them.
              </s-paragraph>
            </s-banner>
          )}

          {!setup.pinned && (
            <s-banner tone="warning">
              <s-paragraph>
                <s-text>{setup.column}</s-text> is not pinned, so it accepts
                values but never appears on the {setup.owner} in the admin —
                which looks exactly like an import that did nothing. Pin it in
                Settings → Custom data.
              </s-paragraph>
            </s-banner>
          )}

          <s-paragraph>
            <strong>{SHOPIFY_COLOR_COLUMN}</strong> and{" "}
            <strong>{SHOPIFY_COLOR_HEX_COLUMN}</strong> come from{" "}
            {setup.colorPattern ? (
              <>
                <s-text>{setup.colorPattern.column}</s-text> on the{" "}
                {setup.colorPattern.owner}, at this variant&rsquo;s position,
                falling back to a link the family carries itself
              </>
            ) : (
              <>
                a link the family carries itself (this store has no
                colour-pattern metafield)
              </>
            )}
            . The hex is read from the standard colour entry, or from its handle
            when the entry carries none &mdash;{" "}
            <s-text>100-natura-d38f8c-radiant</s-text> spells out{" "}
            <s-text>#d38f8c</s-text>. Both are read-only: a family&rsquo;s own{" "}
            {setup.hexFieldKey ? FAMILY_HEX_COLUMN : "fields"} is what this page
            writes, because editing a standard definition&rsquo;s entries is a
            far wider change than anything offered here.
          </s-paragraph>

          {setup.candidates.length > 1 && (
            <s-paragraph>
              This store has {setup.candidates.length} definitions that look
              like colour families:{" "}
              {setup.candidates.map((candidate) => candidate.type).join(", ")}.{" "}
              <s-text>{setup.type}</s-text> is in use — add{" "}
              <s-text>?type=…</s-text> to this page&rsquo;s URL to switch.
            </s-paragraph>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Export">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            One row per variant. Columns:{" "}
            <s-text>
              {[FAMILY_COLUMN, ...fieldColumns, ...READ_ONLY_COLUMNS].join(
                ", ",
              )}
            </s-text>
            , after the identifying columns. Only{" "}
            <s-text>{[FAMILY_COLUMN, ...fieldColumns].join(", ")}</s-text> are
            written back on import.
          </s-paragraph>

          <s-select
            label="Write families as"
            value={refs}
            onChange={(event: Event) =>
              setRefs(
                (event.target as HTMLSelectElement).value === "handle"
                  ? "handle"
                  : "name",
              )
            }
          >
            <s-option value="name">
              Display name — &ldquo;Peach Tones&rdquo;
            </s-option>
            <s-option value="handle">
              Handle — &ldquo;peach-tones&rdquo;
            </s-option>
          </s-select>

          <s-checkbox
            label="Only variants that already have a family"
            details="Off, every variant is a row — which is what you want to assign families to the ones that have none. On, the file is just the variants already in a family, which is smaller and enough for editing hexes."
            onChange={(event: { currentTarget: { checked: boolean } }) =>
              setOnlyAssigned(event.currentTarget.checked)
            }
          />

          {exportError && (
            <s-banner tone="critical">
              <s-paragraph>{exportError}</s-paragraph>
            </s-banner>
          )}

          <Actions>
            <s-button
              variant="primary"
              onClick={() => runExport("values")}
              {...(exporting === "values" ? { loading: true } : {})}
              {...(exporting ? { disabled: true } : {})}
            >
              Download variants CSV
            </s-button>
            <s-button
              onClick={() => runExport("template")}
              {...(exporting === "template" ? { loading: true } : {})}
              {...(exporting ? { disabled: true } : {})}
            >
              Download empty template
            </s-button>
          </Actions>
        </s-stack>
      </s-section>

      <fetcher.Form
        method="post"
        encType="multipart/form-data"
        ref={formRef}
        onSubmit={onSubmit}
      >
        <input type="hidden" name={TYPE_FIELD} value={setup.type} />

        <s-section heading="Import & update from CSV">
          <s-stack direction="block" gap="base">
            <Steps current={step} />

            <Guide
              id="color-family-import"
              title="How rows are matched, and what each column changes"
            >
              <s-stack direction="block" gap="small-200">
                <s-paragraph>
                  Rows are matched by <strong>{SKU_COLUMN}</strong> first, then
                  by <strong>{HANDLE_COLUMN}</strong> plus{" "}
                  <strong>{VARIANT_TITLE_COLUMN}</strong>, then by{" "}
                  <strong>{HANDLE_COLUMN}</strong> plus the option columns. The
                  identifying columns are never written. No variant and no
                  family is ever created or deleted.
                </s-paragraph>

                <s-paragraph>
                  <strong>{FAMILY_COLUMN}</strong> assigns one variant to a
                  family, by display name or handle. A name that matches no
                  family, or two, is an error on that row rather than a guess.
                  {setup.positional && (
                    <>
                      {" "}
                      It is written into <s-text>{setup.column}</s-text> at that
                      variant&rsquo;s position, which means rewriting its
                      product&rsquo;s whole list. Every variant of a product you
                      touch therefore has to end up with a family &mdash; the
                      ones your file does not mention keep what they already
                      have, and a product that would be left with a gap is
                      refused.
                    </>
                  )}
                </s-paragraph>

                <s-paragraph>
                  <strong>
                    {fieldColumns.join(", ") || "Family field columns"}
                  </strong>{" "}
                  edit the <strong>family entry</strong>, so every variant in
                  that family changes with it. The family edited is the one
                  named in <s-text>{FAMILY_COLUMN}</s-text> on the same row — so
                  a row that both moves a variant and sets a hex sets it on the
                  family it moved to. Rows of the same family asking for
                  different values are an error on all of them.
                </s-paragraph>

                <s-paragraph>
                  An <strong>empty cell is skipped</strong>, never written as a
                  blank, so a partly-filled spreadsheet cannot erase anything. A
                  value that already matches is not written at all, so
                  re-running the same file is free and a run that times out is
                  safe to repeat. Row order does not matter: a variant&rsquo;s
                  position comes from the store once the row has been matched,
                  so the sheet can be sorted or filtered freely.
                </s-paragraph>
              </s-stack>
            </Guide>

            <CsvDropZone name="file" label="CSV file" accept=".csv,text/csv" />

            <s-checkbox
              name={CLEAR_EMPTY_FIELD}
              label={`Remove variants whose ${FAMILY_COLUMN} cell is empty from their family`}
              details="Off, an empty cell is skipped and nothing is erased. On, an empty cell removes that variant from its family — which is how you clear a discontinued family across a catalogue. With a positional list this is all-or-nothing per product: clearing every variant deletes the metafield, clearing only some is the gap the importer refuses. It never blanks a family's own fields, and every clear is shown in the review step first."
              {...(data?.step === "plan" && data.clearEmpty
                ? { defaultChecked: true }
                : {})}
            />

            <Actions>
              <s-button
                type="button"
                onClick={submitWith("plan")}
                {...(busy ? { loading: true } : {})}
              >
                Review changes
              </s-button>
            </Actions>
          </s-stack>
        </s-section>

        {data?.step === "error" && (
          <s-section heading="Could not read that file">
            <s-banner tone="critical">
              <s-paragraph>{data.message}</s-paragraph>
            </s-banner>
          </s-section>
        )}

        {plan && (
          <s-section heading="Review">
            <s-stack direction="block" gap="base">
              <Steps current={2} />

              <s-banner tone="info">
                <s-paragraph>
                  Nothing has been written yet. This is what the file would do —
                  the store changes only when you press the button at the
                  bottom.
                </s-paragraph>
              </s-banner>
              <s-stack direction="inline" gap="small-300">
                <s-badge tone="info">{plan.counts.update} to update</s-badge>
                <s-badge tone="neutral">
                  {plan.counts.unchanged} unchanged
                </s-badge>
                {plan.families.length > 0 && (
                  <s-badge tone="warning">
                    {plan.families.length} family entr
                    {plan.families.length === 1 ? "y" : "ies"} to edit
                  </s-badge>
                )}
                {plan.products.length > 0 && (
                  <s-badge tone="info">
                    {plan.products.length} product metafield
                    {plan.products.length === 1 ? "" : "s"}
                  </s-badge>
                )}
                {plan.clearCount > 0 && (
                  <s-badge tone="critical">
                    {plan.clearCount} to unassign
                  </s-badge>
                )}
                {plan.counts.error > 0 && (
                  <s-badge tone="critical">
                    {plan.counts.error} with errors
                  </s-badge>
                )}
              </s-stack>

              <s-paragraph>
                {plan.assignCount} variant assignment(s), {plan.clearCount}{" "}
                removal(s), and {plan.familyFieldCount} field value(s) across{" "}
                {plan.families.length} family entr
                {plan.families.length === 1 ? "y" : "ies"}.
                {plan.owner === "product" &&
                  ` Those assignments are written as ${plan.products.length} ${
                    plan.positional ? "rebuilt list(s)" : "value(s)"
                  } — one per product, not one per row.`}
              </s-paragraph>

              {plan.unknownColumns.length > 0 && (
                <s-banner tone="warning">
                  <s-paragraph>
                    Ignored column(s) matching nothing on this page:{" "}
                    {plan.unknownColumns.join(", ")}
                  </s-paragraph>
                </s-banner>
              )}

              {plan.ignoredColumns.length > 0 && (
                <s-banner tone="info">
                  <s-paragraph>
                    Read and not written: {plan.ignoredColumns.join(", ")}
                  </s-paragraph>
                </s-banner>
              )}

              {plan.products.length > 0 && (
                <TableScroll>
                  <s-table>
                    <s-table-header-row>
                      <s-table-header>Product</s-table-header>
                      <s-table-header>From rows</s-table-header>
                      <s-table-header>Per-variant changes</s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                      {plan.products.map((change) => (
                        <s-table-row key={change.productId}>
                          <s-table-cell>{change.label}</s-table-cell>
                          <s-table-cell>
                            {change.rowNumbers.length}
                          </s-table-cell>
                          <s-table-cell>
                            {change.value == null
                              ? "cleared"
                              : change.changes.join("; ")}
                          </s-table-cell>
                        </s-table-row>
                      ))}
                    </s-table-body>
                  </s-table>
                </TableScroll>
              )}

              {plan.families.length > 0 && (
                <TableScroll>
                  <s-table>
                    <s-table-header-row>
                      <s-table-header>Family</s-table-header>
                      <s-table-header>From rows</s-table-header>
                      <s-table-header>Changes</s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                      {plan.families.map((change) => (
                        <s-table-row key={change.handle}>
                          <s-table-cell>
                            {change.label} ({change.handle})
                          </s-table-cell>
                          <s-table-cell>
                            {change.rowNumbers.length}
                          </s-table-cell>
                          <s-table-cell>
                            {change.changes.join("; ")}
                          </s-table-cell>
                        </s-table-row>
                      ))}
                    </s-table-body>
                  </s-table>
                </TableScroll>
              )}

              {/* A wide plan table would otherwise push the whole embedded
                  page sideways on a narrow screen. */}
              <TableScroll>
                <s-table>
                  <s-table-header-row>
                    <s-table-header>Row</s-table-header>
                    <s-table-header>Variant</s-table-header>
                    <s-table-header>SKU</s-table-header>
                    <s-table-header>Action</s-table-header>
                    <s-table-header>Details</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {plan.rows.slice(0, 100).map((row) => (
                      <s-table-row key={row.rowNumber}>
                        <s-table-cell>{row.rowNumber}</s-table-cell>
                        <s-table-cell>{row.label || "—"}</s-table-cell>
                        <s-table-cell>{row.sku || "—"}</s-table-cell>
                        <s-table-cell>
                          <s-badge
                            tone={
                              row.action === "error"
                                ? "critical"
                                : row.action === "update"
                                  ? "info"
                                  : "neutral"
                            }
                          >
                            {row.action}
                          </s-badge>
                        </s-table-cell>
                        <s-table-cell>
                          {row.message ?? row.changes.join("; ")}
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              </TableScroll>

              {plan.rows.length > 100 && (
                <s-paragraph>
                  Showing the first 100 of {plan.rows.length} rows. All of them
                  will be imported.
                </s-paragraph>
              )}

              <Actions>
                <s-button
                  type="button"
                  variant="primary"
                  onClick={submitWith("apply")}
                  {...(busy ? { loading: true } : {})}
                >
                  Apply {plan.counts.update} row
                  {plan.counts.update === 1 ? "" : "s"}
                </s-button>
              </Actions>
            </s-stack>
          </s-section>
        )}
      </fetcher.Form>

      {data?.step === "applied" && (
        <s-section heading="Import finished">
          <s-stack direction="block" gap="base">
            <Steps current={3} />
            <s-banner tone={data.failures.length ? "warning" : "success"}>
              <s-paragraph>
                {data.variants} variant(s) changed across {data.assigned}{" "}
                write(s) and {data.cleared} removal(s), {data.families} family
                entr
                {data.families === 1 ? "y" : "ies"} updated,{" "}
                {data.failures.length} failed.
              </s-paragraph>
            </s-banner>

            {data.failures.length > 0 && (
              <s-unordered-list>
                {data.failures.map((failure) => (
                  <s-list-item key={failure}>{failure}</s-list-item>
                ))}
              </s-unordered-list>
            )}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}
