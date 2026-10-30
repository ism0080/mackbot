/**
 * commitments — what the bot still owes its user, as durable per-conversation state.
 *
 * The list lives in a document committed atomically with the transcript, so it
 * survives compaction: a summary may drop the conversation's wording, but the
 * commitments that are still open stay readable. Two tools write the list and
 * one prompt section shows it — `commitment_add` takes a commitment,
 * `commitment_close` retires one by id, and the `commitments` section puts the
 * open ones in front of the model before every request.
 *
 * The section renders nothing while the list is empty, so an idle conversation
 * adds no prompt text and the provider's prompt cache stays warm.
 *
 * A commitment's id is a hash of the tool call's task id and its text, never a
 * random uuid: a call replayed after a crash has to land on the same
 * commitment rather than add a second one.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { Extension, TaskId } from "@earendil-works/pi-durable";
import { currentTimeMillis } from "./clock.ts";

/**
 * One commitment the bot owes its user.
 *
 * A type alias, not an interface: the document's value has to be JSON, and only
 * an alias of an object type gets the implicit index signature `JsonValue`
 * requires.
 */
export type Commitment = {
  readonly id: string;
  readonly text: string;
  readonly status: "open" | "closed";
  readonly at: number;
};

/** The commitments of one conversation. */
export const CommitmentsDoc = defineDoc<{ items: Commitment[] }>({
  kind: "mackbot.commitments",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: [] }),
  checkpointWhen: () => false,
});

/** The commitments that are still open. */
export const openCommitments = (items: readonly Commitment[]): readonly Commitment[] =>
  items.filter((item) => item.status === "open");

/**
 * The id of a commitment: FNV-1a over the tool call's task id and the text.
 *
 * The task id is the call's identity across a crash, and the text keeps two
 * calls of one task apart, so the same call always yields the same id.
 */
const commitmentId = (taskId: TaskId, text: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(`${taskId}\u0000${text}`)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
};

const addCommitment = defineTool({
  name: "commitment_add",
  description:
    "Record a commitment the bot owes its user, so it outlives compaction. One line, in the user's own words. A commitment that is already open is not recorded twice.",
  parameters: Type.Object({
    text: Type.String({ description: "What the bot committed to, in one line." }),
  }),
  replay: "safe",
  execute: async (args, api, context) => {
    const id = commitmentId(api.taskId, args.text);
    const outcome = await api.commit(async (tx) => {
      const doc = await tx.doc(CommitmentsDoc, api.conversationId);
      const replayed = doc.items.find((item) => item.id === id);
      if (replayed !== undefined) return { kind: "replayed" as const, id: replayed.id };
      const tracked = doc.items.find((item) => item.status === "open" && item.text === args.text);
      if (tracked !== undefined) return { kind: "tracked" as const, id: tracked.id };
      doc.items.push({ id, text: args.text, status: "open", at: currentTimeMillis() });
      return { kind: "added" as const, id };
    }, context);
    if (outcome.kind === "added") {
      return {
        output: [{ type: "text", text: `Recorded commitment ${outcome.id}: ${args.text}` }],
      };
    }
    if (outcome.kind === "tracked") {
      return {
        output: [
          {
            type: "text",
            text: `Commitment ${outcome.id} is already open: ${args.text}`,
          },
        ],
      };
    }
    return {
      output: [{ type: "text", text: `Commitment ${outcome.id} is already recorded.` }],
    };
  },
});

const closeCommitment = defineTool({
  name: "commitment_close",
  description:
    "Close a commitment that is no longer owed, by the id the commitments section shows. An unknown id is an error.",
  parameters: Type.Object({
    id: Type.String({ description: "The id of the commitment to close." }),
  }),
  replay: "safe",
  execute: async (args, api, context) => {
    const closed = await api.commit(async (tx) => {
      const doc = await tx.doc(CommitmentsDoc, api.conversationId);
      const item = doc.items.find((candidate) => candidate.id === args.id);
      if (item === undefined) return undefined;
      const text = item.text;
      item.status = "closed";
      return text;
    }, context);
    if (closed === undefined) {
      return {
        isError: true,
        output: [{ type: "text", text: `No commitment with id ${args.id}.` }],
      };
    }
    return {
      output: [{ type: "text", text: `Closed commitment ${args.id}: ${closed}` }],
    };
  },
});

const commitmentsSection = section("commitments", async (input, renderContext) => {
  const doc = await input.read.snapshot(CommitmentsDoc, input.conversationId, renderContext);
  const open = doc === undefined ? [] : openCommitments(doc.items);
  if (open.length === 0) return undefined;
  return open.map((item) => `${item.id} ${item.text}`).join("\n");
});

/** The tools and the prompt section that read and write the doc. */
export const commitmentsExtension: Extension = defineExtension({
  name: "mackbot-commitments",
  tools: [addCommitment, closeCommitment],
  sections: [commitmentsSection],
});
