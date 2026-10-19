/**
 * The one page that is allowed to be unauthenticated: it is how a browser gets
 * the session cookie. It contains no script and no token, so it cannot leak
 * either.
 */

export const loginDocument = (failed: boolean): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="dark" />
    <title>Sign in · mackbot</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100dvh;
        display: grid;
        place-items: center;
        padding: 24px;
        background: #05060a;
        color: #e7e9ee;
        font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      main { width: min(100%, 22rem); }
      h1 { margin: 0 0 4px; font-size: 1.5rem; letter-spacing: -0.02em; }
      p { margin: 0 0 24px; color: #9aa0ac; }
      .error { color: #ff8f8f; margin-bottom: 16px; }
      label { display: block; margin-bottom: 8px; font-size: 0.8125rem; color: #9aa0ac; }
      input, button {
        width: 100%;
        min-height: 48px;
        border-radius: 10px;
        font: inherit;
      }
      input {
        margin-bottom: 12px;
        padding: 0 14px;
        border: 1px solid #2a2f3a;
        background: #0d1017;
        color: inherit;
      }
      input:focus-visible { outline: 2px solid #6ea8ff; outline-offset: 1px; }
      button {
        border: 0;
        background: #e7e9ee;
        color: #05060a;
        font-weight: 600;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>mackbot</h1>
      <p>Enter the fleet token. It is kept on the server and exchanged for a sign-in cookie; it never enters the app bundle.</p>
      ${failed ? '<p class="error" role="alert">That token was not accepted.</p>' : ""}
      <form method="post" action="/login">
        <label for="token">Fleet token</label>
        <input id="token" name="token" type="password" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" required autofocus />
        <button type="submit">Sign in</button>
      </form>
    </main>
  </body>
</html>
`;
