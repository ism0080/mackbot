/*
 * Starting a chat and sending a message through the built app over real HTTP.
 *
 * The Story and Scene tests in this folder own the state machine and the view;
 * this one owns the boundary they cannot see: the cookie surface's CSRF header,
 * the `wait=0` receipt query, and the shape the Command actually posts. The home
 * action opens the bot picker, each row opens that bot's transcript, and the
 * composer posts to `/chat/:bot`. The optimistic bubble is what the person sees
 * before the server answers; a refusal puts the text back in the box.
 */
import { STATUS_RESPONSE, TRANSCRIPTS } from "./fixture.mjs";
import { boot, makeChecker } from "./support/app.mjs";
import { pageWithUser } from "./support/model.mjs";
import { startStub } from "./support/stub.mjs";

const REFUSAL = "invalid request body";

// The first reads are the load and the send's own refetch, which predate the
// answer. A later read is the auto-refresh, and it returns the recorded user
// message so the optimistic bubble can retire without a manual reload. The
// counter lives in an object so the module has no bare mutable binding.
const reads = { scribe: 0 };
const scribePage = () => {
  reads.scribe += 1;
  return reads.scribe >= 3 ? pageWithUser("Write the minutes") : TRANSCRIPTS.scribe;
};

const stub = startStub({
  status: STATUS_RESPONSE,
  transcripts: {
    hermes: () => TRANSCRIPTS.hermes,
    scribe: scribePage,
  },
  chats: {
    "/chat/hermes": () => ({ status: 400, body: { error: REFUSAL } }),
  },
});

const { check, finish } = makeChecker();
const app = await boot(stub.origin);
const { window, settle, query, all, text, waitFor, click } = app;

const type = (node, value) => {
  node.value = value;
  node.dispatchEvent(new window.Event("input", { bubbles: true }));
};

const submit = () => {
  query(".composer").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
};

const chatRequests = () => stub.requests.filter((request) => request.path.startsWith("/chat/"));

try {
  await waitFor(() => all(".doneitem").length === 2, "the home rendered");

  check(
    "the home's chats list keeps every thread, not only triaged ones",
    all('[data-group="chats"] [data-bot]').length === 2,
    all('[data-group="chats"] [data-bot]')
      .map((node) => node.getAttribute("data-bot"))
      .join("|"),
  );

  // 1 — the picker is reachable from the home and lists every bot.
  check("the home offers a new chat", query('[data-open="new-chat"]') !== null);
  click(query('[data-open="new-chat"]'));
  await settle();
  check("the picker opens", text(".hdr h1") === "New chat");
  check(
    "every bot is offered",
    all(".chatitem").length === 2 &&
      all(".chatitem")
        .map((node) => node.getAttribute("data-bot"))
        .join("|") === "hermes|scribe",
    all(".chatitem")
      .map((node) => node.getAttribute("data-bot"))
      .join("|"),
  );

  // 2 — a pick opens that bot's transcript with an empty composer.
  click(query('.chatitem[data-bot="scribe"]'));
  await settle();
  check("the row opens the transcript", text(".hdr h1") === "Scribe");
  check("the transcript offers a composer", query(".composer") !== null);
  check("an empty composer cannot send", query(".composer-send").disabled === true);

  type(query('[data-field="chat"]'), "Write the minutes");
  await settle();
  check("typing enables send", query(".composer-send").disabled === false);

  // 3 — sending posts the text and shows it immediately.
  submit();
  await waitFor(() => chatRequests().length === 1, "the message reached the stub");
  const sent = chatRequests()[0];
  check("the message is a POST to the bot's chat route", sent.path === "/chat/scribe");
  check("the request asks for the receipt, not the result", sent.query.wait === "0");
  check(
    "the body carries the text",
    sent.body.text === "Write the minutes",
    JSON.stringify(sent.body),
  );
  check("the request carries the CSRF header", sent.headers["x-mackbot-csrf"] === "1");
  await settle();
  check("the message shows before the server confirms it", all(".msg.pending").length === 1);
  check("the bubble carries the typed text", text(".msg.pending") === "Write the minutes");
  check("the composer clears once sent", query('[data-field="chat"]').value === "");

  // 3b — the poll catches the recorded entry without a manual reload.
  await waitFor(
    () => all(".msg.pending").length === 0 && all("[data-entry]").length > 3,
    "the transcript poll refreshed the thread",
    8_000,
  );
  check("the pending bubble retires on the poll", all(".msg.pending").length === 0);
  check(
    "the recorded message is in the transcript",
    all("[data-entry]")
      .map((node) => node.textContent.trim())
      .some((line) => line.includes("Write the minutes")),
  );

  // 4 — a refusal restores the text and says why.
  click(query(".icon"));
  await settle();
  click(query('[data-open="new-chat"]'));
  await settle();
  click(query('.chatitem[data-bot="hermes"]'));
  await settle();
  type(query('[data-field="chat"]'), "Check the invoices");
  await settle();
  submit();
  await waitFor(() => text("[data-toast]").includes(REFUSAL), "the refusal was reported");
  check(
    "the refusal says the message did not reach the bot",
    text("[data-toast]").includes("Your message is still here."),
    text("[data-toast]"),
  );
  check(
    "the refused text is back in the box",
    query('[data-field="chat"]').value === "Check the invoices",
  );
  check("the refused bubble is gone", all(".msg.pending").length === 0);

  check("no console errors", app.pageErrors.length === 0, app.pageErrors.join("; "));
} finally {
  stub.stop();
}

finish();
