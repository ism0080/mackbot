/*
 * The roster screen, rendered by the built app against the stub.
 *
 * The screen lists every bot the registry holds, an edit is sent as a write
 * that carries the whole configuration, a new bot is sent as a create, and a
 * refusal from the server is shown in the toast with the server's own words.
 *
 * The stub answers `PUT /bots/:id` with the bot it stored for Hermes and
 * refuses Scribe's write, so one booted app shows both outcomes.
 */
import { Effect, Schema } from "effect";

import { ModelCatalogSchema, RosterSchema } from "@mackbot/contract";
import { CATALOG, ROSTER, STATUS_RESPONSE, TRANSCRIPTS } from "./fixture.mjs";
import { boot, makeChecker } from "./support/app.mjs";
import { startStub } from "./support/stub.mjs";

const decode = (schema, label, value) =>
  Effect.runSync(
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.catch((cause) => {
        console.error(`fixture does not match ${label}: ${cause}`);
        return Effect.die(cause);
      }),
    ),
  );

decode(RosterSchema, "Roster", ROSTER);
decode(ModelCatalogSchema, "ModelCatalog", CATALOG);

const REFUSAL =
  'bot "scribe" thinkingLevel "high" is not supported by "longcat-2.5-preview-free" (allowed: none)';

const stub = startStub({
  status: STATUS_RESPONSE,
  transcripts: {
    hermes: () => TRANSCRIPTS.hermes,
    scribe: () => TRANSCRIPTS.scribe,
  },
  roster: ROSTER,
  catalog: CATALOG,
  writes: {
    scribe: () => ({ status: 400, body: { error: REFUSAL } }),
  },
});

const { check, finish } = makeChecker();
const app = await boot(stub.origin);
const { window, settle, query, all, text, waitFor, click } = app;

/** Type into a field the way a person does: set the value, then say so. */
const type = (node, value) => {
  node.value = value;
  node.dispatchEvent(new window.Event("input", { bubbles: true }));
};

/** Pick an option the way a person does: set the value, then say so. */
const choose = (node, value) => {
  node.value = value;
  node.dispatchEvent(new window.Event("change", { bubbles: true }));
};

const field = (bot, name) => query(`[data-bot="${bot}"] [data-field="${name}"]`);
const draftField = (name) => query(`[data-new] [data-field="${name}"]`);
const writes = () => stub.requests.filter((request) => request.method === "PUT");
const creates = () => stub.requests.filter((request) => request.method === "POST");

try {
  await waitFor(() => all(".doneitem").length === 2, "the home rendered");

  // 1 — the way in to the roster, and what it shows.
  check("the home offers the roster", query('[data-open="bots"]') !== null);
  click(query('[data-open="bots"]'));
  await waitFor(() => all("[data-bot]").length === 3, "the roster rendered");
  check("the screen is the roster", text(".hdr h1") === "Bots");
  check("every bot in the roster is listed", all("[data-bot]").length === 3);
  check(
    "every bot's prompt is in a textarea",
    ["hermes", "scribe", "atlas"].every(
      (bot) => field(bot, "prompt").value === ROSTER.bots[bot].systemPrompt,
    ),
    ["hermes", "scribe", "atlas"].map((bot) => `${bot}: ${field(bot, "prompt").value}`).join(" | "),
  );
  check(
    "the model picker carries the bot's model",
    field("hermes", "model").value === "deepseek-v4-pro",
  );
  check(
    "a model the catalog does not list stays visible",
    field("atlas", "model").value === "@cf/meta/llama-3-3-70b-instruct-fp8-fast",
  );
  check("the level picker carries the bot's level", field("hermes", "level").value === "high");
  check(
    "the level picker offers the levels the model supports",
    [...field("hermes", "level").options].map((option) => option.value).join("|") === "|high|max",
    [...field("hermes", "level").options].map((option) => option.value).join("|"),
  );
  check(
    "the roster and the catalog were asked for",
    stub.requests.some((request) => request.method === "GET" && request.path === "/bots") &&
      stub.requests.some((request) => request.method === "GET" && request.path === "/models"),
    stub.requests.map((request) => `${request.method} ${request.path}`).join("; "),
  );

  // 2 — an edit is a write that carries the whole configuration.
  type(field("hermes", "prompt"), "You are Hermes, my chief of staff. Keep me posted.");
  await settle();
  click(query('[data-save="hermes"]'));
  await waitFor(() => writes().length === 1, "the write reached the stub");
  const write = writes()[0];
  check("the write is a PUT to the bot's path", write.path === "/bots/hermes");
  check(
    "the write carries the edited prompt",
    write.body.bot.systemPrompt === "You are Hermes, my chief of staff. Keep me posted.",
    JSON.stringify(write.body),
  );
  check(
    "the write leaves the rest of the configuration alone",
    write.body.bot.model === "deepseek-v4-pro" &&
      write.body.bot.thinkingLevel === "high" &&
      write.body.bot.brief === ROSTER.bots.hermes.brief &&
      write.body.bot.delegatesTo.join("|") === "scribe" &&
      write.body.bot.runtime.maxRetries === 3 &&
      write.body.bot.runtime.parallelTools === true &&
      write.body.bot.commitments === true,
    JSON.stringify(write.body),
  );
  check("the write carries the CSRF header", write.headers["x-mackbot-csrf"] === "1");
  check(
    "the write says it was saved",
    text("[data-toast]").includes("Saved Hermes."),
    text("[data-toast]"),
  );

  // 3 — a model that does not support the level takes the level back.
  choose(field("hermes", "model"), "kimi-k2.7-code");
  await settle();
  check(
    "a model without the level takes the level back to none",
    field("hermes", "level").value === "",
    field("hermes", "level").value,
  );

  // 4 — a refusal is shown with the server's own words.
  click(query('[data-save="scribe"]'));
  await waitFor(() => text("[data-toast]").includes(REFUSAL), "the refusal was reported");
  check(
    "the refusal shows the server's message",
    text("[data-toast]").includes(REFUSAL),
    text("[data-toast]"),
  );

  // 5 — the form refuses what the server would refuse, without a round trip.
  click(query("[data-create]"));
  await waitFor(() => text("[data-toast]").includes("needs an id"), "the empty draft was refused");
  check(
    "a draft with no id is refused",
    text("[data-toast]").includes("The new bot needs an id."),
    text("[data-toast]"),
  );
  check("nothing was created for it", creates().length === 0, `${creates().length}`);

  type(draftField("id"), "Nova!");
  await settle();
  click(query("[data-create]"));
  await waitFor(() => text("[data-toast]").includes("slug"), "the id was refused");
  check(
    "an id that is not a slug is refused",
    text("[data-toast]").includes("The id has to be a slug"),
    text("[data-toast]"),
  );
  check("nothing was created for it either", creates().length === 0, `${creates().length}`);

  type(draftField("id"), "nova");
  await settle();
  click(query("[data-create]"));
  await waitFor(() => text("[data-toast]").includes("needs a model"), "the model was refused");
  check(
    "a draft with no model is refused",
    text("[data-toast]").includes("The new bot needs a model."),
    text("[data-toast]"),
  );
  check("nothing was created for that either", creates().length === 0, `${creates().length}`);

  type(field("hermes", "prompt"), "");
  await settle();
  click(query('[data-save="hermes"]'));
  await waitFor(
    () => text("[data-toast]").includes("the system prompt is empty"),
    "the empty prompt was refused",
  );
  check(
    "an empty prompt is refused before the round trip",
    text("[data-toast]").includes("the system prompt is empty"),
    text("[data-toast]"),
  );
  check(
    "no write was sent for it",
    writes().filter((request) => request.path === "/bots/hermes").length === 1,
    JSON.stringify(writes().map((request) => request.path)),
  );

  // 6 — the new bot is a create.
  type(draftField("id"), "nova");
  await settle();
  choose(draftField("model"), "deepseek-v4-pro");
  await settle();
  type(draftField("prompt"), "You are Nova.");
  await settle();
  click(query("[data-create]"));
  await waitFor(() => creates().length === 1, "the create reached the stub");
  const create = creates()[0];
  check("the create is a POST to the roster", create.path === "/bots");
  check(
    "the create carries the new bot's id",
    create.body.id === "nova",
    JSON.stringify(create.body),
  );
  check(
    "the create carries the new bot's configuration",
    create.body.bot.model === "deepseek-v4-pro" && create.body.bot.systemPrompt === "You are Nova.",
    JSON.stringify(create.body),
  );
  check("the create carries the CSRF header", create.headers["x-mackbot-csrf"] === "1");
  check(
    "the created bot joins the roster",
    all("[data-bot]").length === 4,
    `${all("[data-bot]").length}`,
  );

  // 7 — the way out is a back button.
  click(query(".icon"));
  await settle();
  check("back returns to the home", text(".hdr.tall h1") === "Needs you", text(".hdr.tall h1"));

  check("no console errors", app.pageErrors.length === 0, app.pageErrors.join("; "));
} finally {
  stub.stop();
}

finish();
