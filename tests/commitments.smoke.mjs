/**
 * Smoke test for the commitments extension (src/commitments.ts): the durable
 * per-conversation commitment list, the two tools that write it, and the prompt
 * section that shows the open ones to the model.
 *
 * Run with: bun tests/commitments.smoke.mjs
 *
 * The claims this file has to break if they stop holding:
 *   1. A tool call leaves exactly one open commitment in the conversation's
 *      document, carrying the text the model gave.
 *   2. The next request's system message carries the commitments section, so
 *      the model sees the list — and an empty list enters no prompt at all.
 *   3. A second call with the same text does not create a second commitment.
 *   4. `openCommitments` drops a closed one, and closing an unknown id is an
 *      error result rather than a silent no-op.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { CommitmentsDoc, commitmentsExtension, openCommitments } from "../src/commitments.ts";

const context = BACKGROUND_CONTEXT;

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

/** The commitments section as the request saw it: a later entry replaces an earlier one, null removes it. */
const sectionText = (messages) => {
  let text;
  for (const message of messages) {
    if (message.role !== "system") continue;
    const value = message.sections?.commitments;
    if (value === undefined) continue;
    text = value === null ? undefined : value;
  }
  return text;
};

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);

const registry = createRegistry();
registry.install(commitmentsExtension);

check(
  "the extension is named mackbot-commitments",
  commitmentsExtension.name === "mackbot-commitments",
  commitmentsExtension.name,
);
check(
  "the extension carries the two tools",
  (commitmentsExtension.tools ?? []).map((tool) => tool.name).join(",") ===
    "commitment_add,commitment_close",
  (commitmentsExtension.tools ?? []).map((tool) => tool.name).join(","),
);
check(
  "the extension carries one section",
  (commitmentsExtension.sections ?? []).map((section) => section.key).join(",") === "commitments",
  (commitmentsExtension.sections ?? []).map((section) => section.key).join(","),
);

const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, {
  agent: { model: { provider: "faux", modelId: "faux-1" } },
});

/** Every request the provider was asked for, so a section can be read as the model saw it. */
const requests = [];
const capture = (build) => (transcript) => {
  requests.push(transcript.messages);
  return build();
};

const TEXT = "Send the Q3 numbers to Northwind";

faux.setResponses([
  capture(() =>
    fauxAssistantMessage(fauxToolCall("commitment_add", { text: TEXT }), { stopReason: "toolUse" }),
  ),
  capture(() => fauxAssistantMessage("Noted.")),
]);
await (
  await root.submit({ type: "input", content: `Remember to ${TEXT.toLowerCase()}.` }, context)
).wait(context);

const doc = await harness.snapshot(CommitmentsDoc, root.id, context);
const id = doc?.items[0]?.id;
check("the document holds one commitment", doc?.items.length === 1, `${doc?.items.length}`);
check("the commitment is open", doc?.items[0]?.status === "open", doc?.items[0]?.status);
check("the commitment carries the text", doc?.items[0]?.text === TEXT, doc?.items[0]?.text);
check("the commitment has a hex id", /^[0-9a-f]{16}$/.test(id ?? ""), id);
check("the commitment is dated", (doc?.items[0]?.at ?? 0) > 0, `${doc?.items[0]?.at}`);

check("the first request had no commitments section", sectionText(requests[0] ?? []) === undefined);
const shown = sectionText(requests[1] ?? []);
check("the next request carries the commitments section", shown !== undefined, shown);
check("the section names the commitment", shown?.includes(`${id} ${TEXT}`) === true, shown);

// The same commitment again: a replayed call, or the model repeating itself, is
// not a second commitment.
faux.setResponses([
  capture(() =>
    fauxAssistantMessage(fauxToolCall("commitment_add", { text: TEXT }), { stopReason: "toolUse" }),
  ),
  capture(() => fauxAssistantMessage("Still on it.")),
]);
await (
  await root.submit({ type: "input", content: `Also remember to ${TEXT.toLowerCase()}.` }, context)
).wait(context);

const repeated = await harness.snapshot(CommitmentsDoc, root.id, context);
check(
  "a second call with the same text adds no second commitment",
  repeated?.items.length === 1,
  `${repeated?.items.length}`,
);
check("the commitment keeps its id", repeated?.items[0]?.id === id, repeated?.items[0]?.id);

const addResults = (await root.context(context)).messages.filter(
  (message) => message.role === "toolResult" && message.toolName === "commitment_add",
);
const repeatedText =
  addResults
    .at(-1)
    ?.content.map((item) => item.text)
    .join(" ") ?? "";
check(
  "the repeated call reports the open commitment instead of adding one",
  repeatedText.includes("already open"),
  repeatedText,
);

// Closing an unknown id is an error, not a silent no-op.
faux.setResponses([
  capture(() =>
    fauxAssistantMessage(fauxToolCall("commitment_close", { id: "does-not-exist" }), {
      stopReason: "toolUse",
    }),
  ),
  capture(() => fauxAssistantMessage("No such commitment.")),
]);
await (await root.submit({ type: "input", content: "Close that one." }, context)).wait(context);

const { messages } = await root.context(context);
const closeResults = messages.filter(
  (message) => message.role === "toolResult" && message.toolName === "commitment_close",
);
check(
  "closing an unknown id is an error result",
  closeResults.at(-1)?.isError === true,
  JSON.stringify(closeResults.at(-1)?.content),
);

// Closing a known id retires it, and the section leaves the prompt again.
faux.setResponses([
  capture(() =>
    fauxAssistantMessage(fauxToolCall("commitment_close", { id }), { stopReason: "toolUse" }),
  ),
  capture(() => fauxAssistantMessage("Closed.")),
]);
await (
  await root.submit(
    { type: "input", content: "The numbers went out, close that commitment." },
    context,
  )
).wait(context);

const closed = await harness.snapshot(CommitmentsDoc, root.id, context);
check("the commitment is closed", closed?.items[0]?.status === "closed", closed?.items[0]?.status);
check(
  "openCommitments drops the closed one",
  openCommitments(closed?.items ?? []).length === 0,
  `${openCommitments(closed?.items ?? []).length}`,
);
check(
  "an empty list enters no prompt",
  sectionText(requests.at(-1) ?? []) === undefined,
  sectionText(requests.at(-1) ?? []),
);

await harness.close(context);

// The replay rule: the id is derived from the call's task id and its text, so
// a call that runs again after a crash lands on the commitment it made first.
// The tool is driven directly here, because the harness only replays a call
// that a crash interrupted.
{
  const replayHarness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  const replayRoot = await replayHarness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  const add = (commitmentsExtension.tools ?? []).find((tool) => tool.name === "commitment_add");
  const api = {
    taskId: 4242,
    conversationId: replayRoot.id,
    commit: (change, ctx) => replayHarness.commit((tx) => change(tx), ctx),
  };
  const first = await add.execute({ text: "Ship the release" }, api, context);
  const second = await add.execute({ text: "Ship the release" }, api, context);
  const replayed = await replayHarness.snapshot(CommitmentsDoc, replayRoot.id, context);
  check(
    "a replayed call is one commitment",
    replayed?.items.length === 1,
    `${replayed?.items.length}`,
  );
  check(
    "a replayed call keeps the id of the first",
    first.output
      .map((item) => item.text)
      .join(" ")
      .includes(replayed?.items[0]?.id ?? "") &&
      second.output
        .map((item) => item.text)
        .join(" ")
        .includes(replayed?.items[0]?.id ?? ""),
    `${first.output.map((item) => item.text).join(" ")} / ${second.output.map((item) => item.text).join(" ")}`,
  );
  await replayHarness.close(context);
}

if (failures.length > 0) {
  console.error("commitments smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("commitments smoke passed");
process.exit(0);
