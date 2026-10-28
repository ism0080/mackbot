import type { Html, HtmlBuilder } from "foldkit/html";

import type { Message } from "./message.ts";

export type Inline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "strong"; readonly children: readonly Inline[] }
  | { readonly kind: "em"; readonly children: readonly Inline[] }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "link"; readonly href: string; readonly text: string }
  | { readonly kind: "break" };

export type Block =
  | { readonly kind: "p"; readonly inline: readonly Inline[] }
  | { readonly kind: "ul"; readonly items: readonly (readonly Inline[])[] }
  | {
      readonly kind: "ol";
      readonly start: number;
      readonly items: readonly (readonly Inline[])[];
    }
  | {
      readonly kind: "heading";
      readonly level: 1 | 2 | 3;
      readonly inline: readonly Inline[];
    }
  | { readonly kind: "code"; readonly text: string; readonly language?: string }
  | { readonly kind: "quote"; readonly inline: readonly Inline[] }
  | { readonly kind: "rule" };

/**
 * A chat agent writes GitHub-flavoured Markdown, but the transcript draws its
 * text as one paragraph, so every newline and marker shows up literally. Parsing
 * is kept apart from rendering because the parser is pure: it is the half worth
 * testing against the malformed input a model actually emits, and it knows
 * nothing about Foldkit.
 */
export const parseMarkdown = (text: string): readonly Block[] => {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let at = 0;

  while (at < lines.length) {
    const line = lines[at] ?? "";

    if (line.trim() === "") {
      at += 1;
      continue;
    }

    const fence = fenceOf(line);
    if (fence !== undefined) {
      const body: string[] = [];
      at += 1;
      while (at < lines.length && !closesFence(lines[at] ?? "", fence.marker)) {
        body.push(lines[at] ?? "");
        at += 1;
      }
      // An unclosed fence still reads as code: the model was cut off mid-turn,
      // and showing the rest verbatim beats dropping it into prose.
      if (at < lines.length) at += 1;
      blocks.push({
        kind: "code",
        text: body.join("\n"),
        ...(fence.language === undefined ? {} : { language: fence.language }),
      });
      continue;
    }

    const heading = headingOf(line);
    if (heading !== undefined) {
      blocks.push({ kind: "heading", level: heading.level, inline: parseInline(heading.text) });
      at += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      at += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (at < lines.length && QUOTE.test(lines[at] ?? "")) {
        quoted.push((lines[at] ?? "").replace(QUOTE, ""));
        at += 1;
      }
      blocks.push({ kind: "quote", inline: parseInline(quoted.join("\n")) });
      continue;
    }

    const item = listItemOf(line);
    if (item !== undefined) {
      const list = readList(lines, at, item);
      blocks.push(list.block);
      at = list.next;
      continue;
    }

    const paragraph: string[] = [];
    while (at < lines.length) {
      const current = lines[at] ?? "";
      if (current.trim() === "") break;
      if (paragraph.length > 0 && startsBlock(current)) break;
      paragraph.push(current);
      at += 1;
    }
    blocks.push({ kind: "p", inline: parseInline(paragraph.join("\n")) });
  }

  return blocks;
};

const RULE = /^\s*([-*_])\1{2,}\s*$/;
const QUOTE = /^>\s?/;

type Fence = Readonly<{ marker: string; language: string | undefined }>;

const fenceOf = (line: string): Fence | undefined => {
  const match = /^(`{3,}|~{3,})\s*(.*)$/.exec(line);
  if (match === null) return undefined;

  const marker = match[1] ?? "";
  const info = (match[2] ?? "").split(/\s+/)[0] ?? "";
  const language = info.toLowerCase().replace(/[^\w#+.-]/g, "");

  return { marker, language: language === "" ? undefined : language };
};

const closesFence = (line: string, marker: string): boolean => {
  const trimmed = line.trim();
  const char = marker.charAt(0);
  if (trimmed.length < marker.length) return false;

  for (const current of trimmed) {
    if (current !== char) return false;
  }

  return true;
};

type Heading = Readonly<{ level: 1 | 2 | 3; text: string }>;

const headingOf = (line: string): Heading | undefined => {
  const match = /^(#{1,6})\s+(.*)$/.exec(line);
  if (match === null) return undefined;

  const hashes = (match[1] ?? "").length;
  const level = hashes >= 3 ? 3 : hashes === 2 ? 2 : 1;

  return { level, text: match[2] ?? "" };
};

type ListItem =
  | { readonly kind: "bullet"; readonly text: string }
  | { readonly kind: "ordered"; readonly number: number; readonly text: string };

const listItemOf = (line: string): ListItem | undefined => {
  const bullet = /^[-*+]\s+(.*)$/.exec(line);
  if (bullet !== null) return { kind: "bullet", text: bullet[1] ?? "" };

  const ordered = /^(\d{1,9})[.)]\s+(.*)$/.exec(line);
  if (ordered === null) return undefined;

  return { kind: "ordered", number: Number(ordered[1] ?? "1"), text: ordered[2] ?? "" };
};

const readList = (
  lines: readonly string[],
  from: number,
  first: ListItem,
): Readonly<{ block: Block; next: number }> => {
  const ordered = first.kind === "ordered";
  const start = first.kind === "ordered" ? first.number : 1;
  const items: string[] = [];
  let pending: string | undefined;
  let at = from;

  while (at < lines.length) {
    const line = lines[at] ?? "";
    if (line.trim() === "") break;

    const item = listItemOf(line);
    if (item !== undefined) {
      // A marker of the other kind belongs to a new list, not this one.
      if ((item.kind === "ordered") !== ordered) break;
      if (pending !== undefined) items.push(pending);
      pending = item.text;
      at += 1;
      continue;
    }

    // An item wraps onto indented lines; a line at the margin ends the list.
    if (pending !== undefined && /^\s/.test(line)) {
      pending = `${pending} ${line.trim()}`;
      at += 1;
      continue;
    }

    break;
  }

  if (pending !== undefined) items.push(pending);

  const parsed = items.map((item) => parseInline(item));

  return {
    block:
      first.kind === "ordered"
        ? { kind: "ol", start, items: parsed }
        : { kind: "ul", items: parsed },
    next: at,
  };
};

const startsBlock = (line: string): boolean =>
  fenceOf(line) !== undefined ||
  headingOf(line) !== undefined ||
  RULE.test(line) ||
  QUOTE.test(line) ||
  listItemOf(line) !== undefined;

type Delimiter = Readonly<{ marker: "*" | "_"; width: 1 | 2 }>;

const whitespace = /\s/;
const wordChar = /[\w]/;

const emphasisOpen = (input: string, at: number, delimiter: Delimiter): boolean => {
  const next = input.charAt(at + delimiter.width);
  if (next === "" || whitespace.test(next)) return false;

  // `snake_case` is a word, not emphasis; GFM only honours underscores at a
  // word boundary, and agent prose is full of identifiers.
  if (delimiter.marker === "_" && wordChar.test(input.charAt(at - 1))) return false;

  return true;
};

const emphasisClose = (input: string, delimiter: Delimiter, from: number): number => {
  const { marker, width } = delimiter;
  let at = from;

  while (at < input.length) {
    if (input.charAt(at) !== marker) {
      at += 1;
      continue;
    }

    let end = at;
    while (input.charAt(end) === marker) end += 1;

    // The closing run must be exactly the marker's width, so the `**` of a
    // bold run cannot end an italic one opened with a single `*`.
    const closes =
      end - at === width &&
      at > from &&
      !whitespace.test(input.charAt(at - 1)) &&
      (marker !== "_" || !wordChar.test(input.charAt(end)));

    if (closes) return at;
    at = end;
  }

  return -1;
};

const codeClose = (input: string, fence: string, from: number): number => {
  let at = input.indexOf(fence, from);

  while (at !== -1) {
    let end = at;
    while (input.charAt(end) === "`") end += 1;
    if (end - at === fence.length) return at;
    at = input.indexOf(fence, end);
  }

  return -1;
};

const codeText = (raw: string): string =>
  raw.startsWith(" ") && raw.endsWith(" ") && raw.trim() !== "" ? raw.slice(1, -1) : raw;

/**
 * A bare URL in running text. Only absolute `http(s)` links count: a `www.`
 * form would need a word boundary against the text buffer, and every link a
 * bot writes here (an approval URL, say) is absolute already.
 */
const AUTOLINK = /https?:\/\/[^\s<>()"'`]+/giu;

/** Sentence punctuation that follows a URL rather than belonging to it. */
const TRAILING = /[.,;:!?\])*_]+$/u;

/**
 * Split a run of plain text into text and link nodes. This is the difference
 * between an approval URL rendered as a chip a person can tap and the same URL
 * as unclickable words in a paragraph.
 */
const textNodes = (text: string): readonly Inline[] => {
  const nodes: Inline[] = [];
  let rest = text;

  while (rest !== "") {
    // The pattern is global, so its cursor has to be rewound: every pass runs
    // against a different slice of the text.
    AUTOLINK.lastIndex = 0;
    const match = AUTOLINK.exec(rest);
    if (match === null) {
      nodes.push({ kind: "text", text: rest });
      break;
    }

    const raw = match[0];
    const href = raw.replace(TRAILING, "");
    if (match.index > 0) nodes.push({ kind: "text", text: rest.slice(0, match.index) });

    if (href === "") {
      nodes.push({ kind: "text", text: raw });
    } else {
      nodes.push({ kind: "link", href, text: href });
      // Whatever the URL did not own rides along, so nothing is dropped.
      if (raw.length > href.length) nodes.push({ kind: "text", text: raw.slice(href.length) });
    }

    rest = rest.slice(match.index + raw.length);
  }

  return nodes;
};

/** How many characters a newline ends up consuming: the spaces or backslash of
 *  a hard break, or zero when the newline is a soft one. */
const hardBreakTail = (text: string): number => {
  const spaces = / +$/.exec(text);
  if (spaces !== null && spaces[0].length >= 2) return spaces[0].length;

  const slashes = /\\+$/.exec(text);
  if (slashes !== null && slashes[0].length % 2 === 1) return 1;

  return 0;
};

const parseInline = (input: string): readonly Inline[] => {
  const nodes: Inline[] = [];
  let buffer = "";

  const flush = (): void => {
    if (buffer !== "") {
      nodes.push(...textNodes(buffer));
      buffer = "";
    }
  };

  const push = (node: Inline): void => {
    flush();
    nodes.push(node);
  };

  let at = 0;

  while (at < input.length) {
    const char = input.charAt(at);

    if (char === "\n") {
      const strip = hardBreakTail(buffer);
      if (strip > 0) {
        buffer = buffer.slice(0, buffer.length - strip);
        push({ kind: "break" });
      } else {
        buffer = `${buffer.replace(/[ \t]+$/, "")} `;
      }
      at += 1;
      while (at < input.length && (input.charAt(at) === " " || input.charAt(at) === "\t")) at += 1;
      continue;
    }

    if (char === "`") {
      let end = at;
      while (input.charAt(end) === "`") end += 1;
      const fence = input.slice(at, end);
      const close = codeClose(input, fence, end);

      if (close === -1) {
        buffer += fence;
        at = end;
        continue;
      }

      push({ kind: "code", text: codeText(input.slice(end, close)) });
      at = close + fence.length;
      continue;
    }

    if (char === "*" || char === "_") {
      const marker = char;
      const width: 1 | 2 = input.charAt(at + 1) === marker ? 2 : 1;
      const delimiter: Delimiter = { marker, width };

      const close = emphasisOpen(input, at, delimiter)
        ? emphasisClose(input, delimiter, at + width)
        : -1;

      if (close === -1) {
        buffer += marker;
        at += 1;
        continue;
      }

      const children = parseInline(input.slice(at + width, close));
      push({ kind: width === 2 ? "strong" : "em", children });
      at = close + width;
      continue;
    }

    if (char === "[") {
      const match = /^\[([^[\]]*)\]\(([^()\s]*)\)/.exec(input.slice(at));
      if (match !== null) {
        push({ kind: "link", href: match[2] ?? "", text: match[1] ?? "" });
        at += match[0].length;
        continue;
      }

      buffer += char;
      at += 1;
      continue;
    }

    buffer += char;
    at += 1;
  }

  flush();
  return nodes;
};

/** A text inline is a bare string child rather than an element, which is what
 *  keeps model output a text node instead of markup. */
type InlineHtml = Html | string;

const inlineNodes = <M>(inline: readonly Inline[], h: HtmlBuilder<M>): readonly InlineHtml[] =>
  inline.map((node) => inlineNode(node, h));

const inlineNode = <M>(node: Inline, h: HtmlBuilder<M>): InlineHtml => {
  switch (node.kind) {
    case "text":
      return node.text;
    case "strong":
      return h.strong([], inlineNodes(node.children, h));
    case "em":
      return h.em([], inlineNodes(node.children, h));
    case "code":
      return h.code([], [node.text]);
    case "link":
      // The app routes link clicks itself, so no target: a new browsing context
      // is opened by update, not by the DOM.
      return h.a([h.Href(node.href), h.Rel("noreferrer noopener")], [node.text]);
    case "break":
      return h.br([]);
  }
};

const TRIVIAL_TAIL = /^[\s\p{P}]*$/u;

/** A paragraph that is nothing but one link becomes a full-width chip, but a
 *  sentence that happens to end in a link stays prose. Trailing punctuation
 *  rides along so nothing is dropped. */
const linkRowOf = (inline: readonly Inline[]): readonly Inline[] | undefined => {
  const [head, ...tail] = inline;
  if (head === undefined || head.kind !== "link") return undefined;
  if (!tail.every((node) => node.kind === "text" && TRIVIAL_TAIL.test(node.text))) return undefined;

  return inline;
};

const listItems = <M>(items: readonly (readonly Inline[])[], h: HtmlBuilder<M>): readonly Html[] =>
  items.map((item) => h.li([], inlineNodes(item, h)));

const headingNode = <M>(node: Extract<Block, { kind: "heading" }>, h: HtmlBuilder<M>): Html => {
  switch (node.level) {
    case 1:
      return h.h1([], inlineNodes(node.inline, h));
    case 2:
      return h.h2([], inlineNodes(node.inline, h));
    case 3:
      return h.h3([], inlineNodes(node.inline, h));
  }
};

const blockNode = <M>(block: Block, h: HtmlBuilder<M>): Html => {
  switch (block.kind) {
    case "p": {
      const row = linkRowOf(block.inline);
      return row === undefined
        ? h.p([], inlineNodes(block.inline, h))
        : h.p([h.Class("md-link-row")], inlineNodes(row, h));
    }
    case "ul":
      return h.ul([], listItems(block.items, h));
    case "ol":
      return block.start === 1
        ? h.ol([], listItems(block.items, h))
        : h.ol([h.Start(block.start)], listItems(block.items, h));
    case "heading":
      return headingNode(block, h);
    case "code":
      return h.pre(
        [],
        [
          h.code(
            block.language === undefined ? [] : [h.DataAttribute("language", block.language)],
            [block.text],
          ),
        ],
      );
    case "quote":
      return h.blockquote([], [h.p([], inlineNodes(block.inline, h))]);
    case "rule":
      return h.hr([]);
  }
};

/**
 * The renderer never dispatches, so it takes any frame's builder; the default
 * keeps the app's `Message` in the signature callers read.
 */
export const renderMarkdown = <BuilderMessage = Message>(
  blocks: readonly Block[],
  h: HtmlBuilder<BuilderMessage>,
): readonly Html[] => blocks.map((block) => blockNode(block, h));
