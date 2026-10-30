import { Option } from "effect";
import { inertHtml } from "foldkit/html";
import { attr, findAll, textContent } from "foldkit/scene";
import { describe, expect, test } from "vitest";

import { parseMarkdown, renderMarkdown } from "../src/markdown.ts";

const html = (markdown: string) => {
  const root = inertHtml.div([], renderMarkdown(parseMarkdown(markdown), inertHtml));
  if (root === null) throw new Error("a div always renders a node");

  return root;
};

describe("parseMarkdown", () => {
  test("a single newline inside a paragraph is a soft break", () => {
    expect(parseMarkdown("wrapped\nline")).toEqual([
      { kind: "p", inline: [{ kind: "text", text: "wrapped line" }] },
    ]);
  });

  test("two trailing spaces or a trailing backslash force a line break", () => {
    const broken: readonly unknown[] = [
      {
        kind: "p",
        inline: [{ kind: "text", text: "a" }, { kind: "break" }, { kind: "text", text: "b" }],
      },
    ];

    expect(parseMarkdown("a  \nb")).toEqual(broken);
    expect(parseMarkdown("a\\\nb")).toEqual(broken);
  });

  test("bold wins over italic, and nesting keeps every word", () => {
    expect(parseMarkdown("**x**")).toEqual([
      { kind: "p", inline: [{ kind: "strong", children: [{ kind: "text", text: "x" }] }] },
    ]);

    expect(parseMarkdown("**a *b* c**")).toEqual([
      {
        kind: "p",
        inline: [
          {
            kind: "strong",
            children: [
              { kind: "text", text: "a " },
              { kind: "em", children: [{ kind: "text", text: "b" }] },
              { kind: "text", text: " c" },
            ],
          },
        ],
      },
    ]);
  });

  test("unterminated markers stay literal instead of swallowing the rest", () => {
    const literal = (text: string) => [{ kind: "p", inline: [{ kind: "text", text }] }];

    expect(parseMarkdown("a **b")).toEqual(literal("a **b"));
    expect(parseMarkdown("`code")).toEqual(literal("`code"));
    expect(parseMarkdown("[x](")).toEqual(literal("[x]("));
  });

  test("CRLF input splits into paragraphs without a stray carriage return", () => {
    expect(parseMarkdown("a\r\n\r\nb")).toEqual([
      { kind: "p", inline: [{ kind: "text", text: "a" }] },
      { kind: "p", inline: [{ kind: "text", text: "b" }] },
    ]);
  });

  test("a bullet list takes indented continuation lines as one item", () => {
    expect(parseMarkdown("- one\n- two\n  and more\n+ three")).toEqual([
      {
        kind: "ul",
        items: [
          [{ kind: "text", text: "one" }],
          [{ kind: "text", text: "two and more" }],
          [{ kind: "text", text: "three" }],
        ],
      },
    ]);
  });

  test("an ordered list keeps the first number as its start", () => {
    expect(parseMarkdown("3. three\n4. four")).toEqual([
      {
        kind: "ol",
        start: 3,
        items: [[{ kind: "text", text: "three" }], [{ kind: "text", text: "four" }]],
      },
    ]);
  });

  test("a fence keeps its body literal and lowercases its language", () => {
    expect(parseMarkdown("```TS\n**not bold**\n```")).toEqual([
      { kind: "code", text: "**not bold**", language: "ts" },
    ]);
  });

  test("headings fold anything past the third level into level three", () => {
    expect(parseMarkdown("## two")).toEqual([
      { kind: "heading", level: 2, inline: [{ kind: "text", text: "two" }] },
    ]);

    expect(parseMarkdown("#### four")).toEqual([
      { kind: "heading", level: 3, inline: [{ kind: "text", text: "four" }] },
    ]);
  });

  test("quotes and rules keep their own block kinds", () => {
    expect(parseMarkdown("> one\n> two")).toEqual([
      { kind: "quote", inline: [{ kind: "text", text: "one two" }] },
    ]);

    expect(parseMarkdown("before\n\n---\n\nafter").map((block) => block.kind)).toEqual([
      "p",
      "rule",
      "p",
    ]);
  });

  test("link text and inline code are never parsed for more markup", () => {
    expect(parseMarkdown("[**x**](https://example.com)")).toEqual([
      {
        kind: "p",
        inline: [{ kind: "link", href: "https://example.com", text: "**x**" }],
      },
    ]);
  });

  // A bot writes its approval links bare, not as `[text](url)`, so a URL in
  // running text has to become a link on its own or the chip never appears.
  test("a bare URL becomes a link, and the punctuation after it stays text", () => {
    expect(parseMarkdown("Approve it at https://botmail.pro/approve/abc123.")).toEqual([
      {
        kind: "p",
        inline: [
          { kind: "text", text: "Approve it at " },
          {
            kind: "link",
            href: "https://botmail.pro/approve/abc123",
            text: "https://botmail.pro/approve/abc123",
          },
          { kind: "text", text: "." },
        ],
      },
    ]);
  });

  test("a query string is part of the link, not trailing punctuation", () => {
    expect(parseMarkdown("https://example.com/a?b=1&c=2")).toEqual([
      {
        kind: "p",
        inline: [
          {
            kind: "link",
            href: "https://example.com/a?b=1&c=2",
            text: "https://example.com/a?b=1&c=2",
          },
        ],
      },
    ]);
  });

  test("two URLs on one line stay two links", () => {
    expect(
      parseMarkdown("https://a.example/x and https://b.example/y")
        .flatMap((block) => (block.kind === "p" ? block.inline : []))
        .filter((node) => node.kind === "link"),
    ).toEqual([
      { kind: "link", href: "https://a.example/x", text: "https://a.example/x" },
      { kind: "link", href: "https://b.example/y", text: "https://b.example/y" },
    ]);
  });

  test("a URL inside inline code is code, not a link", () => {
    expect(parseMarkdown("`https://example.com`")).toEqual([
      { kind: "p", inline: [{ kind: "code", text: "https://example.com" }] },
    ]);
  });

  test("empty and whitespace-only input yield no blocks", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("  \n\t\n ")).toEqual([]);
    expect(parseMarkdown("*")).toEqual([{ kind: "p", inline: [{ kind: "text", text: "*" }] }]);
  });

  // The bug this parser fixes: an agent's heading, prose, lists and code all
  // reached the transcript as one paragraph full of literal markers.
  test("a real agent reply parses to many blocks, not one paragraph", () => {
    const reply = [
      "## Retry path",
      "",
      "I fixed **the retry loop** and added coverage.",
      "",
      "- added `queue.retry`",
      "- covered the failure branch",
      "",
      "1. run the tests",
      "2. ship it",
      "",
      "```ts",
      "await retry()",
      "```",
      "",
      "That should hold.",
    ].join("\n");

    expect(parseMarkdown(reply).map((block) => block.kind)).toEqual([
      "heading",
      "p",
      "ul",
      "ol",
      "code",
      "p",
    ]);
  });
});

describe("renderMarkdown", () => {
  test("a bullet list renders one li per item", () => {
    expect(findAll(html("- one\n- two\n- three"), "ul li").map(textContent)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  test("only a paragraph that is one link gets the chip class", () => {
    const chip = html("[https://example.com](https://example.com)");

    expect(findAll(chip, 'p.md-link-row a[href="https://example.com"]')).toHaveLength(1);
    expect(findAll(html("see [docs](https://example.com)"), "p.md-link-row")).toEqual([]);
  });

  test("strong renders as strong", () => {
    expect(findAll(html("**x**"), "strong").map(textContent)).toEqual(["x"]);
  });

  test("an ordered list renders its start only when it is not one", () => {
    const [list] = findAll(html("3. three"), "ol[start]");

    expect(list === undefined ? "" : Option.getOrThrow(attr(list, "start"))).toBe("3");
    expect(findAll(html("1. one"), "ol[start]")).toEqual([]);
  });
});

describe("hostile links", () => {
  // A bot's words are model output, and model output can be steered. A link
  // that would run script or leave through an odd door keeps its words only.
  const hostile = [
    "javascript:alert%281%29",
    "JaVaScRiPt:alert%281%29",
    "vbscript:msgbox",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "javascript&#58;alert%281%29",
    "&#106;avascript:alert%281%29",
    "//evil.example/approve",
    "/\\evil.example/approve",
    "\u0001javascript:alert%281%29",
  ];

  test.each(hostile)("[click](%s) renders the words without a link", (href) => {
    const rendered = html(`[click](${href})`);

    expect(findAll(rendered, "a")).toEqual([]);
    expect(textContent(rendered)).toBe("click");
  });

  test("web, mail and in-app links survive", () => {
    const rendered = html(
      "[a](https://example.com/x) [b](http://example.com) [c](mailto:me@example.com) [d](/chat/hermes)",
    );

    expect(findAll(rendered, "a").map((link) => Option.getOrThrow(attr(link, "href")))).toEqual([
      "https://example.com/x",
      "http://example.com",
      "mailto:me@example.com",
      "/chat/hermes",
    ]);
  });

  test("a link dressed as an approval is no chip, and names where it goes", () => {
    const rendered = html("[Approve](https://evil.example/steal)");

    expect(findAll(rendered, "p.md-link-row")).toEqual([]);
    expect(findAll(rendered, "a").map(textContent)).toEqual(["Approve (evil.example)"]);
  });

  test("the host named is the one the browser goes to, not the one in front of an @", () => {
    expect(
      findAll(html("[Approve](https://botmail.pro@evil.example/x)"), "a").map(textContent),
    ).toEqual(["Approve (evil.example)"]);
    // Without the `//` there is no host to print, so there is no link either.
    expect(findAll(html("[Approve](https:evil.example)"), "a")).toEqual([]);
  });

  test("a bare approval URL is still the chip, showing its own address", () => {
    const rendered = html("https://botmail.pro/approve/abc123");

    expect(findAll(rendered, "p.md-link-row a").map(textContent)).toEqual([
      "https://botmail.pro/approve/abc123",
    ]);
  });
});
