/**
 * Smoke test for the HTTP front door's request contract (src/chat-request.ts).
 *
 * Run with: bun tests/chat-request.smoke.mjs
 *
 * Exercises bearer authorization and body decoding against real `Request`
 * objects, so the observable front-door behavior (accepted vs. rejected) is
 * checked without a live Durable Object or the Workers runtime.
 */
const { isAuthorized, readChatRequest, MAX_TEXT_LENGTH, MAX_BODY_BYTES } =
  await import("../src/chat-request.ts");

const failures = [];

const TOKEN = "s3cret-token-value";

const authorized = (label, request, expected) => {
  let actual;
  try {
    actual = isAuthorized(request, TOKEN);
  } catch (error) {
    failures.push(`${label}: isAuthorized threw: ${error?.message ?? error}`);
    return;
  }
  if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`);
};

const decode = async (label, request, check) => {
  let body;
  try {
    body = await readChatRequest(request);
  } catch (error) {
    failures.push(`${label}: readChatRequest threw: ${error?.message ?? error}`);
    return;
  }
  check(body);
};

const rejected = (label, request) =>
  decode(label, request, (body) => {
    if (body !== undefined) {
      failures.push(
        `${label}: expected undefined, got text of ${JSON.stringify(body.text).length} chars`,
      );
    }
  });

const accepted = (label, request, assert) =>
  decode(label, request, (body) => {
    if (body === undefined) {
      failures.push(`${label}: expected a body, got undefined`);
      return;
    }
    assert(body);
  });

const url = "https://example.com/chat/bot";

const post = (body) => new Request(url, { method: "POST", body });

const authHeader = (value) =>
  new Request(url, { method: "POST", headers: { Authorization: value } });

// --- Authorization ---------------------------------------------------------

authorized("no Authorization header", new Request(url), false);
authorized("non-Bearer scheme", authHeader(`Basic ${TOKEN}`), false);
authorized("wrong token of the same length", authHeader(`Bearer ${TOKEN.slice(0, -1)}x`), false);
authorized(
  "wrong token that is a prefix",
  authHeader(`Bearer ${TOKEN.slice(0, TOKEN.length - 1)}`),
  false,
);
authorized("wrong token that is longer", authHeader(`Bearer ${TOKEN}extra`), false);
authorized("exact expected token", authHeader(`Bearer ${TOKEN}`), true);

// RFC 7235 makes the authorization scheme case-insensitive, unlike the token.
authorized("lowercase bearer scheme", authHeader(`bearer ${TOKEN}`), true);
authorized("uppercase BEARER scheme", authHeader(`BEARER ${TOKEN}`), true);
authorized("mixed-case BeArEr scheme", authHeader(`BeArEr ${TOKEN}`), true);

const upperCasedToken = TOKEN.toUpperCase();
if (upperCasedToken !== TOKEN) {
  authorized(
    "uppercased token rejected (proves the token stays case-sensitive, so only the scheme is insensitive)",
    authHeader(`Bearer ${upperCasedToken}`),
    false,
  );
}

authorized(
  "scheme with a trailing character rejected (BearerX is not Bearer)",
  authHeader(`BearerX ${TOKEN}`),
  false,
);

// --- Body decoding ---------------------------------------------------------

accepted("minimal valid body", post('{"text":"hi"}'), (body) => {
  if (body.text !== "hi") failures.push(`minimal valid body: text is ${JSON.stringify(body.text)}`);
});

rejected("whitespace-only text", post('{"text":"   "}'));
rejected("missing text field", post('{"operationId":"op"}'));
rejected("empty-string operationId", post('{"text":"hi","operationId":""}'));
rejected("whitespace-only thread", post('{"text":"hi","thread":"   "}'));

accepted("whenBusy steer", post('{"text":"hi","whenBusy":"steer"}'), (body) => {
  if (body.whenBusy !== "steer") {
    failures.push(`whenBusy steer: whenBusy is ${JSON.stringify(body.whenBusy)}`);
  }
});
rejected("unknown whenBusy", post('{"text":"hi","whenBusy":"later"}'));

accepted("wait false", post('{"text":"hi","wait":false}'), (body) => {
  if (body.wait !== false) failures.push(`wait false: wait is ${JSON.stringify(body.wait)}`);
});

rejected("invalid JSON", post("{not json"));
rejected("JSON array body", post("[]"));
rejected("no body at all", new Request(url, { method: "POST" }));

accepted(
  "text at MAX_TEXT_LENGTH",
  post(JSON.stringify({ text: "x".repeat(MAX_TEXT_LENGTH) })),
  (body) => {
    if (body.text.length !== MAX_TEXT_LENGTH) {
      failures.push(`text at MAX_TEXT_LENGTH: length is ${body.text.length}`);
    }
  },
);
rejected(
  "text over MAX_TEXT_LENGTH",
  post(JSON.stringify({ text: "x".repeat(MAX_TEXT_LENGTH + 1) })),
);

// --- Body size cap ---------------------------------------------------------

const paddedTo = (label, targetBytes) => {
  const pad = targetBytes - JSON.stringify({ text: "hi", thread: "" }).length;
  const body = JSON.stringify({ text: "hi", thread: "x".repeat(pad) });
  const actualBytes = new TextEncoder().encode(body).byteLength;
  if (actualBytes !== targetBytes) {
    failures.push(`${label}: fixture is ${actualBytes} bytes, wanted ${targetBytes}`);
  }
  return body;
};

accepted(
  "body at MAX_BODY_BYTES",
  post(paddedTo("body at MAX_BODY_BYTES", MAX_BODY_BYTES)),
  (body) => {
    if (body.text !== "hi")
      failures.push(`body at MAX_BODY_BYTES: text is ${JSON.stringify(body.text)}`);
  },
);

const oversized = paddedTo("body over MAX_BODY_BYTES", MAX_BODY_BYTES + 1);
rejected("body over MAX_BODY_BYTES", post(oversized));

// The overflow has to be valid JSON, so that a missing stream-side cap shows up
// as an accepted body instead of a syntax error. Otherwise this case would pass
// with the cap deleted.
const streamFixture = paddedTo("chunked body fixture", MAX_BODY_BYTES + 1024);
const streamBytes = new TextEncoder().encode(streamFixture);
const streamed = new ReadableStream({
  start(controller) {
    for (let offset = 0; offset < streamBytes.length; offset += 16 * 1024) {
      controller.enqueue(streamBytes.slice(offset, offset + 16 * 1024));
    }
    controller.close();
  },
});
const chunked = new Request(url, { method: "POST", body: streamed, duplex: "half" });
if (chunked.headers.get("content-length") !== null) {
  failures.push("chunked request unexpectedly carries a content-length header");
}
await rejected("chunked body over MAX_BODY_BYTES", chunked);

if (failures.length > 0) {
  console.error("chat-request smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("chat-request smoke passed");
process.exit(0);
