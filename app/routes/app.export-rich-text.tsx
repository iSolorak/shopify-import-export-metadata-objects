import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import {
  getAllProductRichText,
  listRichTextDefinitions,
} from "../lib/product-metafields.server";
import {
  richTextExportFilename,
  richTextTemplateCsv,
  richTextToCsv,
} from "../lib/rich-text-csv";

// Resource route, same arrangement as `app.export.tsx`: no component, so React
// Router serves the loader's Response directly as a file.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") === "template" ? "template" : "values";

  const definitions = await listRichTextDefinitions(admin);
  if (definitions.length === 0) {
    throw new Response(
      "This store has no rich text metafield definitions on products.",
      { status: 404 },
    );
  }

  const csv =
    kind === "template"
      ? richTextTemplateCsv(definitions)
      : richTextToCsv(
          definitions,
          await getAllProductRichText(admin, definitions),
        );

  // BOM for the same reason as the metaobject export: without it Excel guesses
  // the encoding and mangles accented characters, and rich text copy is exactly
  // where those show up.
  return new Response(`\uFEFF${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${richTextExportFilename(kind)}"`,
      "Cache-Control": "no-store",
    },
  });
};
