import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// LOADER: runs on the server before the page renders.
// We authenticate the merchant, figure out which shop they are,
// and read that shop's banner from the database (if it exists yet).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const banner = await prisma.banner.findUnique({
    where: { shop: session.shop },
  });

  return {
    enabled: banner?.enabled ?? false,
    message: banner?.message ?? "",
  };
};

// ACTION: runs on the server when the form is submitted.
// It reads the form values and saves them to the database with `upsert`
// (update the row if it exists for this shop, otherwise create it).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const formData = await request.formData();
  const message = String(formData.get("message") ?? "");
  const enabled = formData.get("enabled") === "true";

  await prisma.banner.upsert({
    where: { shop: session.shop },
    update: { enabled, message },
    create: { shop: session.shop, enabled, message },
  });

  return { ok: true };
};

export default function BannerPage() {
  // Data from the loader (the currently saved values).
  const data = useLoaderData<typeof loader>();
  // A fetcher lets us submit the form without a full page navigation.
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  // Local UI state, seeded from what's saved in the database.
  const [message, setMessage] = useState(data.message);
  const [enabled, setEnabled] = useState(data.enabled);

  const isSaving = fetcher.state !== "idle";

  // Show a toast once a save finishes successfully.
  useEffect(() => {
    if (fetcher.data?.ok) {
      shopify.toast.show("Banner saved yay!");
    }
  }, [fetcher.data, shopify]);

  const save = (nextEnabled: boolean) => {
    setEnabled(nextEnabled);
    fetcher.submit(
      { message, enabled: String(nextEnabled) },
      { method: "POST" },
    );
  };

  return (
    <s-page heading="Storefront banner">
      <s-button
        slot="primary-action"
        onClick={() => save(!enabled)}
        {...(isSaving ? { loading: true } : {})}
      >
        {enabled ? "Disable banner" : "Enable banner"}
      </s-button>

      <s-section heading="Banner message">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Type a message, then press First Shopify App <strong>Enable banner</strong>. When
            enabled, the message shows on your storefront at{" "}
            <s-text>/apps/banner</s-text>.
          </s-paragraph>

          <s-text-field
            label="Message"
            value={message}
            onInput={(e: Event) =>
              setMessage((e.target as HTMLInputElement).value)
            }
          />

          <s-stack direction="inline" gap="base">
            <s-button
              variant="secondary"
              onClick={() => save(enabled)}
              {...(isSaving ? { loading: true } : {})}
            >
              Save message
            </s-button>
            <s-badge tone={enabled ? "success" : "neutral"}>
              {enabled ? "Enabled" : "Disabled"}
            </s-badge>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}
