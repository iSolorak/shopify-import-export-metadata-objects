// `s-app-nav` and the other App Bridge custom elements are declared by
// @shopify/app-bridge-types. Nothing in this app imports @shopify/app-bridge-react
// any more, and without an import the compiler never loads those globals — the
// JSX in app.tsx then fails with "Property 's-app-nav' does not exist on type
// 'JSX.IntrinsicElements'". Reference the types directly so the declarations do
// not depend on which routes happen to exist.
/// <reference types="@shopify/app-bridge-types" />

declare module "*.css";
