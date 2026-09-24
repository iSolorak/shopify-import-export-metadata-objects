import { useEffect, useRef, useState, type ReactNode } from "react";

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

/** The bits of `s-drop-zone` this file touches. */
type DropZoneElement = HTMLElement & {
  files?: readonly File[];
};

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
 ## Why `required` is carried on `data-required`
 *
 * Polaris documents `required` on a field as semantic only — "it will not cause
 * an error to appear automatically". Driving the real Polaris runtime in a
 * browser confirms it: `s-drop-zone` never calls `setValidity`, so `required`
 * contributes nothing to constraint validation and an empty one leaves
 * `form.checkValidity()` true. It would therefore neither block a submit nor
 * tell anyone the field was empty — the worst of both.
 *
 * The requirement is kept on `data-required` so `readForm` can enforce it
 * itself and say so on the field. The server still has the last word: every
 * action here opens by rejecting a missing file with "Choose a CSV file first."
 */
export function CsvDropZone({
  name = "file",
  label = "CSV file",
  accept = ".csv,text/csv",
  required = true,
  multiple = false,
  onFiles,
}: {
  name?: string;
  label?: string;
  accept?: string;
  required?: boolean;
  multiple?: boolean;
  /**
   * Called with the chosen files as soon as the user picks them.
   *
   * Subscribed with a real `addEventListener`, not a React `onChange` prop.
   * React's synthetic events are wired for the elements React knows about; on
   * a custom element an `onChange` prop is not reliably the element's own
   * `change`. The element dispatches a composed `change` on its host once
   * `.files` is populated, so listening natively is both simpler and correct.
   */
  onFiles?: (files: File[]) => void;
}) {
  // The listener is attached through a wrapper rather than a `ref` on the
  // element itself: the Polaris JSX types model `ref` as `Ref<DropZone>`, and
  // narrowing it to the handful of members used here makes TypeScript give up
  // ("union type that is too complex to represent"). `display: contents` means
  // the wrapper adds no box and no layout of its own.
  const wrapper = useRef<HTMLSpanElement | null>(null);

  // Held in a ref so the subscription does not tear down and re-attach on
  // every render just because the caller passed a new closure.
  const latest = useRef(onFiles);
  latest.current = onFiles;

  useEffect(() => {
    const element =
      wrapper.current?.querySelector<DropZoneElement>("s-drop-zone");
    if (!element) return;
    const handle = () => latest.current?.(Array.from(element.files ?? []));
    element.addEventListener("change", handle);
    return () => element.removeEventListener("change", handle);
  }, []);

  return (
    <span ref={wrapper} style={{ display: "contents" }}>
      <s-drop-zone
        name={name}
        label={label}
        accept={accept}
        {...(required ? { "data-required": "" } : {})}
        {...(multiple ? { multiple: true } : {})}
      />
    </span>
  );
}

/**
 * Warn when a submit finishes having rendered nothing.
 *
 * React Router gives a fetcher no `data` when the action never returned one —
 * a thrown response, an auth redirect the iframe swallowed, a body the proxy
 * refused because the upload was too large. Each of those leaves the screen
 * exactly as it was, which is indistinguishable from a button that does not
 * work, and is what "I uploaded a CSV and nothing happened" usually is.
 *
 * Returns the message to show, and a setter so the page can raise its own.
 */
export function useSubmitFeedback(state: string, data: unknown) {
  const [error, setError] = useState<string | null>(null);
  const wasSubmitting = useRef(false);

  useEffect(() => {
    if (state !== "idle") {
      wasSubmitting.current = true;
      return;
    }
    if (!wasSubmitting.current) return;
    wasSubmitting.current = false;
    if (data === undefined) {
      setError(
        "The server did not return a response. If the file is large, try splitting it — an upload can be refused before it reaches the app.",
      );
    }
  }, [state, data]);

  return [error, setError] as const;
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
