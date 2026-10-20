/**
 * Smoke test for the front door's browser credential: `/login`, the signed
 * session cookie, and the CSRF gate on cookie-authenticated mutations.
 *
 * Run with: bun tests/auth.smoke.mjs
 *
 * `src/index.ts` imports `cloudflare:workers`, so this re-execs with the shim
 * on NODE_PATH, like `routes.smoke.mjs`. The Bot and ASSETS bindings are faked;
 * the front door, its HMAC, its cookie parsing and its route matching are real.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
if (process.env.MACKBOT_WORKERS_SHIM !== "1") {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_PATH: join(here, "shims"),
      MACKBOT_WORKERS_SHIM: "1",
    },
  });
  process.exit(result.status ?? 1);
}

const worker = (await import("../src/index.ts")).default;

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

const TOKEN = "dev-token";
const STATUS_VIEW = { id: "hermes", approvals: [], pending: [] };

const decisions = [];
const assetRequests = [];
const env = {
  CHAT_BEARER_TOKEN: TOKEN,
  ASSETS: {
    fetch: async (request) => {
      assetRequests.push(new URL(request.url).pathname);
      return new Response("<!doctype html><title>mackbot app</title>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  },
  Bot: {
    getByName: () => ({
      status: async () => STATUS_VIEW,
      decide: async (approvalId, decision) => {
        decisions.push({ approvalId, decision });
        return undefined;
      },
    }),
  },
};

const login = (origin, token) =>
  worker.fetch(
    new Request(`${origin}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    }),
    env,
  );

const cookieFrom = (response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";

const request = (origin, path, options = {}) =>
  worker.fetch(new Request(`${origin}${path}`, options), env);

const approvalPost = (origin, headers, body = '{"action":"allow"}') =>
  request(origin, "/approvals/hermes/apr-1", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

// ---------------------------------------------------------------------------
// The login page is the only unauthenticated surface, and it carries no token.
// ---------------------------------------------------------------------------

{
  const response = await request("https://mackbot.test", "/login");
  const body = await response.text();
  check("GET /login is 200", response.status === 200, `${response.status}`);
  check(
    "the login page is HTML",
    response.headers.get("content-type")?.startsWith("text/html") === true,
  );
  check("the login page does not contain the token", !body.includes(TOKEN));
  check("the login page has no script", !body.includes("<script"));
}

{
  const response = await approvalPost("https://mackbot.test", {}, "{}");
  check("an unauthenticated mutation is 401", response.status === 401, `${response.status}`);
}

{
  const response = await request("https://mackbot.test", "/status");
  check("an unauthenticated API read is 401", response.status === 401, `${response.status}`);
}

// ---------------------------------------------------------------------------
// Exchange the token once for an HttpOnly signed cookie.
// ---------------------------------------------------------------------------

const wrong = await login("https://mackbot.test", "not-the-token");
check("a wrong token is 401", wrong.status === 401, `${wrong.status}`);
check("a wrong token sets no cookie", wrong.headers.get("set-cookie") === null);

const local = await login("http://127.0.0.1:8781", TOKEN);
const localCookie = cookieFrom(local);
check("the right token redirects to the app", local.status === 303, `${local.status}`);
check(
  "the redirect lands on /",
  local.headers.get("location") === "/",
  `${local.headers.get("location")}`,
);
check("the cookie is HttpOnly", local.headers.get("set-cookie")?.includes("HttpOnly") === true);
check(
  "the cookie is SameSite=Lax",
  local.headers.get("set-cookie")?.includes("SameSite=Lax") === true,
);
check("the cookie is path-wide", local.headers.get("set-cookie")?.includes("Path=/") === true);
check(
  "loopback http does not mark the cookie Secure",
  local.headers.get("set-cookie")?.includes("Secure") !== true,
  `${local.headers.get("set-cookie")}`,
);
check("the cookie value is not the bearer token", !localCookie.includes(TOKEN), localCookie);

const secure = await login("https://mackbot.test", TOKEN);
const secureCookie = cookieFrom(secure);
check(
  "a production https login marks the cookie Secure",
  secure.headers.get("set-cookie")?.includes("Secure") === true,
  `${secure.headers.get("set-cookie")}`,
);

{
  const response = await request("https://mackbot.test", "/status", {
    headers: { Cookie: localCookie },
  });
  check("the cookie authorizes a read", response.status === 200, `${response.status}`);
  const body = await response.json();
  check(
    "the read is the real status envelope",
    body.bots?.hermes?.id === "hermes",
    JSON.stringify(body),
  );
}

{
  const tampered = `${localCookie.slice(0, -1)}${localCookie.endsWith("A") ? "B" : "A"}`;
  const response = await request("https://mackbot.test", "/status", {
    headers: { Cookie: tampered },
  });
  check("a tampered cookie is 401", response.status === 401, `${response.status}`);
}

// ---------------------------------------------------------------------------
// A cookie does not by itself authorize a mutation.
// ---------------------------------------------------------------------------

{
  const response = await approvalPost("https://mackbot.test", { Cookie: localCookie });
  check(
    "a cookie POST without the CSRF header is 403",
    response.status === 403,
    `${response.status}`,
  );
  check("the unproven decision never reached the bot", decisions.length === 0);
}

{
  const response = await approvalPost("https://mackbot.test", {
    Cookie: localCookie,
    Origin: "https://evil.example",
    "X-Mackbot-CSRF": "1",
  });
  check("a cookie POST from another origin is 403", response.status === 403, `${response.status}`);
  check("the cross-origin decision never reached the bot", decisions.length === 0);
}

{
  const response = await approvalPost("https://mackbot.test", {
    Cookie: localCookie,
    Origin: "https://mackbot.test",
    "X-Mackbot-CSRF": "1",
  });
  check(
    "a proven same-origin cookie POST reaches the route",
    response.status === 409,
    `${response.status}`,
  );
  check("the proven decision reached the bot", decisions.length === 1, JSON.stringify(decisions));
}

{
  const response = await approvalPost("https://mackbot.test", {
    Origin: "https://evil.example",
    Authorization: `Bearer ${TOKEN}`,
  });
  check("a bearer POST needs no CSRF proof", response.status === 409, `${response.status}`);
  check("the bearer decision reached the bot", decisions.length === 2, JSON.stringify(decisions));
}

// ---------------------------------------------------------------------------
// The app shell is served through the assets binding, deep links included.
// ---------------------------------------------------------------------------

{
  const response = await request("https://mackbot.test", "/bot/hermes");
  check(
    "an unauthenticated deep link redirects to /login",
    response.status === 302,
    `${response.status}`,
  );
  check("the redirect names /login", response.headers.get("location")?.endsWith("/login") === true);
  check("the asset binding was not reached", assetRequests.length === 0);
}

{
  const response = await request("https://mackbot.test", "/bot/hermes", {
    headers: { Cookie: secureCookie },
  });
  const body = await response.text();
  check("an authenticated deep link is 200", response.status === 200, `${response.status}`);
  check("the deep link returned the app", body.includes("mackbot app"));
  check(
    "the asset binding received the deep link",
    assetRequests.at(-1) === "/bot/hermes",
    `${assetRequests.at(-1)}`,
  );
}

{
  const response = await request("https://mackbot.test", "/", {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const body = await response.text();
  check("a bearer can load the app shell", response.status === 200 && body.includes("mackbot app"));
  check("the asset binding received /", assetRequests.at(-1) === "/", `${assetRequests.at(-1)}`);
}

if (failures.length > 0) {
  console.error("auth smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("auth smoke passed");
process.exit(0);
