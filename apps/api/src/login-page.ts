/**
 * The one page that is allowed to be unauthenticated: it is how a browser gets
 * the session cookie. It contains no script and no token, so it cannot leak
 * either.
 *
 * The stylesheet is deliberately self-contained. This document has to render
 * before any asset is authorized, so it cannot wait for the app's stylesheet
 * (or a font) to load; the tokens below are copied from `apps/web/src/styles.css`
 * by value, and the page carries every rule it needs. Do not "fix" this by
 * linking the app stylesheet: an unauthorized request would get the login page
 * with no styling.
 */

/**
 * The page's own policy: its one inline stylesheet, a form that posts back to
 * this origin, and nothing else. It is never framed.
 */
export const LOGIN_CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/** What the page says above the form: nothing, a refused token, or a refused client. */
export type LoginNotice = "none" | "rejected" | "throttled";

const NOTICES: Record<LoginNotice, string> = {
  none: "",
  rejected: '<p class="error" role="alert">That token was not accepted.</p>',
  throttled: '<p class="error" role="alert">Too many attempts. Try again later.</p>',
};

export const loginDocument = (notice: LoginNotice): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="dark" />
    <title>Sign in · mackbot</title>
    <style>
      :root {
        color-scheme: dark;

        /* The app's palette, by value: --bg-deep, --surface, --line, --text,
           --muted, --accent, --warn-ink and --black from apps/web/src/styles.css. */
        --bg-deep: oklch(12.29% 0.0108 none);
        --surface: oklch(19.98% 0.0086 none);
        --line: oklch(29.21% 0.0179 none);
        --text: oklch(94.84% 0.0046 none);
        --muted: oklch(65.8% 0.0228 none);
        --accent: oklch(72.87% 0.1398 258.1);
        --warn-ink: oklch(89.86% 0.1059 83.8);
        --black: oklch(0% 0 none);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-block-size: 100dvh;
        display: grid;
        place-items: center;
        padding-block: 24px;
        padding-inline: 24px;
        background: var(--bg-deep);
        color: var(--text);
        font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      main { inline-size: min(100%, 22rem); }
      h1 { margin: 0; margin-block-end: 4px; font-size: 1.5rem; letter-spacing: -0.02em; }
      p { margin: 0; margin-block-end: 24px; color: var(--muted); }
      .error {
        margin-block-end: 16px;
        padding-block: 10px;
        padding-inline: 12px;
        border: 1px solid color-mix(in oklch, var(--warn-ink) 35%, var(--bg-deep));
        border-radius: 10px;
        background: color-mix(in oklch, var(--warn-ink) 10%, var(--surface));
        color: var(--warn-ink);
      }
      label { display: block; margin-block-end: 8px; font-size: 0.8125rem; color: var(--muted); }
      input, button {
        inline-size: 100%;
        min-block-size: 48px;
        border-radius: 10px;
        font: inherit;
      }
      input {
        margin-block-end: 12px;
        padding-block: 0;
        padding-inline: 14px;
        border: 1px solid var(--line);
        background: var(--surface);
        color: inherit;
      }
      input:focus-visible, button:focus-visible {
        outline: max(2px, 0.08em) solid var(--accent);
        outline-offset: 0.25em;
      }
      button {
        border: 0;
        background: var(--accent);
        color: var(--bg-deep);
        font-weight: 600;
        cursor: pointer;
      }
      button:active { transform: scale(0.97); }
      @media (hover: hover) and (pointer: fine) {
        button:hover { background: color-mix(in oklch, var(--accent), var(--black) 12%); }
      }
      @media (prefers-reduced-motion: no-preference) {
        button { transition: transform 160ms ease-out; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>mackbot</h1>
      <p>Enter the fleet token. It is kept on the server and exchanged for a sign-in cookie; it never enters the app bundle.</p>
      ${NOTICES[notice]}
      <form method="post" action="/login">
        <label for="token">Fleet token</label>
        <input id="token" name="token" type="password" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" required autofocus />
        <button type="submit">Sign in</button>
      </form>
    </main>
  </body>
</html>
`;
