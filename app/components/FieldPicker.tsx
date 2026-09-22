import { useState } from "react";

// Grouped checkboxes over a list of columns, with select-all per group.
//
// Shared by the two exports that let the user choose their own columns — the
// product export on `app.product-update.tsx` and the variant metafield export
// on `app.variant-metafields.tsx`. They pick from different catalogues but ask
// the same question, and a second copy of this would be the place the two
// drifted apart.

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

type Props = {
  groups: PickerGroup[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
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

export function FieldPicker({ groups, selected, onChange }: Props) {
  // Polaris' web components are uncontrolled: `s-checkbox` reads `defaultChecked`
  // once and then owns its own state, so a "select all" that changed only React
  // state would tick nothing on screen. Bumping this remounts the checkboxes so
  // they read the new state. Individual toggles leave it alone, which is what
  // stops a checkbox losing focus the moment it is clicked.
  const [generation, setGeneration] = useState(0);

  const setAll = (items: PickerItem[], checked: boolean) => {
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

  return (
    <s-stack direction="block" gap="large">
      {groups.map((group) => {
        const chosen = group.items.filter((item) =>
          selected.has(item.id),
        ).length;

        return (
          <s-stack key={group.name} direction="block" gap="small-200">
            <s-heading>
              {group.name} ({chosen}/{group.items.length})
            </s-heading>

            <s-stack direction="inline" gap="small-200">
              <s-button
                variant="tertiary"
                onClick={() => setAll(group.items, true)}
              >
                Select all
              </s-button>
              <s-button
                variant="tertiary"
                onClick={() => setAll(group.items, false)}
              >
                Clear
              </s-button>
            </s-stack>

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
          </s-stack>
        );
      })}
    </s-stack>
  );
}
