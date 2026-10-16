/**
 * approvals — the `mackbot_approvals` table and the path from a decision to a
 * resumed call.
 *
 * The executor bridge detects a paused call and records it here through
 * {@link ApprovalStore.recordPaused}. Recording is idempotent on Executor's
 * `requestId`, so one paused call is one row however many times the bridge
 * observes it. The triage home then reads every bot's pending approvals through
 * `/status`, because the home screen has to know what is blocked before it
 * subscribes to anything.
 *
 * A decision is durable first and a submission second. The steer is the only
 * thing that turns a decision into a submission, and it goes through the
 * harness so the model calls `executor_resume` itself: the resume is a pi tool
 * with unsafe replay, and a resume the transcript never records would authorize
 * an effect nobody can audit.
 *
 * `request_id` and `session_id` are Executor's and pi's, and stay here. The
 * `ApprovalView` the browser sees is this module's projection of the row, and
 * it carries neither.
 */

import { Option, Schema } from "effect";
import type { PiWhenBusy } from "agents/harness/pi";

import { approvalOperationId } from "./operation.ts";
import { read, write } from "./sql.ts";
import type { SqlExecutor, SqlRow, SqlStorage } from "./sql.ts";
import { ApprovalViewSchema } from "./web-contract.ts";
import type { ApprovalDecision, ApprovalView } from "./web-contract.ts";

const ArtifactSchema = Schema.fromJsonString(
  Schema.Struct({ label: Schema.String, body: Schema.String }),
);

const CREATE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS mackbot_approvals (approval_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, thread TEXT, tool_path TEXT NOT NULL, summary TEXT NOT NULL, artifact TEXT, status TEXT NOT NULL, requested_at INTEGER NOT NULL, decided_at INTEGER, request_id TEXT, session_id TEXT)";

/**
 * One pause is one row. The index is what makes `recordPaused` idempotent: the
 * second insert of a `requestId` is ignored rather than minting a second
 * approval for a call that has not changed.
 */
const CREATE_REQUEST_INDEX_SQL =
  "CREATE UNIQUE INDEX IF NOT EXISTS mackbot_approvals_request ON mackbot_approvals (request_id)";

const INSERT_SQL =
  "INSERT OR IGNORE INTO mackbot_approvals (approval_id, bot_id, thread, tool_path, summary, artifact, status, requested_at, decided_at, request_id, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

const COLUMNS =
  "approval_id, bot_id, thread, tool_path, summary, artifact, status, requested_at, decided_at";

// Oldest first: the home screen shows what has been waiting longest.
const PENDING_SQL = `SELECT ${COLUMNS} FROM mackbot_approvals WHERE status = 'pending' ORDER BY requested_at ASC`;

// The decision's own row, read before the write: the store is the single owner
// of "is this still undecided".
const DECIDABLE_SQL =
  "SELECT approval_id, bot_id, request_id, session_id, status FROM mackbot_approvals WHERE approval_id = ?";

// Guarded on `pending` so a decided row can never be rewritten.
const DECIDE_SQL =
  "UPDATE mackbot_approvals SET status = ?, decided_at = ? WHERE approval_id = ? AND status = 'pending'";

const ApprovalRecordSchema = Schema.Struct({
  approval_id: Schema.String,
  bot_id: Schema.String,
  thread: Schema.NullOr(Schema.String),
  tool_path: Schema.String,
  summary: Schema.String,
  artifact: Schema.NullOr(Schema.String),
  status: Schema.Literals(["pending", "allowed", "denied", "expired"]),
  requested_at: Schema.Number,
  decided_at: Schema.NullOr(Schema.Number),
});

const DecidableRecordSchema = Schema.Struct({
  approval_id: Schema.String,
  bot_id: Schema.String,
  request_id: Schema.NullOr(Schema.String),
  session_id: Schema.NullOr(Schema.String),
  status: Schema.Literals(["pending", "allowed", "denied", "expired"]),
});

/**
 * The fields a pause envelope may carry that are safe to keep. `approvalUrl` is
 * deliberately absent: it is signed for the org connection, so it is relayed to
 * the human and never stored.
 */
const EnvelopeSchema = Schema.Struct({
  invocation: Schema.optional(
    Schema.Struct({
      path: Schema.optional(Schema.String),
      tool: Schema.optional(Schema.String),
      input: Schema.optional(Schema.Unknown),
    }),
  ),
});

const EnvelopeFromText = Schema.fromJsonString(EnvelopeSchema);

type Envelope = typeof EnvelopeSchema.Type;

const rowToApproval = (row: SqlRow): Option.Option<ApprovalView> =>
  Option.flatMap(Schema.decodeUnknownOption(ApprovalRecordSchema)(row), (record) =>
    Schema.decodeUnknownOption(ApprovalViewSchema)({
      approvalId: record.approval_id,
      bot: record.bot_id,
      thread: record.thread ?? undefined,
      toolPath: record.tool_path,
      summary: record.summary,
      artifact:
        record.artifact === null
          ? undefined
          : Option.getOrUndefined(Schema.decodeUnknownOption(ArtifactSchema)(record.artifact)),
      status: record.status,
      requestedAt: record.requested_at,
      decidedAt: record.decided_at ?? undefined,
    }),
  );

/** One paused call, as the bridge found it. */
export interface PausedApproval {
  readonly bot: string;
  /**
   * The pi conversation the call paused in. A decision steers this one, so it is
   * required: an approval the store cannot address is not resumable.
   */
  readonly session: string;
  /** Executor's id for the paused call. DO-private. */
  readonly requestId: string;
  /** Executor's pause payload: `structuredContent` when it sent one, else the text. */
  readonly envelope: string;
}

/** What a decision records, with nothing the browser must not see. */
export interface DecidedApproval {
  readonly approvalId: string;
  readonly bot: string;
  readonly status: "allowed" | "denied";
  readonly decidedAt: number;
}

/**
 * The one way a decision becomes a submission. `Bot.submit` is the intended
 * implementation, so the steer gets a run window, a stream and an audit row
 * like any other work.
 */
export type ApprovalSubmitter = (
  input: string,
  operationId: string,
  whenBusy: PiWhenBusy,
  session: string,
) => Promise<{ readonly accepted: boolean }>;

export type ApprovalStore = {
  readonly record: (approval: ApprovalView) => void;
  readonly recordPaused: (paused: PausedApproval) => void;
  readonly pending: () => readonly ApprovalView[];
  readonly decide: (
    approvalId: string,
    decision: ApprovalDecision,
    submit: ApprovalSubmitter,
  ) => Promise<DecidedApproval | undefined>;
};

const envelopeOf = (raw: string): Envelope | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(EnvelopeFromText)(raw));

const toolOf = (envelope: Envelope | undefined): string | undefined =>
  envelope?.invocation?.path ?? envelope?.invocation?.tool;

/**
 * The draft the call would carry out, when the envelope carries one. An
 * approval that cannot show what it will do is the one thing the design calls
 * unacceptable, so the input is rendered verbatim; an absent input is not a
 * draft and leaves the artifact off, and {@link summaryOf} says so.
 */
const artifactOf = (
  tool: string | undefined,
  envelope: Envelope | undefined,
): { readonly label: string; readonly body: string } | undefined => {
  const input = envelope?.invocation?.input;
  if (input === undefined) return undefined;
  return {
    label: `${tool ?? "Executor"} — what it will do`,
    body: JSON.stringify(input, null, 2),
  };
};

/**
 * A phrase a human can decide on. Executor's `model` elicitation mode returns
 * the requestId and little else, so the summary states plainly what the pause
 * could not tell us rather than inventing a promise.
 */
const summaryOf = (
  tool: string | undefined,
  artifact: { readonly label: string; readonly body: string } | undefined,
): string => {
  if (tool === undefined) {
    return "Executor paused a call for your approval. The pause carried no tool name or draft to show.";
  }
  if (artifact === undefined) return `Approve ${tool}? The pause carried no draft input to preview.`;
  return `Approve ${tool}?`;
};

/** The steer the model answers: the requestId it must resume, and how. */
const resumeText = (requestId: string, decision: ApprovalDecision): string => {
  const action = decision.action === "allow" ? "accept" : "decline";
  const response =
    decision.content === undefined ? { action } : { action, content: decision.content };
  return [
    `A human ${decision.action === "allow" ? "approved" : "denied"} the Executor request ${JSON.stringify(requestId)} that paused earlier.`,
    `Call executor_resume with requestId ${JSON.stringify(requestId)} and response ${JSON.stringify(response)}.`,
    "Do not repeat the original call; the resume is what carries the decision out.",
  ].join(" ");
};

export function createApprovalStore(storage: SqlStorage): ApprovalStore {
  const executor: SqlExecutor = storage.sql;
  let migrated = false;

  // The table is created lazily, so a bot that already ran the previous
  // revision has it without the two DO-private columns. `ADD COLUMN` has no
  // `IF NOT EXISTS`, so the current shape is read first.
  const addColumn = (name: string): void => {
    const present = read(executor, "PRAGMA table_info(mackbot_approvals)").some(
      (row) => row.name === name,
    );
    if (!present) write(executor, `ALTER TABLE mackbot_approvals ADD COLUMN ${name} TEXT`);
  };

  const ensureMigrated = (): void => {
    if (migrated) return;
    write(executor, CREATE_TABLE_SQL);
    addColumn("request_id");
    addColumn("session_id");
    write(executor, CREATE_REQUEST_INDEX_SQL);
    migrated = true;
  };

  const insert = (
    approval: ApprovalView,
    requestId: string | null,
    session: string | null,
  ): void => {
    write(
      executor,
      INSERT_SQL,
      approval.approvalId,
      approval.bot,
      approval.thread ?? null,
      approval.toolPath,
      approval.summary,
      approval.artifact === undefined ? null : JSON.stringify(approval.artifact),
      approval.status,
      approval.requestedAt,
      approval.decidedAt ?? null,
      requestId,
      session,
    );
  };

  const record = (approval: ApprovalView): void => {
    ensureMigrated();
    // The browser-facing shape is validated before it is durable, so a paused
    // envelope can never write a row `/status` cannot project.
    insert(Schema.decodeUnknownSync(ApprovalViewSchema)(approval), null, null);
  };

  const recordPaused = (paused: PausedApproval): void => {
    ensureMigrated();
    const envelope = envelopeOf(paused.envelope);
    const tool = toolOf(envelope);
    const artifact = artifactOf(tool, envelope);
    insert(
      Schema.decodeUnknownSync(ApprovalViewSchema)({
        approvalId: crypto.randomUUID(),
        bot: paused.bot,
        toolPath: tool ?? "executor",
        summary: summaryOf(tool, artifact),
        artifact,
        status: "pending",
        requestedAt: Date.now(),
      }),
      paused.requestId,
      paused.session,
    );
  };

  const pending = (): readonly ApprovalView[] => {
    ensureMigrated();
    return read(executor, PENDING_SQL).flatMap((row) => Option.toArray(rowToApproval(row)));
  };

  /** The approval a decision can act on, or `undefined` when it cannot. */
  const decidable = (approvalId: string): DecidableApproval | undefined =>
    Option.getOrUndefined(
      Option.flatMap(
        Schema.decodeUnknownOption(DecidableRecordSchema)(
          read(executor, DECIDABLE_SQL, approvalId)[0],
        ),
        (record) =>
          record.status === "pending" &&
          record.request_id !== null &&
          record.session_id !== null
            ? Option.some({
                bot: record.bot_id,
                requestId: record.request_id,
                session: record.session_id,
              })
            : Option.none(),
      ),
    );

  const decide = async (
    approvalId: string,
    decision: ApprovalDecision,
    submit: ApprovalSubmitter,
  ): Promise<DecidedApproval | undefined> => {
    ensureMigrated();
    const row = decidable(approvalId);
    if (row === undefined) return undefined;
    const decidedAt = Date.now();
    const status = decision.action === "allow" ? "allowed" : "denied";
    // Durable before the steer: a crash after this leaves the decision recorded
    // and the row out of `pending`, a crash before it leaves the approval alone.
    write(executor, DECIDE_SQL, status, decidedAt, approvalId);
    await submit(
      resumeText(row.requestId, decision),
      approvalOperationId(approvalId),
      "steer",
      row.session,
    );
    return { approvalId, bot: row.bot, status, decidedAt };
  };

  return { record, recordPaused, pending, decide };
}

/** The bot and addressing a pending approval needs; kept off {@link DecidedApproval}. */
interface DecidableApproval {
  readonly bot: string;
  readonly requestId: string;
  readonly session: string;
}
