import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { listMetafieldDefinitions } from "../lib/product-metafields.server";
import {
  buildMetaobjectIndex,
  getAllVariantMetafields,
  resolveMetaobjectIds,
  resolveProductIds,
  type DefinitionSet,
} from "../lib/variant-metafields.server";
import {
  variantMetafieldExportFilename,
  type RefStyle,
} from "../lib/variant-metafield-columns";
import {
  collectEntryFieldIds,
  collectReferenceIds,
  expandedColumns,
  metafieldColumns,
  variantDefinitionsToCsv,
  variantMetafieldTemplateCsv,
  variantMetafieldsToCsv,
} from "../lib/variant-metafield-csv.server";

// Resource route, same arrangement as `app.export-rich-text.tsx`: no component,
// so React Router serves the loader's Response directly as a file.
//
// Three kinds, because they answer three different questions:
//
//   definitions → what metafields does this store have on variants and products?
//   values      → what is in them, for every variant?
//   template    → what columns does the importer expect?
// Every failure below is turned into a plain-text response carrying the real
// message. Left to throw, an Admin API error reaches the browser as React
// Router's "Unexpected Server Error" and the page has nothing useful to show —
// which is exactly how a query cost limit looked before it was tracked down.
export const loader = async (args: LoaderFunctionArgs) => {
  try {
    return await exportCsv(args);
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response(
      error instanceof Error ? error.message : String(error),
      { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }
};

const exportCsv = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const kindParam = url.searchParams.get("kind");
  const kind =
    kindParam === "template" || kindParam === "definitions"
      ? kindParam
      : "values";
  const refs: RefStyle =
    url.searchParams.get("refs") === "handle" ? "handle" : "name";
  // Both default on: the page's checkboxes always send an explicit value, so a
  // missing parameter means someone typed the URL by hand and wants the lot.
  const withProduct = url.searchParams.get("product") !== "0";
  const withExpanded = url.searchParams.get("expand") !== "0";

  const [variant, product] = await Promise.all([
    listMetafieldDefinitions(admin, "PRODUCTVARIANT"),
    listMetafieldDefinitions(admin, "PRODUCT"),
  ]);
  const definitions: DefinitionSet = {
    variant,
    // Reading a product metafield costs a lookup per product, so the columns
    // are only asked for when something will carry them.
    product: withProduct ? product : [],
  };

  if (variant.length === 0 && definitions.product.length === 0) {
    throw new Response("This store has no metafield definitions on variants.", {
      status: 404,
    });
  }

  const targets = metafieldColumns(definitions, withProduct);
  let csv: string;

  if (kind === "template") {
    csv = variantMetafieldTemplateCsv(targets);
  } else if (kind === "definitions") {
    // Only for the `metaobject definition` and `entry fields` columns. A store
    // with no reference metafields pays nothing for it.
    csv = variantDefinitionsToCsv(
      targets,
      await buildMetaobjectIndex(admin, targets, { entries: false }),
    );
  } else {
    const variants = await getAllVariantMetafields(admin, definitions);
    const { metaobjectIds, productIds } = collectReferenceIds(targets, variants);

    // Resolved from the gids actually present rather than by enumerating every
    // entry of every referenced definition: an export of a store with one
    // colour family per variant should not read a thousand-entry metaobject.
    const [metaobjects, products] = await Promise.all([
      resolveMetaobjectIds(admin, metaobjectIds),
      resolveProductIds(admin, productIds),
    ]);

    let expanded: ReturnType<typeof expandedColumns> = [];
    if (withExpanded) {
      // One more level: a `shopify--color-pattern` entry's `color` field points
      // at a `shopify--color` entry, and leaving that as a gid would defeat the
      // point of expanding it at all. Two levels is where it stops.
      for (const [id, ref] of await resolveMetaobjectIds(
        admin,
        collectEntryFieldIds(metaobjects),
      )) {
        metaobjects.set(id, ref);
      }

      expanded = expandedColumns(
        targets,
        await buildMetaobjectIndex(admin, targets, { entries: false }),
      );
    }

    csv = variantMetafieldsToCsv(targets, expanded, variants, {
      metaobjects,
      products,
      refs,
    });
  }

  // BOM for the same reason as the other exports: without it Excel guesses the
  // encoding, and a display name like "Rosé" is exactly where that shows.
  return new Response(`\uFEFF${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${variantMetafieldExportFilename(kind)}"`,
      "Cache-Control": "no-store",
    },
  });
};
