import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { listDefinitions } from "../lib/metaobjects.server";

// Lists every metaobject definition in the store with a per-type download.
// The counts come straight from the definition, so the merchant can see how
// large an export will be before starting one.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  return { definitions: await listDefinitions(admin) };
};

export default function MetaobjectsIndex() {
  const { definitions } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Metaobjects">
      <s-button slot="primary-action" href="/app/metaobjects/import">
        Import CSV
      </s-button>

      <s-section heading="Export">
        {definitions.length === 0 ? (
          <s-paragraph>
            This store has no metaobject definitions yet. Import a definition
            CSV to create one, or add a definition in Settings &rarr; Custom
            data.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              <strong>Entries</strong> is the data itself, one row per entry.{" "}
              <strong>Definition</strong> is the schema — import it into another
              store first so the entries have somewhere to land.
            </s-paragraph>

            <s-table>
              <s-table-header-row>
                <s-table-header>Name</s-table-header>
                <s-table-header>Type</s-table-header>
                <s-table-header>Fields</s-table-header>
                <s-table-header>Entries</s-table-header>
                <s-table-header>Download</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {definitions.map((definition) => (
                  <s-table-row key={definition.id}>
                    <s-table-cell>{definition.name}</s-table-cell>
                    <s-table-cell>
                      <s-text>{definition.type}</s-text>
                    </s-table-cell>
                    <s-table-cell>{definition.fieldKeys.length}</s-table-cell>
                    <s-table-cell>{definition.entryCount}</s-table-cell>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small-300">
                        {/* Plain links, not fetchers: the browser needs a real
                            navigation to trigger the file download. */}
                        <s-link
                          href={`/app/metaobjects/export?type=${encodeURIComponent(definition.type)}&kind=entries`}
                        >
                          Entries
                        </s-link>
                        <s-link
                          href={`/app/metaobjects/export?type=${encodeURIComponent(definition.type)}&kind=definition`}
                        >
                          Definition
                        </s-link>
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-stack>
        )}
      </s-section>

      <s-section heading="Import">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Importing matches rows to entries by <s-text>handle</s-text>: an
            existing handle is updated, a new one is created. Nothing is written
            until you review the summary and confirm.
          </s-paragraph>
          <Link to="/app/metaobjects/import">
            <s-button>Import CSV</s-button>
          </Link>
        </s-stack>
      </s-section>
    </s-page>
  );
}
