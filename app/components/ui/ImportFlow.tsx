import type { ReactNode } from "react";

import styles from "./ImportFlow.module.css";

/* ---------------------------------------------------------------------------
   The shared furniture of an import page.
   ---------------------------------------------------------------------------
   Nearly every route here runs the same three-beat flow: choose a file, review
   what would change, apply it. Each route had built that flow out of its own
   hand-rolled markup, so the same step looked slightly different on every page —
   a different file input, a different button row, a different arrangement of
   count badges. The pieces below are that flow, written once.
   --------------------------------------------------------------------------- */

/**
 * Where you are in choose → review → apply.
 *
 * The two-round-trip import is the app's most confusing behaviour: you press a
 * button called "Review changes" and land on a page of numbers, and nothing has
 * told you there is a second button still to come. People read the plan as the
 * result and leave, and the import never happens.
 *
 * Naming the three steps up front and marking the current one turns that from a
 * surprise into a position. It also earns the review step its safety property:
 * "nothing has been written yet" is reassuring only once you know something
 * later will write.
 */
export function Steps({
  current,
  labels = ["Choose a file", "Review changes", "Apply"],
}: {
  /** 1-based. Steps before it are drawn as done. */
  current: number;
  /**
   * Three by default, because most pages here are choose → review → apply.
   * The product update has a column-matching beat in the middle and the
   * translation builder produces a file rather than writing, so both pass
   * their own — the names should be the page's own words, not borrowed ones.
   */
  labels?: string[];
}) {
  return (
    <ol className={styles.steps}>
      {labels.map((label, index) => {
        const step = index + 1;
        const state =
          step < current ? "done" : step === current ? "current" : "todo";
        return (
          <li key={label} className={styles.step} data-state={state}>
            <span className={styles.marker} aria-hidden="true">
              {state === "done" ? <s-icon type="check" size="small" /> : step}
            </span>
            <span className={styles.stepLabel}>{label}</span>
            {/* Only the current step is announced as such; "done" and "todo"
                read from the visible label plus the marker's own text. */}
            {state === "current" && (
              <span className={styles.visuallyHidden}>(current step)</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The CSV file field.
 *
 * Was a bare `<input type="file">` with about forty lines of CSS per page
 * trying to make it look like the admin — a losing fight that also left the
 * control at the browser's default hit size. `s-drop-zone` is form-associated,
 * so it submits under its `name` in the same multipart POST the raw input did,
 * and it brings drag-and-drop, the admin's own focus ring, and both themes for
 * free.
 */
export function CsvDropZone({
  name = "file",
  label = "CSV file",
  accept = ".csv,text/csv",
  required = true,
  multiple = false,
  onChange,
}: {
  name?: string;
  label?: string;
  accept?: string;
  required?: boolean;
  multiple?: boolean;
  onChange?: (event: Event) => void;
}) {
  return (
    <s-drop-zone
      name={name}
      label={label}
      accept={accept}
      {...(required ? { required: true } : {})}
      {...(multiple ? { multiple: true } : {})}
      {...(onChange ? { onChange } : {})}
    />
  );
}

/**
 * A row of buttons.
 *
 * `s-button-group` already knows Shopify's 8px gap and how to wrap on a narrow
 * screen, which is what the hand-written `.actions` flexbox in each route was
 * reimplementing — at 12px, so every button row in the app was one step wider
 * than the admin's.
 */
export function Actions({ children }: { children: ReactNode }) {
  return <s-button-group gap="base">{children}</s-button-group>;
}

/** The counts an import plan produces, as one scannable row of badges. */
export type PlanCounts = {
  create: number;
  update: number;
  unchanged: number;
  error: number;
};

export function PlanSummary({
  counts,
  extra,
  nouns = { create: "to create", update: "to update" },
}: {
  counts: PlanCounts;
  /** Page-specific badges, e.g. images queued for upload. */
  extra?: ReactNode;
  nouns?: { create: string; update: string };
}) {
  return (
    <s-stack direction="inline" gap="small-300" alignItems="center">
      <s-badge tone="success" icon="plus-circle">
        {counts.create} {nouns.create}
      </s-badge>
      <s-badge tone="info" icon="edit">
        {counts.update} {nouns.update}
      </s-badge>
      {/* Zero unchanged rows is not worth a badge — it is the absence of a
          thing, and a row of badges reads fastest when each one is a fact. */}
      {counts.unchanged > 0 && (
        <s-badge tone="neutral">{counts.unchanged} unchanged</s-badge>
      )}
      {counts.error > 0 && (
        <s-badge tone="critical" icon="alert-triangle">
          {counts.error} with errors
        </s-badge>
      )}
      {extra}
    </s-stack>
  );
}

/**
 * Horizontal scroller for a wide plan table.
 *
 * An embedded app cannot let its content widen the iframe — the admin's chrome
 * goes with it and the whole page scrolls sideways. The table gets its own
 * scroll box instead, with a shadow at the edge so it is discoverable that
 * there are more columns.
 */
export function TableScroll({ children }: { children: ReactNode }) {
  return <div className={styles.tableScroll}>{children}</div>;
}

/**
 * A plan table showing only its first rows.
 *
 * Every review step truncates at 100 and then says so in a paragraph of its
 * own; this puts the sentence immediately under the table it describes, where
 * it answers the question it raises.
 */
export function TruncationNote({
  shown,
  total,
  noun = "rows",
}: {
  shown: number;
  total: number;
  noun?: string;
}) {
  if (total <= shown) return null;
  return (
    <s-paragraph color="subdued">
      Showing the first {shown} of {total} {noun}. All of them are included.
    </s-paragraph>
  );
}
