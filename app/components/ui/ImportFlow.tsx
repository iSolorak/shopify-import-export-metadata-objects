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
 *
 * ## Why `required` is not passed to the element
 *
 * It is deliberately withheld, and the requirement is carried on a data
 * attribute instead. Polaris documents `required` on a field as semantic only —
 * "it will not cause an error to appear automatically" — but the element is
 * form-associated, so the flag still reaches constraint validation, and a form
 * containing an invalid custom element does not submit.
 *
 * A native input that fails validation gets the browser's "Please select a
 * file" bubble pointing at it. A custom element gets nothing: the submit is
 * blocked, no request is made, no message appears, and the button reads as
 * broken. That is precisely what it did — upload a CSV on the product update
 * page and the button did nothing at all.
 *
 * Dropping the attribute means the form always submits. Emptiness is then
 * caught where it was already handled properly: every action here opens by
 * rejecting a missing file with "Choose a CSV file first." The three pages that
 * submit programmatically go one better and catch it in the browser via
 * `readForm`, which reads `data-required` and shows the message on the field.
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
      {...(required ? { "data-required": "" } : {})}
      {...(multiple ? { multiple: true } : {})}
      {...(onChange ? { onChange } : {})}
    />
  );
}

/**
 * Validate a form and read it into `FormData`, handling `s-drop-zone` itself.
 *
 * Three pages here submit programmatically from a click handler rather than
 * letting the browser do it (see the header of `app.product-update.tsx` for
 * why). Those were written against a native `<input type="file">`, where
 * `form.reportValidity()` and `new FormData(form)` are all you need. A
 * form-associated custom element is not reliably either of those things:
 *
 *  - `reportValidity()` consults the element's `ElementInternals` validity. If
 *    the drop zone has not published a valid state for a file it is holding,
 *    the form reports invalid, the submit handler returns early, and **nothing
 *    at all happens** — no request, no message, no indication the click landed.
 *  - `new FormData(form)` takes whatever the element passed to `setFormValue`.
 *    A file control that publishes its value as a string path contributes a
 *    name, not a `File`, and the action's `instanceof File` check rejects it.
 *
 * Neither is worth betting the page's only button on, so this does not ask the
 * element for either. It reads `.files` off the drop zone directly — the
 * property the Polaris type declares and the wrapped `<input>` owns — checks
 * the required ones itself, validates the native controls the ordinary way,
 * and appends the files to the `FormData` by hand.
 *
 * Returns `null` when something is invalid, having already shown the user why.
 */
type DropZoneElement = HTMLElement & {
  files?: readonly File[];
};

export function readForm(form: HTMLFormElement): FormData | null {
  const zones = Array.from(
    form.querySelectorAll<DropZoneElement>("s-drop-zone"),
  );

  // A missing file used to surface as the browser's "Please select a file"
  // bubble on the native input. There is no equivalent to trigger on a custom
  // element, so say it in the page instead — silence here is exactly the bug
  // this function exists to fix.
  for (const zone of zones) {
    // `data-required`, not `required` — see `CsvDropZone` for why the element
    // is never given the real attribute.
    const required = zone.hasAttribute("data-required");
    if (required && !zone.files?.length) {
      zone.scrollIntoView({ block: "center", behavior: "smooth" });
      zone.focus?.();
      zone.setAttribute("error", "Choose a CSV file first.");
      return null;
    }
    zone.removeAttribute("error");
  }

  // The native controls, checked the ordinary way. `form.elements` includes the
  // drop zones, whose validity was just decided above on better evidence.
  for (const element of Array.from(form.elements)) {
    if (element.tagName.toLowerCase() === "s-drop-zone") continue;
    const candidate = element as HTMLInputElement;
    if (typeof candidate.checkValidity !== "function") continue;
    if (!candidate.checkValidity()) {
      candidate.reportValidity();
      return null;
    }
  }

  const formData = new FormData(form);

  // Replace whatever the element contributed under its own name — possibly
  // nothing, possibly a string — with the actual `File` objects.
  for (const zone of zones) {
    const name = zone.getAttribute("name");
    if (!name || !zone.files?.length) continue;
    formData.delete(name);
    for (const file of zone.files) formData.append(name, file);
  }

  return formData;
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
