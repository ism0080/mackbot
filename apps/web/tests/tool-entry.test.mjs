/*
 * The contract's projection of a tool result.
 *
 * pi-durable stores the tool result as model context. The view needs the tool's
 * name and failure bit without parsing that payload, so the projection lifts
 * both while leaving the raw body in `text` for the expanded details.
 */
import assert from "node:assert/strict";

import { projectEntry } from "@mackbot/contract";

const recordOf = (isError) => ({
  id: 7,
  conversationId: 1,
  kind: "pi.tool-result",
  model: [
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "iCloud Calendar.list_events",
      content: [{ type: "text", text: '{"status":"completed"}' }],
      isError,
    },
  ],
});

const run = (label, check) => {
  try {
    check();
  } catch (cause) {
    console.error(`FAIL ${label}\n${cause?.stack ?? cause}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ok   ${label}`);
};

run("a tool result projects as a tool entry with its name and body", () => {
  const view = projectEntry(recordOf(false));
  assert.equal(view.role, "tool");
  assert.equal(view.kind, "pi.tool-result");
  assert.equal(view.toolName, "iCloud Calendar.list_events");
  assert.equal(view.toolFailed, false);
  assert.equal(view.text, '{"status":"completed"}');
});

run("a failed tool result carries the failure bit", () => {
  const view = projectEntry(recordOf(true));
  assert.equal(view.toolFailed, true);
});

run("an assistant message has no tool facts", () => {
  const view = projectEntry({
    id: 8,
    conversationId: 1,
    kind: "pi.assistant",
    model: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }],
  });
  assert.equal(view.role, "assistant");
  assert.equal(view.toolName, undefined);
  assert.equal(view.toolFailed, undefined);
});
