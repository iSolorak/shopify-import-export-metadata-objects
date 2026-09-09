import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.grid} aria-hidden="true" />
      <div className={styles.sweep} aria-hidden="true" />
      <div className={styles.scanlines} aria-hidden="true" />

      <div className={styles.content}>
        <div className={styles.bar}>
          <span className={`${styles.dot} ${styles.dotRed}`} />
          <span className={`${styles.dot} ${styles.dotAmber}`} />
          <span className={`${styles.dot} ${styles.dotGreen}`} />
          <span className={styles.barTitle}>
            metaobject-import-export — login
          </span>
        </div>

        <div className={styles.body}>
          <img
            className={styles.tux}
            src="/tux.svg"
            alt="Tux, the Linux penguin"
          />

          <h1 className={styles.heading}>
            <span className={styles.prompt}>$</span> Metaobjects import &amp;
            export
            <span className={styles.cursor} />
          </h1>

          {showForm && (
            <Form className={styles.form} method="post" action="/auth/login">
              <label className={styles.label}>
                <span className={styles.labelText}>Shop domain</span>
                <input
                  className={styles.input}
                  type="text"
                  name="shop"
                  placeholder="my-shop-domain.myshopify.com"
                />
                <span className={styles.hint}>
                  e.g: my-shop-domain.myshopify.com
                </span>
              </label>
              <button className={styles.button} type="submit">
                Log in
              </button>
            </Form>
          )}

          <p className={styles.credit}>
            Tux by Larry Ewing (lewing@isc.tamu.edu) and The GIMP, vectored by
            Simon Budig and Garrett LeSage.
          </p>
        </div>
      </div>
    </div>
  );
}
