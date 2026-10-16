/**
 * approvals — the `mackbot_approvals` table.
 *
 * The executor bridge detects a paused call and records it here; the triage
 * home then reads every bot's pending approvals through `/status`, because the
 * home screen has to know what is blocked before it subscribes to anything.
 * The row is the durable fact; the `ApprovalView` the browser sees is this
 * module's projection of it.
 *
 * What is not here yet: the pause detector's sink and the decision path. They
 * belong to the executor bridge and to `executor_resume`, and this table is
 * what they write.
 */

import { Option, Schema } from "effect";

import { read, write } from "./sql.ts";
import type { SqlExecutor, SqlRow, SqlStorage } from "./sql.ts";
import { ApprovalViewSchema } from "./web-contract.ts";
import type { ApprovalView } from "./web-contract.ts";

const ArtifactSchema = Schema.fromJsonString(
  Schema.Struct({ label: Schema.String, body: Schema.String }),
);

const CREATE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS mackbot_approvals (approval_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, thread TEXT, tool_path TEXT NOT NULL, summary TEXT NOT NULL, artifact TEXT, status TEXT NOT NULL, requested_at INTEGER NOT NULL, decided_at INTEGER)";

const INSERT_SQL =
  "INSERT OR IGNORE INTO mackbot_approvals (approval_id, bot_id, thread, tool_path, summary, artifact, status, requested_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";

const COLUMNS =
  "approval_id, bot_id, thread, tool_path, summary, artifact, status, requested_at, decided_at";

// Oldest first: the home screen shows what has been waiting longest.
const PENDING_SQL = `SELECT ${COLUMNS} FROM mackbot_approvals WHERE status = 'pending' ORDER BY requested_at ASC`;

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

export type ApprovalStore = {
  readonly record: (approval: ApprovalView) => void;
  readonly pending: () => readonly ApprovalView[];
};

export function createApprovalStore(storage: SqlStorage): ApprovalStore {
  const executor: SqlExecutor = storage.sql;
  let migrated = false;

  const ensureMigrated = (): void => {
    if (migrated) return;
    write(executor, CREATE_TABLE_SQL);
    migrated = true;
  };

  const record = (approval: ApprovalView): void => {
    ensureMigrated();
    // The browser-facing shape is validated before it is durable, so a paused
    // envelope can never write a row `/status` cannot project.
    const validated = Schema.decodeUnknownSync(ApprovalViewSchema)(approval);
    write(
      executor,
      INSERT_SQL,
      validated.approvalId,
      validated.bot,
      validated.thread ?? null,
      validated.toolPath,
      validated.summary,
      validated.artifact === undefined ? null : JSON.stringify(validated.artifact),
      validated.status,
      validated.requestedAt,
      validated.decidedAt ?? null,
    );
  };

  const pending = (): readonly ApprovalView[] => {
    ensureMigrated();
    return read(executor, PENDING_SQL).flatMap((row) => Option.toArray(rowToApproval(row)));
  };

  return { record, pending };
}
