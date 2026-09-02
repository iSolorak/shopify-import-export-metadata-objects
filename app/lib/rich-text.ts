// HTML ⇄ Shopify `rich_text_field` JSON.
//
// A rich text metafield stores a JSON document, not markup. Shopify's own CSV
// import expects that JSON in the cell, which is why pasting formatted copy
// into a spreadsheet does not work: the value is unreadable, unauthorable, and
// one stray character makes the whole row invalid.
//
// So this module makes HTML the interchange format. Merchants write (or paste
// from a CMS) ordinary markup, and the conversion to Shopify's document shape
// happens here. Export runs the same mapping backwards, so a file this app
// produced is a file it can read back.
//
// Hand-rolled rather than pulled from npm, matching `csv.ts`: the supported
// vocabulary is small and fixed by what `rich_text_field` can represent, and a
// general HTML parser would carry a DOM this never touches.

/** The subset of HTML that maps onto the rich text document shape. */
export const SUPPORTED_TAGS =
  "p, h1–h6, ul, ol, li, strong/b, em/i, a, br";

// ---------------------------------------------------------------------------
// Document shape
// ---------------------------------------------------------------------------

export type RichTextText = {
  type: "text";
  value: string;
  bold?: boolean;
  italic?: boolean;
};

export type RichTextLink = {
  type: "link";
  url: string;
  title: string;
  children: RichTextText[];
};

export type RichTextInline = RichTextText | RichTextLink;

export type RichTextParagraph = {
  type: "paragraph";
  children: RichTextInline[];
};

export type RichTextHeading = {
  type: "heading";
  level: number;
  children: RichTextInline[];
};

export type RichTextListItem = {
  type: "list-item";
  children: RichTextInline[];
};

export type RichTextList = {
  type: "list";
  listType: "ordered" | "unordered";
  children: RichTextListItem[];
};

export type RichTextBlock = RichTextParagraph | RichTextHeading | RichTextList;

export type RichTextRoot = { type: "root"; children: RichTextBlock[] };

// ---------------------------------------------------------------------------
// A minimal HTML tokenizer
// ---------------------------------------------------------------------------

type HtmlNode =
  | { kind: "text"; value: string }
  | { kind: "element"; tag: string; attrs: Record<string, string>; children: HtmlNode[] };

/** Tags that never have a closing partner, so they must not open a scope. */
const VOID_TAGS = new Set([
  "br",
  "hr",
  "img",
  "input",
  "meta",
  "link",
  "source",
  "wbr",
]);

/**
 * Named entities, decoded before anything else looks at the text.
 *
 * This covers the HTML 4 Latin-1 set rather than just the famous five. An
 * entity left undecoded would survive as literal text and be re-escaped to
 * `&amp;eacute;` on the way back out, quietly corrupting every accented word —
 * and accented words are exactly what this feature carries.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  // Punctuation a CMS or word processor emits.
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201C",
  rdquo: "\u201D",
  bull: "\u2022",
  trade: "\u2122",
  euro: "\u20AC",
};

// Latin-1 supplement (U+00A0-U+00FF). Generated rather than typed out: the
// names run in the same order as the code points, so the table is mechanical
// and a hand-written one would only be an opportunity for a typo.
const LATIN1_ENTITY_NAMES =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(
    " ",
  );

LATIN1_ENTITY_NAMES.forEach((name, index) => {
  // &nbsp; becomes an ordinary space: a non-breaking space that survived into
  // a metafield value would be invisible in the admin and impossible to search
  // for, and nothing here needs to preserve the distinction.
  NAMED_ENTITIES[name] = index === 0 ? " " : String.fromCharCode(0x00a0 + index);
});

function decodeEntities(text: string): string {
  // The name may contain digits — `frac12`, `sup2` — so it is not letters only.
  return text.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, body: string) => {
      if (body[0] === "#") {
        const codePoint =
          body[1] === "x" || body[1] === "X"
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
        // A malformed numeric entity is left as written rather than turned into
        // a replacement character that would silently corrupt the copy.
        if (!Number.isFinite(codePoint) || codePoint <= 0) return match;
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return match;
        }
      }
      // Exact case first: the accented names are case-sensitive, and `&Eacute;`
      // and `&eacute;` are different characters. The lowercase fallback only
      // catches the ASCII names, where sloppy casing is common and harmless.
      return (
        NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? match
      );
    },
  );
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const name = match[1].toLowerCase();
    let value = match[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    attrs[name] = decodeEntities(value);
  }

  return attrs;
}

/**
 * Parse HTML into a tree.
 *
 * Deliberately forgiving: a stray closing tag with no matching open is dropped,
 * and tags still open at the end are closed implicitly. Merchant-pasted markup
 * from a CMS is routinely unbalanced, and refusing the whole row over it would
 * be worse than importing the text it clearly meant.
 */
function parseHtml(html: string): HtmlNode[] {
  const root: HtmlNode = { kind: "element", tag: "#root", attrs: {}, children: [] };
  const stack: Extract<HtmlNode, { kind: "element" }>[] = [root as never];
  const top = () => stack[stack.length - 1];

  let index = 0;
  while (index < html.length) {
    const next = html.indexOf("<", index);

    if (next === -1) {
      const text = decodeEntities(html.slice(index));
      if (text) top().children.push({ kind: "text", value: text });
      break;
    }

    if (next > index) {
      const text = decodeEntities(html.slice(index, next));
      if (text) top().children.push({ kind: "text", value: text });
    }

    // Comments and doctypes carry nothing this format can express.
    if (html.startsWith("<!--", next)) {
      const end = html.indexOf("-->", next);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", next)) {
      const end = html.indexOf(">", next);
      index = end === -1 ? html.length : end + 1;
      continue;
    }

    const end = html.indexOf(">", next);
    if (end === -1) {
      // An unterminated tag at the very end: treat the rest as text so the
      // copy is not silently truncated.
      const text = decodeEntities(html.slice(next));
      if (text) top().children.push({ kind: "text", value: text });
      break;
    }

    const raw = html.slice(next + 1, end).trim();
    index = end + 1;
    if (!raw) continue;

    if (raw[0] === "/") {
      const tag = raw.slice(1).trim().toLowerCase();
      // Close up to the matching open tag, if there is one. Searching the whole
      // stack lets `<p><em>text</p>` close the unclosed <em> along the way.
      const depth = stack.findIndex((node) => node.tag === tag);
      if (depth > 0) stack.length = depth;
      continue;
    }

    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const space = body.search(/\s/);
    const tag = (space === -1 ? body : body.slice(0, space)).toLowerCase();
    const attrs = space === -1 ? {} : parseAttributes(body.slice(space));

    const element: Extract<HtmlNode, { kind: "element" }> = {
      kind: "element",
      tag,
      attrs,
      children: [],
    };
    top().children.push(element);

    // <li> and <p> are routinely left unclosed; an open one is ended by the
    // next sibling of the same kind rather than nesting inside it.
    if (!selfClosing && !VOID_TAGS.has(tag)) {
      if ((tag === "li" || tag === "p") && top().tag === tag) stack.pop();
      stack.push(element);
    }
  }

  return root.kind === "element" ? root.children : [];
}

// ---------------------------------------------------------------------------
// HTML → rich text
// ---------------------------------------------------------------------------

const HEADING_TAGS: Record<string, number> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

/** Tags that start a new block rather than contributing inline content. */
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "ul",
  "ol",
  "li",
  "blockquote",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "table",
  "tr",
  "td",
  "th",
  ...Object.keys(HEADING_TAGS),
]);

type Marks = { bold: boolean; italic: boolean };

/**
 * Collect the inline content of an element.
 *
 * `<br>` has no counterpart in the rich text vocabulary, so it is reported back
 * to the caller as a break between runs and becomes a paragraph boundary.
 */
function collectInline(nodes: HtmlNode[], marks: Marks): RichTextInline[][] {
  const runs: RichTextInline[][] = [[]];
  const current = () => runs[runs.length - 1];

  const pushText = (value: string, active: Marks) => {
    if (!value) return;
    const last = current()[current().length - 1];
    // Merge with the previous run when the formatting matches, so
    // `<strong>a</strong><strong>b</strong>` is one node rather than two.
    if (
      last &&
      last.type === "text" &&
      Boolean(last.bold) === active.bold &&
      Boolean(last.italic) === active.italic
    ) {
      last.value += value;
      return;
    }
    current().push({
      type: "text",
      value,
      ...(active.bold ? { bold: true } : {}),
      ...(active.italic ? { italic: true } : {}),
    });
  };

  const walk = (list: HtmlNode[], active: Marks) => {
    for (const node of list) {
      if (node.kind === "text") {
        // HTML collapses whitespace runs, and a CSV cell holding markup is
        // usually wrapped across lines by whatever produced it.
        pushText(node.value.replace(/\s+/g, " "), active);
        continue;
      }

      if (node.tag === "br") {
        runs.push([]);
        continue;
      }

      if (node.tag === "a") {
        const url = node.attrs.href ?? "";
        // A link with no href cannot round trip; keep the words, drop the link.
        if (!url) {
          walk(node.children, active);
          continue;
        }
        const inner = collectInline(node.children, active)
          .flat()
          // Rich text does not allow a link inside a link, so a nested one is
          // flattened to the text it wrapped.
          .flatMap((child): RichTextText[] =>
            child.type === "text" ? [child] : child.children,
          );
        if (!inner.length) continue;
        current().push({
          type: "link",
          url,
          // The title is what a screen reader announces. Falling back to the
          // visible words beats emitting an empty string.
          title: node.attrs.title ?? inner.map((text) => text.value).join(""),
          children: inner,
        });
        continue;
      }

      const nested: Marks = {
        bold: active.bold || node.tag === "strong" || node.tag === "b",
        italic: active.italic || node.tag === "em" || node.tag === "i",
      };
      // Anything else — span, u, font, unknown custom tags — contributes its
      // text. Dropping the element entirely would lose copy the merchant wrote.
      walk(node.children, nested);
    }
  };

  walk(nodes, marks);

  return runs.map(trimRun).filter((run) => run.length > 0);
}

/** Drop the leading and trailing whitespace a block boundary makes meaningless. */
function trimRun(run: RichTextInline[]): RichTextInline[] {
  const nodes = run.slice();

  const first = nodes[0];
  if (first?.type === "text") first.value = first.value.replace(/^\s+/, "");
  const last = nodes[nodes.length - 1];
  if (last?.type === "text") last.value = last.value.replace(/\s+$/, "");

  return nodes.filter(
    (node) => node.type !== "text" || node.value.length > 0,
  );
}

function collectListItems(nodes: HtmlNode[]): RichTextListItem[] {
  const items: RichTextListItem[] = [];

  for (const node of nodes) {
    if (node.kind !== "element" || node.tag !== "li") continue;
    // A list item holds inline content only, so a <br> inside one is joined
    // back into a single run rather than splitting the bullet in two.
    const children = collectInline(node.children, {
      bold: false,
      italic: false,
    }).flat();
    if (children.length) items.push({ type: "list-item", children });
  }

  return items;
}

export function htmlToRichText(html: string): RichTextRoot {
  const blocks: RichTextBlock[] = [];

  // Inline content sitting directly at the top level (`Hello <b>world</b>`
  // with no wrapper) still has to land somewhere, so it accumulates here and
  // is flushed as a paragraph at the next block boundary.
  let loose: HtmlNode[] = [];
  const flushLoose = () => {
    if (!loose.length) return;
    for (const run of collectInline(loose, { bold: false, italic: false })) {
      blocks.push({ type: "paragraph", children: run });
    }
    loose = [];
  };

  const walk = (nodes: HtmlNode[]) => {
    for (const node of nodes) {
      if (node.kind === "text" || !BLOCK_TAGS.has(node.tag)) {
        loose.push(node);
        continue;
      }

      flushLoose();

      const level = HEADING_TAGS[node.tag];
      if (level) {
        const children = collectInline(node.children, {
          bold: false,
          italic: false,
        }).flat();
        if (children.length) blocks.push({ type: "heading", level, children });
        continue;
      }

      if (node.tag === "ul" || node.tag === "ol") {
        const children = collectListItems(node.children);
        if (children.length) {
          blocks.push({
            type: "list",
            listType: node.tag === "ol" ? "ordered" : "unordered",
            children,
          });
        }
        continue;
      }

      // A structural wrapper (div, section, table cell...) is not itself a
      // paragraph; recursing keeps the blocks it contains at the top level
      // instead of flattening them into one run.
      if (node.tag !== "p" && node.tag !== "blockquote" && node.tag !== "li") {
        walk(node.children);
        continue;
      }

      for (const run of collectInline(node.children, {
        bold: false,
        italic: false,
      })) {
        blocks.push({ type: "paragraph", children: run });
      }
    }
  };

  walk(parseHtml(html));
  flushLoose();

  return { type: "root", children: blocks };
}

/**
 * Convert a CSV cell to the string `metafieldsSet` expects.
 *
 * A cell already holding rich text JSON is passed through untouched, so a file
 * exported by Shopify's own tooling still imports.
 */
export function cellToRichTextValue(cell: string): string {
  const trimmed = cell.trim();

  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(
        "The value starts with { so it was read as rich text JSON, but it is not valid JSON.",
      );
    }
    if ((parsed as { type?: string })?.type !== "root") {
      throw new Error('Rich text JSON must be an object with "type": "root".');
    }
    return JSON.stringify(parsed);
  }

  const document = htmlToRichText(trimmed);
  if (!document.children.length) {
    throw new Error(
      `No text found. Rich text needs at least one paragraph — supported markup is ${SUPPORTED_TAGS}.`,
    );
  }

  return JSON.stringify(document);
}

// ---------------------------------------------------------------------------
// Rich text → HTML
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineToHtml(node: RichTextInline): string {
  if (node.type === "link") {
    const title = node.title ? ` title="${escapeHtml(node.title)}"` : "";
    return `<a href="${escapeHtml(node.url)}"${title}>${node.children
      .map(inlineToHtml)
      .join("")}</a>`;
  }

  let html = escapeHtml(node.value);
  // Italic inside bold, so nesting is stable and two exports of the same value
  // are byte-identical.
  if (node.italic) html = `<em>${html}</em>`;
  if (node.bold) html = `<strong>${html}</strong>`;
  return html;
}

function blockToHtml(node: RichTextBlock): string {
  if (node.type === "heading") {
    const level = Math.min(Math.max(node.level || 1, 1), 6);
    return `<h${level}>${node.children.map(inlineToHtml).join("")}</h${level}>`;
  }

  if (node.type === "list") {
    const tag = node.listType === "ordered" ? "ol" : "ul";
    const items = node.children
      .map((item) => `<li>${item.children.map(inlineToHtml).join("")}</li>`)
      .join("");
    return `<${tag}>${items}</${tag}>`;
  }

  return `<p>${node.children.map(inlineToHtml).join("")}</p>`;
}

/**
 * Render a stored rich text value as HTML for the export CSV.
 *
 * Returns the raw value unchanged if it is not parseable rich text: an export
 * that shows what is actually stored is more useful than one that hides a
 * value this app did not expect.
 */
export function richTextValueToHtml(value: string): string {
  if (!value.trim()) return "";

  let parsed: { type?: string; children?: unknown[] };
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  if (parsed?.type !== "root" || !Array.isArray(parsed.children)) return value;

  // Shopify's documentation shows headings and lists nested inside a paragraph,
  // while the admin editor writes them as siblings of one. Both shapes occur in
  // real stores, so nested blocks are hoisted rather than dropped.
  const blocks: RichTextBlock[] = [];
  const collect = (nodes: unknown[]) => {
    for (const node of nodes as RichTextBlock[]) {
      if (!node || typeof node !== "object") continue;
      if (node.type === "paragraph") {
        const nested = (node.children ?? []).filter((child) => {
          const type = (child as { type?: string })?.type;
          return type === "heading" || type === "list";
        });
        if (nested.length) {
          collect(node.children as unknown[]);
          continue;
        }
      }
      blocks.push(node);
    }
  };
  collect(parsed.children);

  return blocks.map(blockToHtml).join("");
}
