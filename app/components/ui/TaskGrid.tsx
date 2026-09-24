import { Link } from "react-router";

import styles from "./TaskGrid.module.css";

/**
 * The names `s-icon` accepts, read off the element rather than restated.
 * `IconType` is not exported from @shopify/polaris-types, and a plain `string`
 * here would let a typo through to a silently blank card.
 */
type IconName = NonNullable<React.JSX.IntrinsicElements["s-icon"]["type"]>;

/**
 * The launcher on the home page: one card per job the app can do.
 *
 * This app is ten unrelated tools that happen to share a CSV parser, and the
 * navigation used to be the only thing describing them — eight flat links whose
 * labels ("Update products", "Colour families") say what the page is called but
 * not what it is for or when you would want it. Anyone who had not used the app
 * before had to open all eight to find the one they wanted.
 *
 * A card carries the three things a link cannot: the object it acts on, a
 * sentence of what it does, and whether this store has anything for it to work
 * on. The last one matters most — a store with no rich text metafields should
 * be able to see that from the home page rather than by visiting the page and
 * meeting an empty state.
 */
export type Task = {
  /** Route to open. */
  href: string;
  title: string;
  /** One sentence, plain language, starting with a verb. */
  description: string;
  /** A Polaris icon name — see `IconType` in @shopify/polaris-types. */
  icon: IconName;
  /**
   * What this store holds for the tool, e.g. "12 definitions". Omitted when
   * the page has nothing countable; never fabricate a zero, since "0 entries"
   * and "not checked" read identically and only one of them is true.
   */
  meta?: string;
  /** Marks the card as having nothing to act on, without hiding it. */
  empty?: boolean;
};

export function TaskGrid({ tasks }: { tasks: Task[] }) {
  return (
    <div className={styles.grid}>
      {tasks.map((task) => (
        // `Link`, never a plain `<a href>`.
        //
        // This app is embedded: it renders inside an iframe in the Shopify
        // admin, and the URL the iframe was handed carries the `host`,
        // `shop` and `embedded` parameters App Bridge authenticates with. A
        // raw anchor is a full document navigation — the browser drops the
        // query string and re-requests the bare path, which arrives with no
        // session and so never reaches the page you clicked.
        //
        // `Link` routes on the client instead. No document load, the iframe
        // keeps its parameters, and the route's loader runs over the existing
        // authenticated session. The nav in `app.tsx` gets away with `s-link`
        // only because App Bridge intercepts those itself.
        <Link
          key={task.href}
          className={styles.card}
          to={task.href}
          data-empty={task.empty ? "" : undefined}
        >
          <span className={styles.icon} aria-hidden="true">
            <s-icon type={task.icon} size="base" />
          </span>
          <span className={styles.text}>
            <span className={styles.title}>{task.title}</span>
            <span className={styles.description}>{task.description}</span>
            {task.meta && <span className={styles.meta}>{task.meta}</span>}
          </span>
          <span className={styles.chevron} aria-hidden="true">
            <s-icon type="chevron-right" size="small" />
          </span>
        </Link>
      ))}
    </div>
  );
}
