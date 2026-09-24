import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      {/*
        Ordered by the object each tool acts on — metaobjects, then products,
        then variants, then translations — matching the grouping on the home
        page, so the nav and the launcher agree about where a tool lives.

        The labels are nouns for the thing being edited rather than sentences
        about the operation. "Import & export rich text" and "Add product
        videos" described what the page does; every page here imports and
        exports something, so that told a reader nothing and cost the scan a
        long label to read past. The verb belongs on the page, where there is
        room to be specific.
      */}
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/metaobjects">Metaobjects</s-link>
        <s-link href="/app/metaobject-fields">Definitions &amp; fields</s-link>
        <s-link href="/app/product-update">Products</s-link>
        <s-link href="/app/rich-text">Rich text</s-link>
        <s-link href="/app/product-videos">Product videos</s-link>
        <s-link href="/app/variant-metafields">Variant metafields</s-link>
        <s-link href="/app/color-family">Colour families</s-link>
        <s-link href="/app/translations">Translations</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
