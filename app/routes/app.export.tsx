import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { getDefinition, getEntries } from "../lib/metaobjects.server";
import {
  definitionToCsv,
  entriesToCsv,
  exportFilename,
} from "../lib/metaobject-csv";

// Resource route: returns a CSV file rather than a page. It has no component
// export, so React Router serves the loader's Response directly.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const type = url.searchParams.get("type");
  const kind = url.searchParams.get("kind") === "definition"
    ? "definition"
    : "entries";

  if (!type) {
    throw new Response("Missing ?type=", { status: 400 });
  }

  const definition = await getDefinition(admin, type);
  if (!definition) {
    throw new Response(`No metaobject definition of type "${type}"`, {
      status: 404,
    });
  }

  const csv =
    kind === "definition"
      ? definitionToCsv(definition)
      : entriesToCsv(definition, await getEntries(admin, type));

  // Excel ignores the charset header and guesses the encoding unless the file
  // starts with a BOM, which mangles any accented character in a value. The
  // CSV parser strips it again on import, so the round trip stays clean.
  return new Response(`\uFEFF${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(type, kind)}"`,
      "Cache-Control": "no-store",
    },
  });
};
