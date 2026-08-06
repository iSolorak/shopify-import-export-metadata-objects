import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// This route is reached from the STOREFRONT via an App Proxy.
// Shopify forwards `https://your-store.myshopify.com/apps/banner`
// to this route and signs the request so we can trust it.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Verifies the request really came from Shopify for a specific shop.
  const { session } = await authenticate.public.appProxy(request);

  const banner = session
    ? await prisma.banner.findUnique({ where: { shop: session.shop } })
    : null;

  // Nothing to show unless the merchant enabled it and wrote a message.
  const text = banner?.enabled ? banner.message : "";

  // Return plain HTML that the storefront can render.
  const body = text
    ? `<div style="padding:12px;text-align:center;background:#111;color:#fff;">${escapeHtml(
        text,
      )}</div>`
    : "";

  return new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
};

// Never inject raw merchant input into HTML without escaping it.
function escapeHtml(input: string) {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
