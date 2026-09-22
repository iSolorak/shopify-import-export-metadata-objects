import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { toCsv } from "../lib/csv";
import { listMetafieldDefinitions } from "../lib/product-metafields.server";
import {
  getAllProductsForExport,
  type ExistingProduct,
  type MetafieldRef,
} from "../lib/product-write.server";
import {
  STATIC_FIELDS,
  metafieldTargets,
  type FieldTarget,
} from "../lib/product-import-columns";
import {
  collectReferenceGids,
  productExportColumns,
  productExportRows,
} from "../lib/product-export-csv";
import {
  resolveMetaobjectIds,
  resolveProductIds,
} from "../lib/variant-metafields.server";

// Resource route, same arrangement as the other three exports: no component, so
// React Router serves the loader's Response directly as a file.
//
// The columns are chosen by the caller — `?fields=` holds `FieldTarget.field`
// ids, which is what the picker on `app.product-update.tsx` sends. Unlike the
// variant metafield export, an absent `fields` is *not* "give me everything":
// the full catalogue is dozens of columns wide and reads every metafield on the
// store, which is not a sensible thing to do by accident.
export const loader = async (args: LoaderFunctionArgs) => {
  try {
    return await exportCsv(args);
  } catch (error) {
    // As on the variant export: left to throw, an Admin API error reaches the
    // browser as React Router's "Unexpected Server Error" and the page has
    // nothing useful to show.
    if (error instanceof Response) throw error;
    throw new Response(error instanceof Error ? error.message : String(error), {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
};

const exportCsv = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const chosen = new Set(
    (url.searchParams.get("fields") ?? "")
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean),
  );
  const filter = url.searchParams.get("query") ?? "";
  const locationId = url.searchParams.get("location");

  if (chosen.size === 0) {
    throw new Response("No columns chosen — tick at least one field to export.", {
      status: 400,
    });
  }

  const [productDefs, variantDefs] = await Promise.all([
    listMetafieldDefinitions(admin, "PRODUCT"),
    listMetafieldDefinitions(admin, "PRODUCTVARIANT"),
  ]);

  // The same catalogue the import mapping is built from, so a column this
  // writes is a column that page already knows how to read.
  const catalogue: FieldTarget[] = [
    ...STATIC_FIELDS,
    ...metafieldTargets(productDefs, "PRODUCT"),
    ...metafieldTargets(variantDefs, "PRODUCTVARIANT"),
  ];

  const targets = catalogue.filter((target) => chosen.has(target.field));
  if (targets.length === 0) {
    throw new Response(
      "None of the chosen fields exist on this store. Reload the page and pick again.",
      { status: 400 },
    );
  }

  // Only the metafields that became columns are read back. Every ref adds a
  // field to each product *and* each of its variants, so this is the number
  // the page size is derived from.
  const refsOf = (owner: "PRODUCT" | "PRODUCTVARIANT"): MetafieldRef[] =>
    targets
      .filter((target) => target.metafield?.owner === owner)
      .map((target) => ({
        namespace: target.metafield!.namespace,
        key: target.metafield!.key,
      }));

  // Read in full before serializing, because a reference metafield cannot be
  // written until its gids have been turned into handles, and resolving those
  // one product at a time would be a round trip per product. The generator
  // still keeps only one page of raw API nodes alive at a time.
  const products: ExistingProduct[] = [];
  const metaobjectGids: string[] = [];
  const productGids: string[] = [];

  for await (const product of getAllProductsForExport(admin, {
    productRefs: refsOf("PRODUCT"),
    variantRefs: refsOf("PRODUCTVARIANT"),
    filter,
  })) {
    products.push(product);
    const found = collectReferenceGids(targets, product);
    metaobjectGids.push(...found.metaobjects);
    productGids.push(...found.products);
  }

  // A reference metafield holds gids; the importer reads handles. Exporting
  // the stored value verbatim gives a file that fails on every row of that
  // column — and an unreadable reference cell is rejected whole, taking every
  // other reference in it down with it.
  const [metaobjectRefs, productHandles] = await Promise.all([
    resolveMetaobjectIds(admin, metaobjectGids),
    resolveProductIds(admin, productGids),
  ]);

  const metaobjects = new Map(
    [...metaobjectRefs].map(([gid, ref]) => [gid, ref.handle]),
  );

  const rows: string[][] = [productExportColumns(targets)];
  for (const product of products) {
    rows.push(
      ...productExportRows(targets, product, {
        locationId,
        metaobjects,
        products: productHandles,
      }),
    );
  }

  if (rows.length === 1) {
    throw new Response(
      filter
        ? `No products matched "${filter}".`
        : "This store has no products to export.",
      { status: 404 },
    );
  }

  // BOM for the same reason as every other export here: without it Excel
  // guesses the encoding, and a product title like "Rosé" is exactly where
  // that shows.
  return new Response(`\uFEFF${toCsv(rows)}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename()}"`,
      "Cache-Control": "no-store",
    },
  });
};

function exportFilename() {
  return `products-${new Date().toISOString().slice(0, 10)}.csv`;
}
