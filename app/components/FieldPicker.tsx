import { useMemo, useState } from "react";

import styles from "./FieldPicker.module.css";

// Choosing columns for an export, from a list too long to read.
//
// Shared by the product export on `app.product-update.tsx` and the variant
// metafield export on `app.variant-metafields.tsx`. They pick from different
// catalogues but ask the same question, and a second copy of this would be the
// place the two drifted apart.
//
// The first version was a flat column of every checkbox, which is the thing a
// forty-field catalogue is worst served by: nothing is findable, and the answer
// most people want — "the usual columns" — took forty decisions to express.
// Four things fix that, and each is a documented pattern rather than a guess:
//
//  1. **Presets.** One click for the common answers. The equivalent of Polaris'
//     saved views: the shape of the question most people are actually asking.
//  2. **Search.** Past roughly twenty options a plain checkbox list stops
//     working and filtering is what replaces it — the same reason Polaris
//     points at Combobox rather than ChoiceList for large sets. While a search
//     is active, "select all" applies to the matches, so finding and choosing
//     are one gesture.
//  3. **Collapsed groups**, with a count in each header. The page opens as
//     eight readable rows instead of forty checkboxes, and a group tells you
//     whether it holds anything of yours before you open it.
//  4. **The selection, shown back as chips.** A checkbox list makes you
//     reconstruct your answer by scrolling it. The chips are the answer, in
//     column order, each one removable.

export type PickerItem = {
  /** Sent to the export route; a `FieldTarget.field` or a metafield column. */
  id: string;
  label: string;
  details?: string;
  /**
   * Always exported, and not untickable.
   *
   * For the one column a file cannot be read back without: without `Handle` the
   * product export matches nothing on re-import, and quietly producing such a
   * file from the page whose job is importing would be a trap.
   */
  locked?: boolean;
};

export type PickerGroup = {
  name: string;
  items: PickerItem[];
};

/**
 * A named answer to "which columns?".
 *
 * `ids` may name fields this store does not have — a preset is written against
 * the catalogue in general, and the ones that do not exist here are dropped
 * rather than being an error.
 */
export type PickerPreset = {
  name: string;
  ids: string[];
};

type Props = {
  groups: PickerGroup[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  presets?: PickerPreset[];
  /** Noun for the counts, e.g. "column". */
  noun?: string;
};

/** The ids that start out ticked: everything locked, plus a chosen set. */
export function initialSelection(
  groups: PickerGroup[],
  isOn: (item: PickerItem) => boolean,
): Set<string> {
  const selected = new Set<string>();
  for (const group of groups) {
    for (const item of group.items) {
      if (item.locked || isOn(item)) selected.add(item.id);
    }
  }
  return selected;
}

/** Every id in the catalogue, for an "everything" preset. */
export function allIds(groups: PickerGroup[]): string[] {
  return groups.flatMap((group) => group.items.map((item) => item.id));
}

function matches(item: PickerItem, needle: string): boolean {
  if (!needle) return true;
  const haystack = `${item.label} ${item.id} ${item.details ?? ""}`;
  return haystack.toLowerCase().includes(needle);
}

export function FieldPicker({
  groups,
  selected,
  onChange,
  presets = [],
  noun = "column",
}: Props) {
  // Polaris' web components are uncontrolled: `s-checkbox` reads
  // `defaultChecked` once and then owns its own state, so a preset that changed
  // only React state would tick nothing on screen. Bumping this remounts the
  // checkboxes so they read the new state. A single click leaves it alone,
  // which is what stops a checkbox losing focus the moment it is used.
  const [generation, setGeneration] = useState(0);
  const [search, setSearch] = useState("");
  // Seeded once, from the groups that already hold part of the selection —
  // what you picked is never hidden behind a closed row on arrival. It is
  // plain state afterwards, so closing such a group keeps it closed; deriving
  // "open" from the selection on every render would spring it back open the
  // moment it was shut.
  const [opened, setOpened] = useState<Set<string>>(
    () =>
      new Set(
        groups
          .filter((group) => group.items.some((item) => selected.has(item.id)))
          .map((group) => group.name),
      ),
  );

  const needle = search.trim().toLowerCase();
  const searching = needle.length > 0;

  const visible = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          items: group.items.filter((item) => matches(item, needle)),
        }))
        .filter((group) => group.items.length > 0),
    [groups, needle],
  );

  const matchCount = visible.reduce(
    (total, group) => total + group.items.length,
    0,
  );
  const chosen = groups.flatMap((group) =>
    group.items.filter((item) => selected.has(item.id)),
  );

  /** Replace the whole selection, keeping whatever must always be exported. */
  const replace = (ids: Iterable<string>) => {
    const next = new Set(ids);
    for (const group of groups) {
      for (const item of group.items) {
        if (item.locked) next.add(item.id);
      }
    }
    setGeneration((value) => value + 1);
    onChange(next);
  };

  const setMany = (items: PickerItem[], checked: boolean) => {
    const next = new Set(selected);
    for (const item of items) {
      if (item.locked) continue;
      if (checked) next.add(item.id);
      else next.delete(item.id);
    }
    setGeneration((value) => value + 1);
    onChange(next);
  };

  const toggle = (id: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    onChange(next);
  };

  /**
   * Remove from the chips rather than from the checkbox.
   *
   * Unlike a click on the checkbox itself, this has to push the new state back
   * into the checkbox — which is what the remount is for. Without it the chip
   * would vanish while its tick stayed on.
   */
  const removeChip = (id: string) => {
    const next = new Set(selected);
    next.delete(id);
    setGeneration((value) => value + 1);
    onChange(next);
  };

  const applyPreset = (preset: PickerPreset) => {
    const known = new Set(allIds(groups));
    replace(preset.ids.filter((id) => known.has(id)));
  };

  return (
    <s-stack direction="block" gap="base">
      {presets.length > 0 && (
        <s-stack direction="block" gap="small-200">
          <s-text>Start from</s-text>
          <div className={styles.chips}>
            {presets.map((preset) => (
              <s-clickable-chip
                key={preset.name}
                onClick={() => applyPreset(preset)}
              >
                {preset.name}
              </s-clickable-chip>
            ))}
            <s-clickable-chip onClick={() => replace([])}>
              Clear all
            </s-clickable-chip>
          </div>
        </s-stack>
      )}

      {/* `event.target` rather than `currentTarget`: the change is dispatched
          from the input inside the custom element. */}
      <s-search-field
        label={`Find a ${noun}`}
        labelAccessibilityVisibility="exclusive"
        placeholder={`Search ${groups.reduce((total, group) => total + group.items.length, 0)} ${noun}s — try "price", "seo", "custom."`}
        value={search}
        onInput={(event: Event) =>
          setSearch((event.target as HTMLInputElement).value)
        }
      />

      {searching && (
        <div className={styles.toolbar}>
          <s-text>
            {matchCount} {noun}
            {matchCount === 1 ? "" : "s"} match &ldquo;{search.trim()}&rdquo;
          </s-text>
          <s-button
            variant="tertiary"
            onClick={() =>
              setMany(
                visible.flatMap((group) => group.items),
                true,
              )
            }
          >
            Add all matches
          </s-button>
          <s-button
            variant="tertiary"
            onClick={() =>
              setMany(
                visible.flatMap((group) => group.items),
                false,
              )
            }
          >
            Remove all matches
          </s-button>
        </div>
      )}

      <div>
        {visible.length === 0 && (
          <div className={styles.empty}>
            Nothing matches &ldquo;{search.trim()}&rdquo;.
          </div>
        )}

        {visible.map((group) => {
          const groupChosen = group.items.filter((item) =>
            selected.has(item.id),
          ).length;
          // A search opens everything it found, so a match is never hidden
          // behind a closed row.
          const isOpen = searching || opened.has(group.name);

          return (
            <details
              key={group.name}
              className={styles.group}
              open={isOpen}
              onToggle={(event) => {
                // A search forces every match open, and those are not the
                // user's choices — recording them would leave the whole
                // catalogue expanded once the search was cleared.
                if (searching) return;
                const next = new Set(opened);
                if (event.currentTarget.open) next.add(group.name);
                else next.delete(group.name);
                setOpened(next);
              }}
            >
              <summary className={styles.summary}>
                {group.name}
                <span className={styles.count}>
                  {groupChosen} of {group.items.length}
                </span>
              </summary>

              <div className={styles.items}>
                {group.items.map((item) => (
                  <s-checkbox
                    key={`${item.id}:${generation}`}
                    label={item.label}
                    {...(item.details ? { details: item.details } : {})}
                    {...(selected.has(item.id) ? { defaultChecked: true } : {})}
                    {...(item.locked ? { disabled: true } : {})}
                    onChange={(event: { currentTarget: { checked: boolean } }) =>
                      toggle(item.id, event.currentTarget.checked)
                    }
                  />
                ))}
              </div>

              <div className={`${styles.toolbar} ${styles.groupActions}`}>
                <s-button
                  variant="tertiary"
                  onClick={() => setMany(group.items, true)}
                >
                  Select all
                </s-button>
                <s-button
                  variant="tertiary"
                  onClick={() => setMany(group.items, false)}
                >
                  Clear
                </s-button>
              </div>
            </details>
          );
        })}
      </div>

      <s-divider />

      <s-stack direction="block" gap="small-200">
        <s-text>
          <strong>
            {chosen.length} {noun}
            {chosen.length === 1 ? "" : "s"}
          </strong>{" "}
          in the file, in this order:
        </s-text>
        <div className={styles.chips}>
          {chosen.length === 0 && (
            <s-text>Nothing chosen yet — pick a starting point above.</s-text>
          )}
          {chosen.map((item) => (
            <s-chip
              key={item.id}
              {...(item.locked
                ? {}
                : { removable: true, onRemove: () => removeChip(item.id) })}
            >
              {item.label}
            </s-chip>
          ))}
        </div>
      </s-stack>
    </s-stack>
  );
}
