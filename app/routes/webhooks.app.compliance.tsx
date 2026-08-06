import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Shopify requires every app distributed through the App Store to respond to
// these three topics. `authenticate.webhook` verifies the HMAC, so an
// unsigned request never reaches the handlers below.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} compliance webhook for ${shop}`);

  switch (topic) {
    // A customer asked the merchant for the data this app holds on them.
    // This app stores no customer-identifiable data — only per-shop banner
    // settings and OAuth sessions — so there is nothing to return. If you
    // later store customer data, you must deliver it to the merchant within
    // 30 days; log the request here so you have a record of it.
    case "CUSTOMERS_DATA_REQUEST":
      console.log(
        `No customer data stored for ${shop}; request payload:`,
        JSON.stringify(payload),
      );
      break;

    // A customer's data must be erased. Nothing to do for the same reason.
    case "CUSTOMERS_REDACT":
      break;

    // Sent 48 hours after uninstall. Erase everything belonging to this shop.
    case "SHOP_REDACT":
      await db.banner.deleteMany({ where: { shop } });
      await db.session.deleteMany({ where: { shop } });
      break;

    default:
      // Returning 404 tells Shopify the topic is unhandled rather than
      // silently acknowledging it.
      return new Response("Unhandled webhook topic", { status: 404 });
  }

  return new Response();
};
