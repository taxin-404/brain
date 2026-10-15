import { newEventId } from "./crypto";

export interface AuditEntry {
  actor: "user" | "agent" | "system";
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

export async function writeAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (id, ts, actor, action, target_type, target_id, before_json, after_json, reason)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      newEventId(),
      Date.now(),
      entry.actor,
      entry.action,
      entry.targetType,
      entry.targetId,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.reason ?? null,
    )
    .run();
}
