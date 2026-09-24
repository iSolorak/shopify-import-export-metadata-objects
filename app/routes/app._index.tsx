import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { listDefinitions } from "../lib/metaobjects.server";
import { Guide } from "../components/ui/Guide";
import { TaskGrid, type Task } from "../components/ui/TaskGrid";

/**
 * The home page: a launcher, not a tool.
 *
 * `/app` used to open straight into the metaobjects import/export form — one of
 * ten unrelated tools, picked to be the front door because it happened to be
 * written first. Anyone landing here saw a metaobject type selector and a file
 * field, with no indication that the app also updates products, builds
 * translation files, or attaches videos; the only map was eight flat links in
 * the nav, none of which said what they were for.
 *
 * So the front door is now a map. The tools are grouped by the thing they act
 * on — metaobjects, products, variants, translations — because that is the
 * question someone arrives with ("I need to change something about my
 * products"), not the shape of the operation. The metaobjects tool moved to
 * `/app/metaobjects` unchanged.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  // The only count cheap enough to take on every home page load: one paginated
  // read that the metaobjects page already performs. The other tools each need
  // a product or metafield scan, and a front door that takes six seconds to
  // paint is worse than one that shows no numbers.
  //
  // A failure here must not cost the whole page. The counts are decoration on a
  // set of links; the links work without them.
  let metaobjectCount: number | null = null;
  let entryCount: number | null = null;
  try {
    const definitions = await listDefinitions(admin);
    metaobjectCount = definitions.length;
    entryCount = definitions.reduce(
      (total, definition) => total + definition.entryCount,
      0,
    );
  } catch {
    metaobjectCount = null;
    entryCount = null;
  }

  return { metaobjectCount, entryCount };
};

export default function HomePage() {
  const { metaobjectCount, entryCount } = useLoaderData<typeof loader>();

  const metaobjectTasks: Task[] = [
    {
      href: "/app/metaobjects",
      title: "Import & export entries",
      description:
        "Download a metaobject type as a CSV, edit it in a spreadsheet, and upload it back. Image URLs are pulled into Files for you.",
      icon: "metaobject",
      meta:
        metaobjectCount === null
          ? undefined
          : metaobjectCount === 0
            ? "No definitions yet"
            : `${metaobjectCount} definition${metaobjectCount === 1 ? "" : "s"} · ${entryCount} entr${entryCount === 1 ? "y" : "ies"}`,
      empty: metaobjectCount === 0,
    },
    {
      href: "/app/metaobject-fields",
      title: "Definitions & fields",
      description:
        "Create a metaobject definition, see the fields each one has, and expose them on the product page as metafields.",
      icon: "metaobject-list",
    },
  ];

  const productTasks: Task[] = [
    {
      href: "/app/product-update",
      title: "Update products from CSV",
      description:
        "Export the product columns you choose, change them in a spreadsheet, and write them back — matched on handle.",
      icon: "product",
    },
    {
      href: "/app/rich-text",
      title: "Rich text metafields",
      description:
        "Move rich text metafields in and out as readable text, instead of the JSON Shopify stores them as.",
      icon: "text",
    },
    {
      href: "/app/product-videos",
      title: "Add product videos",
      description:
        "Attach videos to products in bulk from a CSV of URLs, hosted or external.",
      icon: "video",
    },
  ];

  const variantTasks: Task[] = [
    {
      href: "/app/variant-metafields",
      title: "Variant metafields",
      description:
        "Export and update metafields on variants rather than products, one row per variant.",
      icon: "variant",
    },
    {
      href: "/app/color-family",
      title: "Colour families",
      description:
        "Group variant colours into families, with hex values, so a storefront filter can offer ten colours instead of four hundred.",
      icon: "color",
    },
  ];

  const translationTasks: Task[] = [
    {
      href: "/app/translations",
      title: "Translation CSV builder",
      description:
        "Combine a source export and a translated file into the CSV format Shopify's translation importer expects.",
      icon: "language-translate",
    },
  ];

  return (
    <s-page heading="Import & export">
      <s-section
        heading="Start here"
        accessibilityLabel="How the tools in this app work"
      >
        {/* `s-page` has no subheading slot in Polaris v1.0, so the one-line
            description of the app leads its first section instead. */}
        <s-paragraph color="subdued">
          Bulk edits to this store&rsquo;s content, as spreadsheets you can open
          anywhere.
        </s-paragraph>
        <Guide id="home" title="How every tool in this app works">
          <s-stack direction="block" gap="small-200">
            <s-paragraph>
              Each page below does the same two things in the same order.{" "}
              <strong>Export</strong> downloads what the store holds today as a
              CSV — open it in Sheets, Excel, or anything else that reads a
              spreadsheet. <strong>Import</strong> takes that file back and
              applies your edits.
            </s-paragraph>
            <s-paragraph>
              An import is always two steps. The first reads your file and shows
              you exactly what would change — created, updated, unchanged, and
              anything that would fail — and writes nothing. Only the second
              button touches the store. If a review looks wrong, leaving the
              page costs you nothing.
            </s-paragraph>
            <s-paragraph>
              Rows are matched by a key column, usually{" "}
              <s-text type="strong">handle</s-text>. A key the store already
              knows is an update; one it does not is a new record. Deleting a
              row from the CSV does not delete anything — nothing here removes
              data.
            </s-paragraph>
            <s-paragraph>
              The safest way to start on a tool you have not used is to export
              first, change one row, and import that. The review step will show
              you one update and everything else unchanged.
            </s-paragraph>
          </s-stack>
        </Guide>
      </s-section>

      {/* One section per object the store holds, rather than one per tool. The
          section heading is the noun someone arrives with; the cards inside are
          the verbs available for it. */}
      <s-section heading="Metaobjects">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Custom content types — colour swatches, size guides, ingredient
            lists — and the schemas behind them.
          </s-paragraph>
          <TaskGrid tasks={metaobjectTasks} />
        </s-stack>
      </s-section>

      <s-section heading="Products">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Fields, metafields, and media on products themselves.
          </s-paragraph>
          <TaskGrid tasks={productTasks} />
        </s-stack>
      </s-section>

      <s-section heading="Variants">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Anything that differs between the variants of one product.
          </s-paragraph>
          <TaskGrid tasks={variantTasks} />
        </s-stack>
      </s-section>

      <s-section heading="Translations">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Preparing content for Shopify&rsquo;s own translation importer.
          </s-paragraph>
          <TaskGrid tasks={translationTasks} />
        </s-stack>
      </s-section>
    </s-page>
  );
}
