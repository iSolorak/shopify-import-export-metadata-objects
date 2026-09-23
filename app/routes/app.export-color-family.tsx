import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import {
  getAllVariantMetafields,
  resolveMetaobjectIds,
} from "../lib/variant-metafields.server";
import {
  assignedOnly,
  collectColorIds,
  collectNestedIds,
  colorFamilyCsv,
  colorFamilyTemplateCsv,
  discoverColorFamily,
  readDefinitions,
  variantOrdinals,
} from "../lib/color-family.server";
import { colorFamilyExportFilename, type RefStyle } from "../lib/color-family";

// Resource route, same arrangement as the other exports: no component, so
// React Router serves the loader's Response directly as a file.
//
//   values   → one row per variant: its family, that family's fields, and the
//              Shopify standard colour behind it
//   template → the same columns with no rows, for building a sheet by hand
export const loader = async (args: LoaderFunctionArgs) => {
  try {
    return await exportCsv(args);
  } catch (error) {
    if (error instanceof Response) throw error;
    // Left to throw, an Admin API error reaches the browser as React Router's
    // "Unexpected Server Error" and the page has nothing useful to show.
    throw new Response(error instanceof Error ? error.message : String(error), {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
};

const exportCsv = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") === "template" ? "template" : "values";
  const refs: RefStyle =
    url.searchParams.get("refs") === "handle" ? "handle" : "name";
  // Off by default: assigning families to variants that have none is half the
  // point of the import, and those rows have to be in the file to be edited.
  const onlyAssigned = url.searchParams.get("assigned") === "1";
  const type = url.searchParams.get("type") ?? undefined;

  const found = await discoverColorFamily(admin, type);
  if (!found.ok) throw new Response(found.message, { status: 404 });
  const setup = found.setup;

  if (kind === "template") {
    return csvResponse(colorFamilyTemplateCsv(setup), kind);
  }

  const all = await getAllVariantMetafields(admin, readDefinitions(setup));

  // Computed over every variant, before any filtering. A product's list lines
  // up with *all* its variants, so ranking a filtered set would renumber the
  // survivors and read the wrong entry for each one.
  const ordinals = variantOrdinals(all);
  const variants = onlyAssigned ? assignedOnly(setup, all, ordinals) : all;

  // Resolved from the gids actually present rather than by reading every entry
  // of the definition: a store with six families and ten thousand variants
  // should fetch six entries, not ten thousand.
  const metaobjects = await resolveMetaobjectIds(
    admin,
    collectColorIds(setup, variants, ordinals),
  );

  // Second pass. A colour pattern names the colour but stores the swatch one
  // level down, so the hex only exists after this.
  for (const [id, ref] of await resolveMetaobjectIds(
    admin,
    collectNestedIds(metaobjects),
  )) {
    metaobjects.set(id, ref);
  }

  return csvResponse(
    colorFamilyCsv(setup, variants, ordinals, { metaobjects, refs }),
    kind,
  );
};

function csvResponse(csv: string, kind: "values" | "template") {
  // BOM for the same reason as the other exports: without it Excel guesses the
  // encoding, and a family called "Rosé" is exactly where that shows.
  return new Response(`\uFEFF${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${colorFamilyExportFilename(kind)}"`,
      "Cache-Control": "no-store",
    },
  });
}
