import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

// The design tokens the light-DOM wrappers are built from — Shopify's own
// spacing, type, and colour values. Imported here rather than per-route so the
// custom properties are defined before any component that reads them renders.
import "./styles/tokens.css";

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
