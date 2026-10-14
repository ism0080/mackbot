/**
 * AuditService — abstraction over append-only audit storage.
 */
import type { AuditEvent } from "../audit-log.ts";

export interface AuditService {
  readonly append: (event: AuditEvent) => Promise<void>;
  readonly list: (limit?: number) => Promise<readonly AuditEvent[]>;
  readonly migrate: () => void | Promise<void>;
}
