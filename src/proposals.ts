import { writeAudit } from "./audit";
import { charge } from "./budget";
import { newEventId } from "./crypto";
import type { Env, Scope } from "./env";
import { json } from "./http";

export type ProposalKind = "correction" | "forget" | "block_edit" | "procedure";

export const PROPOSAL_TTL_MS = 14 * 86_400_000;

/** Charge rejections surface the same codes as ingest (over_limit/breaker_open). */
export class ProposalError extends Error {
  constructor(
    readonly code: "over_limit" | "breaker_open",
    message: string,
  ) {
    super(message);
    this.name = "ProposalError";
  }
}

/** Tier rules (design v1.2 amendment 2): auto iff reversible (corrections are)
 *  AND the evidence is an actor=user turn AND the fact is not sensitive.
 *  Forget/block_edit/procedure are always manual; so is a missing/unknown fact. */
export function computeReviewMode(
  kind: ProposalKind,
  factSensitivity: string | null,
  evidenceActor: string | null,
): "auto" | "manual" {
  return kind === "correction" && factSensitivity === "normal" && evidenceActor === "user" ? "auto" : "manual";
}

export interface ProposalInput {
  kind: ProposalKind;
  payload: unknown;
  target_type?: string;
  target_id?: string;
  evidence_event_id?: string;
  sensitivity?: string;
}

/** Land a reviewable proposal row (never applies anything). Charges one row
 *  like ingest; on rejection nothing is written. */
export async function createProposal(env: Env, scope: Scope, input: ProposalInput): Promise<{ id: string }> {
  const verdict = await charge(env.BRAIN_DB, scope, 1);
  if (verdict === "over_limit") throw new ProposalError("over_limit", "daily propose cap reached");
  if (verdict === "breaker_open") throw new ProposalError("breaker_open", "global write breaker open");

  let evidenceActor: string | null = null;
  if (input.evidence_event_id) {
    const row = await env.BRAIN_DB.prepare(`SELECT actor FROM events WHERE id = ?1`)
      .bind(input.evidence_event_id)
      .first<{ actor: string }>();
    evidenceActor = row?.actor ?? null;
  }

  const id = newEventId();
  const now = Date.now();
  const reviewMode = computeReviewMode(input.kind, input.sensitivity ?? "normal", evidenceActor);
  await env.BRAIN_DB.prepare(
    `INSERT INTO proposals (id, kind, payload_json, target_type, target_id, evidence_event_id, sensitivity,
                            review_mode, status, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?10)`,
  )
    .bind(
      id,
      input.kind,
      JSON.stringify(input.payload ?? {}),
      input.target_type ?? null,
      input.target_id ?? null,
      input.evidence_event_id ?? null,
      input.sensitivity ?? "normal",
      reviewMode,
      now,
      now + PROPOSAL_TTL_MS,
    )
    .run();

  await writeAudit(env.BRAIN_DB, {
    actor: scope === "ADMIN" ? "user" : "agent",
    action: "create",
    targetType: "proposal",
    targetId: id,
    after: { kind: input.kind, review_mode: reviewMode },
  });

  return { id };
}

interface ProposalRow {
  id: string;
  kind: string;
  payload_json: string;
  target_type: string | null;
  target_id: string | null;
  evidence_event_id: string | null;
  sensitivity: string;
  review_mode: string;
  status: string;
  created_at: number;
  expires_at: number;
}

/** Newest first; default status=pending, limit 20 (≤100). */
export async function listProposals(env: Env, opts: { status?: string; limit?: number } = {}): Promise<unknown[]> {
  const status = opts.status ?? "pending";
  const limit = Math.max(1, Math.min(100, Math.trunc(opts.limit ?? 20)));
  const { results } = await env.BRAIN_DB.prepare(
    `SELECT id, kind, payload_json, target_type, target_id, evidence_event_id, sensitivity, review_mode,
            status, created_at, expires_at
     FROM proposals WHERE status = ?1
     ORDER BY created_at DESC, id DESC LIMIT ?2`,
  )
    .bind(status, limit)
    .all<ProposalRow>();
  return results.map(({ payload_json, ...r }) => ({ ...r, payload: JSON.parse(payload_json) }));
}

/** Retire pending proposals past their 14-day TTL. Returns rows expired. */
export async function expireProposals(env: Env, now: number = Date.now()): Promise<number> {
  const res = await env.BRAIN_DB.prepare(
    `UPDATE proposals SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?1`,
  )
    .bind(now)
    .run();
  return res.meta.changes ?? 0;
}

export async function handleListProposals(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "pending";
  const limitRaw = url.searchParams.get("limit");
  let limit = limitRaw === null ? 20 : Number(limitRaw);
  if (!Number.isFinite(limit)) limit = 20;
  return json({ proposals: await listProposals(env, { status, limit }) });
}
