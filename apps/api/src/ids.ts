/**
 * ids - pi's numeric ids, as the wire spells them.
 *
 * pi names conversations and tasks by positive integers; mackbot carries them
 * as decimal strings. The front door decodes them with {@link PiIdSchema} so a
 * malformed id is a `400`, and the bot converts them with the same schema, so
 * the two can never disagree about what an id looks like.
 */

import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A positive decimal integer without a leading zero, small enough to stay a safe integer. */
export const PiIdSchema = Schema.String.check(Schema.isPattern(/^[1-9]\d{0,14}$/u));

const decodePiId = Schema.decodeUnknownEffect(PiIdSchema);

export const conversationIdOf = (
  session: string,
): Effect.Effect<ConversationId, Schema.SchemaError> =>
  // SAFETY: pi session ids are numeric conversation ids; the schema checked the digits.
  decodePiId(session).pipe(Effect.map((id) => Number(id) as ConversationId));

export const taskIdOf = (taskId: string): Effect.Effect<TaskId, Schema.SchemaError> =>
  // SAFETY: pi task ids are numeric task ids; the schema checked the digits.
  decodePiId(taskId).pipe(Effect.map((id) => Number(id) as TaskId));
