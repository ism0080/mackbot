/**
 * approvals — the `mackbot_approvals` table, the path from a decision to a
 * resumed call, and the durable wait that keeps a decision from being lost.
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
 * Two steps are two chances to lose the second one. A Durable Object that
 * dies between the decision and the steer leaves a decided approval and a
 * paused call nobody resumes: the human's answer is on record and the call
 * waits forever. The wait is the recovery. {@link ApprovalWait} is a durable
 * task that polls for the decision and submits the HTTP path's own steer under
 * the same operation id, so pi's request-id idempotency joins the second
 * submission to the first instead of starting a second run.
 *
 * `request_id` and `session_id` are Executor's and pi's, and stay here. The
 * `ApprovalView` the browser sees is this module's projection of the row, and
 * it carries neither.
 */

import { Option, Schema } from "effect";
import type { PiWhenBusy } from "agents/harness/pi";
import { defineTask } from "@earendil-works/pi-durable";
import type { NextTaskState, Task } from "@earendil-works/pi-durable";

import type { ApprovalState } from "./executor-policy.ts";
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

// The state of one paused call, by the id Executor knows it by.
const REQUEST_STATE_SQL = "SELECT status FROM mackbot_approvals WHERE request_id = ?";

// The approval a requestId already has. A pause the bridge sees again is the
// same row, and the same wait: the wait starts with the first sighting.
const REQUEST_APPROVAL_SQL = "SELECT approval_id FROM mackbot_approvals WHERE request_id = ?";

// The row a delivery reads: the decision it carries, and where to steer it.
const DELIVERY_SQL =
  "SELECT request_id, session_id, status FROM mackbot_approvals WHERE approval_id = ?";

const RequestStateSchema = Schema.Struct({
  status: Schema.Literals(["pending", "allowed", "denied", "expired"]),
});

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

const DeliveryRecordSchema = Schema.Struct({
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
/** What the store knows about one paused call. */
export type { ApprovalState } from "./executor-policy.ts";

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

/**
 * The seams the store needs beyond its SQL. Both are optional: a store
 * without them behaves exactly as it did before the wait existed, and a host
 * that wires neither keeps the HTTP path as the only way a decision resumes.
 */
export interface ApprovalStoreOptions {
  /**
   * Starts the durable wait for a recorded pause. The host supplies it,
   * because the harness is what can create the task and the store does not
   * know the harness's type. The task belongs to the conversation of the
   * session it waits for, and it is a background task: a wait nobody answers
   * must not hold that conversation's idle wait open.
   */
  readonly startWait?: (wait: ApprovalWaitInput) => void;
  /**
   * Submits the steer a decision admits. The wait needs one of its own: the
   * HTTP path's steer is exactly what may have been lost.
   */
  readonly submit?: ApprovalSubmitter;
}

/** What one delivery attempt found. */
export type ApprovalDelivery =
  /** The steer went out. */
  | "delivered"
  /** The approval is still waiting for a human. */
  | "pending"
  /** This store does not hold the approval. */
  | "unknown";

/** What the row says about a delivery. */
type Delivery =
  | {
      readonly kind: "decided";
      readonly requestId: string;
      readonly session: string;
      readonly decision: ApprovalDecision;
    }
  | { readonly kind: "pending" }
  | { readonly kind: "unknown" };

export type ApprovalStore = {
  readonly record: (approval: ApprovalView) => void;
  readonly recordPaused: (paused: PausedApproval) => void;
  readonly pending: () => readonly ApprovalView[];
  /**
   * What the store knows about one paused call. The executor policy asks this
   * before it lets a model resume a call, so a requestId nobody approved is
   * "unknown" rather than "pending".
   */
  readonly stateOf: (requestId: string) => ApprovalState;
  readonly decide: (
    approvalId: string,
    decision: ApprovalDecision,
    submit: ApprovalSubmitter,
  ) => Promise<DecidedApproval | undefined>;
  /**
   * Submit the steer a decided approval is waiting for. The wait calls this:
   * the HTTP path may have recorded the decision and lost the steer, and the
   * steer it submits again carries the same operation id, so pi admits one
   * submission per approval.
   */
  readonly deliver: (approvalId: string) => Promise<ApprovalDelivery>;
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
  if (artifact === undefined)
    return `Approve ${tool}? The pause carried no draft input to preview.`;
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

export function createApprovalStore(
  storage: SqlStorage,
  options?: ApprovalStoreOptions,
): ApprovalStore {
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
    const approvalId = crypto.randomUUID();
    const now = Date.now();
    // A pause the bridge sees again is the same row, and the same wait: the
    // wait starts with the first sighting, not with every one of them.
    const known = read(executor, REQUEST_APPROVAL_SQL, paused.requestId);
    insert(
      Schema.decodeUnknownSync(ApprovalViewSchema)({
        approvalId,
        bot: paused.bot,
        toolPath: tool ?? "executor",
        summary: summaryOf(tool, artifact),
        artifact,
        status: "pending",
        requestedAt: now,
      }),
      paused.requestId,
      paused.session,
    );
    if (known.length > 0) return;
    options?.startWait?.({
      approvalId,
      requestId: paused.requestId,
      session: paused.session,
      deadline: now + WAIT_DEADLINE_MS,
    });
  };

  const pending = (): readonly ApprovalView[] => {
    ensureMigrated();
    return read(executor, PENDING_SQL).flatMap((row) => Option.toArray(rowToApproval(row)));
  };

  const stateOf = (requestId: string): ApprovalState => {
    ensureMigrated();
    const rows = read(executor, REQUEST_STATE_SQL, requestId);
    const record = Option.getOrUndefined(Schema.decodeUnknownOption(RequestStateSchema)(rows[0]));
    if (record === undefined) return "unknown";
    return record.status === "pending" ? "pending" : "decided";
  };

  /** The approval a decision can act on, or `undefined` when it cannot. */
  const decidable = (approvalId: string): DecidableApproval | undefined =>
    Option.getOrUndefined(
      Option.flatMap(
        Schema.decodeUnknownOption(DecidableRecordSchema)(
          read(executor, DECIDABLE_SQL, approvalId)[0],
        ),
        (record) =>
          record.status === "pending" && record.request_id !== null && record.session_id !== null
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

  /** What the row says about a delivery: a decision to carry, or none yet. */
  const deliveryOf = (approvalId: string): Delivery => {
    const record = Option.getOrUndefined(
      Schema.decodeUnknownOption(DeliveryRecordSchema)(read(executor, DELIVERY_SQL, approvalId)[0]),
    );
    if (record === undefined) return { kind: "unknown" };
    if (record.status !== "allowed" && record.status !== "denied") {
      return { kind: "pending" };
    }
    if (record.request_id === null || record.session_id === null) {
      return { kind: "unknown" };
    }
    return {
      kind: "decided",
      requestId: record.request_id,
      session: record.session_id,
      decision: { action: record.status === "allowed" ? "allow" : "deny" },
    };
  };

  /**
   * The steer a decided approval is waiting for. The decision comes from the
   * row, so the recovery carries the answer the human gave; the content a
   * human may have attached to it is not in the row and does not travel with
   * it.
   */
  const deliver = async (approvalId: string): Promise<ApprovalDelivery> => {
    ensureMigrated();
    const row = deliveryOf(approvalId);
    if (row.kind === "unknown") return "unknown";
    if (row.kind === "pending") return "pending";
    const submit = options?.submit;
    // Without a submitter the decision stands and the steer waits for one:
    // the wait keeps looking rather than giving up on a decided approval.
    if (submit === undefined) return "pending";
    await submit(
      resumeText(row.requestId, row.decision),
      approvalOperationId(approvalId),
      "steer",
      row.session,
    );
    return "delivered";
  };

  const store: ApprovalStore = {
    record,
    recordPaused,
    pending,
    stateOf,
    decide,
    deliver,
  };
  stores.add(store);
  return store;
}

/** The bot and addressing a pending approval needs; kept off {@link DecidedApproval}. */
interface DecidableApproval {
  readonly bot: string;
  readonly requestId: string;
  readonly session: string;
}

// ---------------------------------------------------------------------------
// The wait: the pause leaves a durable task behind, and the task delivers.
// ---------------------------------------------------------------------------

/**
 * How long the wait sleeps between two looks at the approval. Short enough
 * that a human who pressed the button sees the effect at once, long enough
 * that a bot nobody answers does not churn.
 */
const WAIT_POLL_MS = 30_000;

/**
 * How long the wait keeps looking. A day is long enough that a human who
 * comes back to an approval still finds the wait alive; after that the
 * approval is stale, and the HTTP path is the only way left to decide it.
 */
const WAIT_DEADLINE_MS = 24 * 60 * 60 * 1000;

/** The approval a wait watches, and the clock at which it stops watching. */
export interface ApprovalWaitInput {
  readonly approvalId: string;
  /** Executor's id for the paused call. */
  readonly requestId: string;
  /** The pi conversation the call paused in. */
  readonly session: string;
  /** The clock at which the wait gives up. */
  readonly deadline: number;
}

/** Where the wait is: asleep, or looking at the approval. */
export type ApprovalWaitCheckpoint =
  | { readonly phase: "wait" }
  | { readonly phase: "deliver"; readonly delivered: boolean };

/** The receipt of a wait that delivered its decision. */
export interface ApprovalWaitOutcome {
  /** The approval whose decision was delivered. */
  readonly approvalId: string;
  /** The operation id the steer carried: pi admits one submission under it. */
  readonly operationId: string;
}

/**
 * The stores this isolate holds. The wait runs inside the harness, which knows
 * nothing of the store that minted its input, so the wait asks here for the
 * store that holds the approval. One Durable Object is one bot, so an isolate
 * holds one store; the lookup asks each of them and stops at the one that
 * holds the approval.
 */
const stores = new Set<ApprovalStore>();

/** The delivery a wait asks for: the store that holds the approval answers. */
const deliverApproval = async (approvalId: string): Promise<ApprovalDelivery> => {
  for (const store of stores) {
    const delivery = await store.deliver(approvalId);
    if (delivery !== "unknown") return delivery;
  }
  return "unknown";
};

/** The clock of the next look, or the deadline when that comes first. */
const nextPoll = (now: number, deadline: number): number => Math.min(now + WAIT_POLL_MS, deadline);

/** The outcome of a wait that delivered the decision. */
const delivered = (
  approvalId: string,
): NextTaskState<ApprovalWaitCheckpoint, ApprovalWaitOutcome> => ({
  status: "terminal",
  outcome: {
    status: "completed",
    result: { approvalId, operationId: approvalOperationId(approvalId) },
  },
});

/** The outcome of a wait that nobody decided in time. */
const expired = (
  approvalId: string,
): NextTaskState<ApprovalWaitCheckpoint, ApprovalWaitOutcome> => ({
  status: "terminal",
  outcome: {
    status: "failed",
    error: { message: `the approval ${approvalId} was not decided before its deadline` },
  },
});

/**
 * The wait a paused call leaves behind.
 *
 * The wait holds no invocation between its polls: it sleeps until the next
 * one, and the Harness clock wakes it. The sleep is durable, so a Durable
 * Object that dies between a decision and its steer finds the wait when it
 * comes back, and the wait delivers what the HTTP path never got to.
 *
 * The delivery is the HTTP path's own steer under the same operation id, so
 * pi's request-id idempotency joins it to the first submission instead of
 * starting a second run.
 *
 * The wait phase owns the sleep: the deliver phase hands the wait over to it
 * when the approval is still undecided, so one poll is one sleep long.
 */
export const ApprovalWait: Task<
  ApprovalWaitInput,
  ApprovalWaitCheckpoint,
  ApprovalWaitOutcome,
  object
> = defineTask<ApprovalWaitInput, ApprovalWaitCheckpoint, ApprovalWaitOutcome>({
  name: "mackbot.approval-wait",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: async (task, runtime, context) => {
      const until = nextPoll(runtime.now(), task.input.deadline);
      if (until <= runtime.now()) {
        await runtime.commit(() => expired(task.input.approvalId), context);
        return;
      }
      await runtime.sleepUntil(until, { phase: "deliver", delivered: false }, context);
    },
    deliver: async (task, runtime, context) => {
      if (task.state.checkpoint.delivered) {
        await runtime.commit(() => delivered(task.input.approvalId), context);
        return;
      }
      if ((await deliverApproval(task.input.approvalId)) === "delivered") {
        await runtime.commit(
          () => ({ status: "running", checkpoint: { phase: "deliver", delivered: true } }),
          context,
        );
        return;
      }
      if (runtime.now() >= task.input.deadline) {
        await runtime.commit(() => expired(task.input.approvalId), context);
        return;
      }
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "wait" } }), context);
    },
  },
  abort: async (task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});
