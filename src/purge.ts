import type { Env } from "./env";
import { writeAudit } from "./audit";
import { ingestEvents } from "./ingest";
import { json } from "./http";

export const CONFIRM_TTL_MS = 300_000; // single-use, 5 minutes (spec §7)

export class PurgeError extends Error {
  constructor(
    readonly code: "invalid_token" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "PurgeError";
  }
}

export async function mintConfirmToken(env: Env, target: string): Promise<{ token: string; expires_at: number }> {
  const now = Date.now();
  const expires_at = now + CONFIRM_TTL_MS;
  const token = crypto.randomUUID();
  await env.BRAIN_DB.prepare(
    `INSERT INTO confirm_tokens (token, target, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(token, target, now, expires_at)
    .run();
  return { token, expires_at };
}

/** Verify and consume a single-use confirm token for `target` (spec §7).
 *  Extracted from `purgeEvent` so the review engine can gate fact purges with
 *  the same out-of-band confirmation (Phase 3). */
export async function consumeConfirmToken(env: Env, target: string, confirmToken: string): Promise<void> {
  const db = env.BRAIN_DB;
  const now = Date.now();

  // 1. verify
  const tok = await db
    .prepare(`SELECT target, expires_at, used_at FROM confirm_tokens WHERE token = ?1`)
    .bind(confirmToken)
    .first<{ target: string; expires_at: number; used_at: number | null }>();
  if (!tok || tok.used_at !== null || tok.expires_at <= now || tok.target !== target) {
    throw new PurgeError("invalid_token", "confirm token invalid");
  }

  // 2. consume (single-use)
  const consumed = await db
    .prepare(`UPDATE confirm_tokens SET used_at = ?1 WHERE token = ?2 AND used_at IS NULL`)
    .bind(now, confirmToken)
    .run();
  if ((consumed.meta.changes ?? 0) !== 1) throw new PurgeError("invalid_token", "confirm token already used");
}

/** Crypto-shred purge — spec §4's exact 6-step sequence (plus verify/consume/audit):
 *  1 verify token (exists, unused, unexpired, target matches)
 *  2 consume it (single-use; reject when 0 rows change)
 *  3 load row (not_found; already-redacted => idempotent {purged:false})
 *  4 FTS 'delete' with the old excerpt
 *  5 R2 delete payloads/{id}        6 DELETE event_keys row
 *  7 whitelisted UPDATE (redacted 0->1, excerpt NULL)
 *  8 purge_tombstone event (session carried over)
 *  9 audit_log append
 *  Steps 4-7 are not transactional across systems — a mid-sequence failure leaves
 *  the event metadata un-purged and the tombstone unwritten; retrying with a fresh
 *  token resumes safely (steps are individually idempotent: FTS delete of an
 *  absent row is a no-op, R2 delete of an absent key succeeds). */
export async function purgeEvent(env: Env, eventId: string, confirmToken: string, reason: string): Promise<{ purged: boolean }> {
  await consumeConfirmToken(env, `event:${eventId}`, confirmToken);
  return purgeEventCore(env, eventId, reason);
}

/** Steps 3-9 of the sequence, with the confirmation already consumed — the
 *  review engine's `forget` apply path reuses this after its own token check. */
export async function purgeEventCore(
  env: Env,
  eventId: string,
  reason: string,
  actor: "user" | "system" = "user",
): Promise<{ purged: boolean }> {
  const db = env.BRAIN_DB;

  // 3. load
  const row = await db
    .prepare(`SELECT rowid, excerpt, session_id, redacted FROM events WHERE id = ?1`)
    .bind(eventId)
    .first<{ rowid: number; excerpt: string | null; session_id: string | null; redacted: number }>();
  if (!row) throw new PurgeError("not_found", "event not found");
  if (row.redacted === 1) return { purged: false };

  // 4. FTS5 external-content delete must be handed the OLD values
  await db.prepare(`INSERT INTO events_fts(events_fts, rowid, excerpt) VALUES ('delete', ?1, ?2)`).bind(row.rowid, row.excerpt).run();
  // 5. crypto-shred the raw payload
  await env.BRAIN_RAW.delete(`payloads/${eventId}`);
  // 6. wrapped data key
  await db.prepare(`DELETE FROM event_keys WHERE event_id = ?1`).bind(eventId).run();
  // 7. whitelisted metadata transition
  await db.prepare(`UPDATE events SET redacted = 1, excerpt = NULL WHERE id = ?1`).bind(eventId).run();

  // 8. tombstone keeps a trace in the same session (ADMIN charge-exempt)
  await ingestEvents(env, "ADMIN", [
    {
      source: "manual",
      actor: "user",
      kind: "purge_tombstone",
      session_id: row.session_id ?? undefined,
      payload: { purged_event_id: eventId, reason },
    },
  ]);

  // 9. audit
  await writeAudit(db, {
    actor,
    action: "purge",
    targetType: "event",
    targetId: eventId,
    before: { excerpt: row.excerpt, session_id: row.session_id },
    reason,
  });

  return { purged: true };
}

export async function handleMintToken(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { target?: unknown } | null;
  if (!body || typeof body.target !== "string" || body.target.length === 0 || body.target.length > 200) {
    return json({ error: "bad_request", message: "target required" }, 400);
  }
  return json(await mintConfirmToken(env, body.target), 201);
}

export async function handlePurge(request: Request, env: Env, eventId: string): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { confirm_token?: unknown; reason?: unknown } | null;
  if (!body || typeof body.confirm_token !== "string") {
    return json({ error: "bad_request", message: "confirm_token required" }, 400);
  }
  const reason = typeof body.reason === "string" ? body.reason : "";
  try {
    return json(await purgeEvent(env, eventId, body.confirm_token, reason), 200);
  } catch (err) {
    if (err instanceof PurgeError) {
      return json({ error: err.code, message: err.message }, err.code === "not_found" ? 404 : 400);
    }
    throw err;
  }
}
