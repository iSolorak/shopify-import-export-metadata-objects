# Design system

What this app's UI is built from, and the numbers Shopify actually uses.

Everything below is taken from Shopify's published sources, not estimated:

- **Token values** — `@shopify/polaris-tokens`, `dist/css/styles.css`
  (`https://unpkg.com/@shopify/polaris-tokens@latest/dist/css/styles.css`).
- **Component API** — `node_modules/@shopify/polaris-types/dist/polaris.d.ts`,
  which is the contract this app compiles against.
- **Markup validated** against Polaris App Home **v1.0** via Shopify's
  `validate_component_codeblocks`.

---

## 1. The rule that matters most

**Do not style Polaris components.** `s-page`, `s-section`, `s-button`,
`s-table` and the rest render inside shadow DOM. Your CSS cannot reach them, and
the attempts that look like they work are actually fighting the admin's theme.

Use the component's own props — `padding`, `gap`, `tone`, `variant`, `color` —
and the design-token file only for the light-DOM wrappers this app still owns
(`app/components/ui/*.module.css`).

---

## 2. Spacing

A **4px grid**. Polaris exposes it twice under different names, and the two are
easy to confuse:

| Polaris CSS token | Value | Used for                    |
| ----------------- | ----- | --------------------------- |
| `--p-space-0`     | 0     |                             |
| `--p-space-025`   | 1px   |                             |
| `--p-space-050`   | 2px   |                             |
| `--p-space-100`   | 4px   | hairline gaps               |
| `--p-space-150`   | 6px   | table cell padding          |
| `--p-space-200`   | 8px   | **button group gap**        |
| `--p-space-300`   | 12px  | compact rows, card grid gap |
| `--p-space-400`   | 16px  | **card padding, card gap**  |
| `--p-space-500`   | 20px  |                             |
| `--p-space-600`   | 24px  | section separation          |
| `--p-space-800`   | 32px  | major breaks                |
| `--p-space-1000`+ | 40px+ | page-level whitespace       |

### The keyword scale

Web components take **keywords**, not these token names, for `gap`, `padding`
and `size`:

```
small-500 · small-400 · small-300 · small-200 · small-100 · small ·
base ·
large · large-100 · large-200 · large-300 · large-400 · large-500
```

Shopify does not publish a px value for every keyword. The only mapping they
document is in the checkout/customer-account spacer migration guides, against
the old named scale:

| Old name      | px  | Keyword     |
| ------------- | --- | ----------- |
| `none`        | 0   | `none`      |
| `extraTight`  | 4   | `small-400` |
| `tight`       | 8   | `small-200` |
| `base`        | 16  | `base`      |
| `loose`       | 20  | `large-200` |
| `extraLoose`  | 32  | `large-500` |

The steps in between (`small-500`, `small-300`, `small-100`, `small`, `large`,
`large-100`, `large-300`, `large-400`) exist but have no published px value —
treat them as relative, and do not try to line one up with a CSS token by eye.

**`base` is the default to reach for**; this app uses `base` for stacks and
`small-200`/`small-300` for tight rows of badges and paragraphs.

Shopify also defines named aliases, which say what a number is for:

| Alias                          | Resolves to | Meaning                |
| ------------------------------ | ----------- | ---------------------- |
| `--p-space-card-padding`       | 16px        | padding inside a card  |
| `--p-space-card-gap`           | 16px        | gap between card items |
| `--p-space-button-group-gap`   | 8px         | gap between buttons    |
| `--p-space-table-cell-padding` | 6px         | table cell padding     |

> The button-group gap is **8px**, not 12px. Every hand-rolled `.actions` row in
> this app used 12px, which is why button rows read one notch looser than the
> admin's. `s-button-group` gets it right for free.

---

## 3. Typography

**Inter**, loaded in `app/root.tsx` from
`https://cdn.shopify.com/static/fonts/inter/v4/styles.css`.

```
--p-font-family-sans: 'Inter', -apple-system, BlinkMacSystemFont,
                      'San Francisco', 'Segoe UI', Roboto,
                      'Helvetica Neue', sans-serif
--p-font-family-mono: ui-monospace, SFMono-Regular, 'SF Mono', Consolas,
                      'Liberation Mono', Menlo, monospace
```

### Weights — not the usual numbers

| Token                      | Value   |
| -------------------------- | ------- |
| `--p-font-weight-regular`  | **450** |
| `--p-font-weight-medium`   | **550** |
| `--p-font-weight-semibold` | **650** |
| `--p-font-weight-bold`     | **700** |

The admin runs variable Inter and sits every step **50 units heavier** than the
conventional 400/500/600/700. This is why a hand-written `font-weight: 600` next
to a Polaris component looks subtly too light — it should be `650`.

### Sizes

| Token             | rem      | px  |
| ----------------- | -------- | --- |
| `--p-font-size-275` | 0.6875 | 11  |
| `--p-font-size-300` | 0.75   | 12  |
| `--p-font-size-325` | 0.8125 | 13  |
| `--p-font-size-350` | 0.875  | 14  |
| `--p-font-size-400` | 1      | 16  |
| `--p-font-size-450` | 1.125  | 18  |
| `--p-font-size-500` | 1.25   | 20  |
| `--p-font-size-600` | 1.5    | 24  |
| `--p-font-size-750` | 1.875  | 30  |
| `--p-font-size-900` | 2.25   | 36  |

### Text roles (desktop)

Resolved from the base `:root` block of the token sheet:

| Role          | Size     | Line height | Weight         |
| ------------- | -------- | ----------- | -------------- |
| `body-xs`     | 11px     | 12px        | regular (450)  |
| `body-sm`     | 12px     | 16px        | regular        |
| **`body-md`** | **13px** | **20px**    | **regular**    |
| `body-lg`     | 14px     | 20px        | regular        |
| `heading-xs`  | 12px     | 16px        | semibold (650) |
| `heading-sm`  | 13px     | 20px        | semibold       |
| `heading-md`  | 14px     | 20px        | semibold       |
| `heading-lg`  | 20px     | 24px        | semibold       |
| `heading-xl`  | 24px     | 32px        | bold (700)     |
| `heading-2xl` | 30px     | 40px        | bold           |
| `heading-3xl` | 36px     | 48px        | bold           |

**`body-md` — 13px on a 20px line — is the admin's default reading size.** It
looks small quoted as a number and reads comfortably in place, because the line
height carries it. Do not scale it up to 14 or 16 to "match the web"; it will
read as a different product sitting next to admin chrome.

> **Mobile is a different scale.** The sheet redefines every role under
> `.p-theme-light-mobile` / `.p-theme-dark-mobile`, roughly one step larger —
> `body-md` becomes 16px/24px, `heading-lg` 18px/24px. Polaris components handle
> this themselves. It is a reason not to hard-code a font size in a wrapper: a
> literal `13px` stays 13px on a phone, where the admin around it has grown.

Line-height tokens are `--p-font-line-height-300` (12px) through `-1200` (48px),
in 4px steps.

---

## 4. Shape

| Token                    | Value       |
| ------------------------ | ----------- |
| `--p-border-radius-100`  | 4px         |
| `--p-border-radius-200`  | 8px         |
| `--p-border-radius-300`  | 12px        |
| `--p-border-radius-full` | pill        |
| `--p-border-width-025`   | 1px         |

---

## 5. Using the tokens in this app

`app/styles/tokens.css` defines every value above as a local custom property,
reading Polaris' own `--p-*` first and falling back to the literal:

```css
--sp-400: var(--p-space-400, 1rem);
```

The `--p-*` properties are **not contractually exposed to app iframes**, so the
fallback is the value that usually applies. Written this way, the wrappers track
Shopify automatically if the tokens ever are in scope, and are correct if they
are not. Never write a raw hex or px value in a module stylesheet — use the
variable, so there is one place to change when Shopify retunes a shade.

---

## 6. The shared UI kit

`app/components/ui/`:

| Component                       | Replaces                                              |
| ------------------------------- | ----------------------------------------------------- |
| `Guide`                         | inline walls of explanatory paragraphs                |
| `TaskGrid`                      | the flat nav as the only map of the app               |
| `Steps`                         | nothing — the two-step import used to be a surprise   |
| `CsvDropZone`                   | `<input type="file">` + ~40 lines of CSS per page     |
| `Actions`                       | hand-rolled `.actions` flexbox rows (at the wrong gap) |
| `PlanSummary`                   | per-page arrangements of count badges                 |
| `TableScroll` / `TruncationNote`| per-page copies of the same scroller and sentence     |

### Guides are load-bearing

Every page here needs two to four paragraphs before its form makes sense. That
text is the most valuable thing on the page the first time and the most
in-the-way thing the hundredth, so `Guide` keeps its prominence and drops its
permanence: it renders expanded, collapses to one line, and remembers the choice
per guide in `localStorage`.

It is a native `<details>`, which means it is keyboard-operable, findable by
in-page browser search **while collapsed**, and still fully readable if the
script never runs. Do not delete guide copy to make a page shorter — collapse it.

---

## 7. Page conventions

- One `s-page` per route, `heading` only. **`s-page` has no `subheading` slot in
  Polaris v1.0** — a page-level description goes in a `<s-paragraph
  color="subdued">` leading the first section.
- Section order on an import page: **Export → Import → Review → Finished**.
- A review step opens with `<Steps>` and an info banner promising nothing has
  been written. Keep that promise out of the section heading — as a heading it
  is long enough to skim past.
- One primary button per section. Everything else is default or tertiary.
- Wide tables go in `<TableScroll>` with `s-table variant="auto"` and `listSlot`
  on the headers, so narrow screens get readable rows instead of sideways scroll.
- Never let content widen the iframe: the admin's chrome goes with it.

---

## 8. Checking your work

```bash
npm run typecheck   # the Polaris types are the real contract
npm run lint
npm run build
```

For markup, Shopify's MCP validator is authoritative:
`validate_component_codeblocks` with `api: "polaris-app-home"`. It catches
invalid icon names, bad prop values, and components that do not exist on this
surface — none of which TypeScript alone will flag inside a template string.
