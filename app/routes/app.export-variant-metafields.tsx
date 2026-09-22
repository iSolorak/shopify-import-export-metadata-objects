import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { listMetafieldDefinitions } from "../lib/product-metafields.server";
import {
  buildMetaobjectIndex,
  getAllVariantMetafields,
  resolveMetaobjectIds,
  resolveProductIds,
} from "../lib/variant-metafields.server";
import {
  variantMetafieldExportFilename,
  type RefStyle,
} from "../lib/variant-metafield-columns";
import {
  collectReferenceIds,
  variantDefinitionsToCsv,
  variantMetafieldTemplateCsv,
  variantMetafieldsToCsv,
} from "../lib/variant-metafield-csv.server";

// Resource route, same arrangement as `app.export-rich-text.tsx`: no component,
// so React Router serves the loader's Response directly as a file.
//
// Three kinds, because they answer three different questions:
//
//   definitions → what variant metafields does this store have?
//   values      → what is in them, for every variant?
//   template    → what columns does the importer expect?
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const kindParam = url.searchParams.get("kind");
  const kind =
    kindParam === "template" || kindParam === "definitions"
      ? kindParam
      : "values";
  const refs: RefStyle =
    url.searchParams.get("refs") === "handle" ? "handle" : "name";

  const definitions = await listMetafieldDefinitions(admin, "PRODUCTVARIANT");
  if (definitions.length === 0) {
    throw new Response(
      "This store has no metafield definitions on variants.",
      { status: 404 },
    );
  }

  let csv: string;

  if (kind === "template") {
    csv = variantMetafieldTemplateCsv(definitions);
  } else if (kind === "definitions") {
    // Only for the `metaobject definition` column. Every other column comes
    // straight off the definition, so a store with no reference metafields
    // pays nothing for it.
    const index = await buildMetaobjectIndex(admin, definitions);
    csv = variantDefinitionsToCsv(definitions, index.typeByColumn);
  } else {
    const variants = await getAllVariantMetafields(admin, definitions);
    const { metaobjectIds, productIds } = collectReferenceIds(
      definitions,
      variants,
    );

    // Resolved from the gids actually present rather than by enumerating every
    // entry of every referenced definition: an export of a store with one
    // colour family per variant should not read a thousand-entry metaobject.
    const [metaobjects, products] = await Promise.all([
      resolveMetaobjectIds(admin, metaobjectIds),
      resolveProductIds(admin, productIds),
    ]);

    csv = variantMetafieldsToCsv(definitions, variants, {
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
