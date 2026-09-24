import { useEffect, useState, type ReactNode } from "react";

import styles from "./Guide.module.css";

/**
 * The "how this works" panel that sits above a form.
 *
 * Every page in this app needs two or three paragraphs of explanation before
 * its form makes sense — what a handle column is for, what happens to an image
 * URL, why an import is two steps. Those paragraphs are the most valuable text
 * on the page the first time someone lands, and the most in-the-way text on the
 * hundredth: previously they ran inline with the fields, so the controls were
 * pushed below the fold forever and the page read as a wall.
 *
 * So the guide keeps its prominence and loses its permanence. It opens expanded,
 * collapses to a single line, and remembers the choice per guide in
 * `localStorage` — the page teaches you once and then gets out of the way,
 * without ever hiding the explanation behind a link you have to know to click.
 *
 * Polaris ships no accordion, so the disclosure is a native `<details>`: it is
 * keyboard-operable, findable by in-page search even while closed, and degrades
 * to plain open content if the script never runs.
 */
export function Guide({
  id,
  title = "How this works",
  children,
  tone = "info",
}: {
  /**
   * Stable key for the remembered open state. Name it after the page, not the
   * heading, so rewording the title does not re-expand it for everyone.
   */
  id: string;
  title?: string;
  children: ReactNode;
  /** `info` for instructions, `caution` for the ones that warn about data. */
  tone?: "info" | "caution";
}) {
  const storageKey = `guide:${id}`;

  // Server-rendered open. Collapsing on the client after hydration would be a
  // visible jump, but the alternative — rendering closed and expanding — hides
  // the text from anyone whose JS has not arrived, which is the reader it is
  // most for.
  const [open, setOpen] = useState(true);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(storageKey) === "closed") setOpen(false);
    } catch {
      // Private browsing, or an embedded context that blocks storage. The
      // guide simply stays expanded — losing the preference is not worth an
      // error path.
    }
  }, [storageKey]);

  const remember = (next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(storageKey, next ? "open" : "closed");
    } catch {
      /* see above */
    }
  };

  return (
    <details
      className={`${styles.guide} ${tone === "caution" ? styles.caution : ""}`}
      open={open}
      onToggle={(event) =>
        remember((event.currentTarget as HTMLDetailsElement).open)
      }
    >
      <summary className={styles.summary}>
        <s-icon
          type={tone === "caution" ? "alert-triangle" : "info"}
          size="small"
        />
        <span className={styles.title}>{title}</span>
        <span className={styles.hint} aria-hidden="true">
          {open ? "Hide" : "Show"}
        </span>
      </summary>
      <div className={styles.body}>{children}</div>
    </details>
  );
}
