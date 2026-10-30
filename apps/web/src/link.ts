/**
 * link — which hrefs a bot's words may carry.
 *
 * A transcript renders text a model wrote, and a model can be talked into
 * writing anything, so a link is an allowlist rather than a blocklist: a web
 * address, a mail address, or a path inside this app. Anything else — a
 * `javascript:` or `data:` URL, a protocol-relative `//host`, a scheme hidden
 * behind control characters or an HTML entity — is not a link at all, and
 * renders as the words.
 */

const SAFE_SCHEMES: ReadonlySet<string> = new Set(["https", "http", "mailto"]);

/**
 * Whitespace, control characters and backslashes never belong in a link a bot
 * means. Browsers strip or reinterpret every one of them — `java\tscript:` is
 * `javascript:`, and `/\host` is `//host` — so an href carrying one is refused
 * outright rather than parsed the way one browser happens to parse it. With
 * them gone, the scheme is exactly the text before the first colon.
 */
const SUSPECT = /[\s\p{Cc}\\]/u;

const SCHEME = /^([a-z][a-z\d+.-]*):/iu;

/** A path inside this app: one leading slash, never two. */
const APP_PATH = /^\/(?!\/)/u;

/** A web address's authority: everything between `//` and the path. */
const AUTHORITY = /^https?:\/\/([^/?#]*)/iu;

/** The host of a web address, without the `user@` a phishing link hides
 *  behind; `undefined` for anything that is not a web address. */
export const webHostOf = (href: string): string | undefined => {
  const authority = AUTHORITY.exec(href)?.[1];
  if (authority === undefined) return undefined;
  const host = authority.slice(authority.lastIndexOf("@") + 1).toLowerCase();
  return host.length === 0 ? undefined : host;
};

/** The href as written when it is safe to follow, or `undefined` when not. */
export const safeHref = (href: string): string | undefined => {
  if (href.length === 0 || SUSPECT.test(href)) return undefined;
  if (href.startsWith("/")) return APP_PATH.test(href) ? href : undefined;
  const scheme = SCHEME.exec(href)?.[1]?.toLowerCase();
  // No scheme is a relative reference, which a bot has no business writing.
  if (scheme === undefined || !SAFE_SCHEMES.has(scheme)) return undefined;
  // `https:evil.example` still reaches a host; insisting on the `//` form is
  // what lets the host a link goes to be printed beside it.
  if (scheme !== "mailto" && webHostOf(href) === undefined) return undefined;
  return href;
};

/**
 * Where a link really goes, in the words a person checks before they press it:
 * a web address's host, or a mail link's address. A path inside this app has
 * no such place to name.
 */
export const destinationOf = (href: string): string | undefined => {
  if (/^mailto:/iu.test(href)) {
    const address = href.slice("mailto:".length).split("?")[0] ?? "";
    return address.length === 0 ? undefined : address;
  }
  return webHostOf(href);
};
