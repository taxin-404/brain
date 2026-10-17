import type { Env, Scope } from "./env";
import { TRUST } from "./env";
import { charge } from "./budget";
import { contentHmac, contentSigningSecret, encryptPayload, newEventId } from "./crypto";
import { buildExcerpt, redactPayload, redactText } from "./redact";
import { json } from "./http";

export interface EventInput {
  id?: string;
  ts?: number;
  source: "opencode" | "file" | "github" | "manual";
  actor: "user" | "assistant" | "tool" | "external";
  kind: string;
  session_id?: string;
  privacy?: "normal" | "sensitive" | "restricted";
  excerpt?: string;
  payload: unknown;
}
export interface IngestResult {
  results: Array<{ id: string; status: "stored" | "duplicate" }>;
  stored: number;
  charged: number;
}
export class IngestError extends Error {
  constructor(
    readonly code: "too_many" | "too_large" | "bad_request" | "over_limit" | "breaker_open",
    message: string,
  ) {
    super(message);
    this.name = "IngestError";
  }
}

export const BATCH_LIMIT = 500;
export const EVENT_MAX_BYTES = 1_048_576; // 1 MiB

const SOURCES = ["opencode", "file", "github", "manual"];
const ACTORS = ["user", "assistant", "tool", "external"] as const;
const encoder = new TextEncoder();

interface Prepared {
  id: string;
  ts: number;
  source: string;
  actor: (typeof ACTORS)[number];
  trust: number;
  sessionId: string | null;
  kind: string;
  privacy: "normal" | "sensitive" | "restricted";
  excerpt: string;
  hmac: string;
  wrappedKey: string;
  blob: ArrayBuffer;
}

/** Validate + redact + excerpt + size-check one entry. Pure of DB/R2 writes. */
function prepareEntry(entry: EventInput): { fields: Omit<Prepared, "hmac" | "wrappedKey" | "blob">; redactedBody: string } {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new IngestError("bad_request", "entry must be an object");
  if (!SOURCES.includes(entry.source)) throw new IngestError("bad_request", "invalid source");
  if (!ACTORS.includes(entry.actor)) throw new IngestError("bad_request", "invalid actor");
  if (typeof entry.kind !== "string" || entry.kind.length === 0) throw new IngestError("bad_request", "invalid kind");
  if (entry.id !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(entry.id)) throw new IngestError("bad_request", "invalid id");
  if (entry.ts !== undefined && (typeof entry.ts !== "number" || !Number.isFinite(entry.ts)))
    throw new IngestError("bad_request", "invalid ts");
  if (!("payload" in entry)) throw new IngestError("bad_request", "payload missing");

  const { redacted, sensitive: payloadSensitive } = redactPayload(entry.payload);
  if (encoder.encode(redacted).byteLength > EVENT_MAX_BYTES) throw new IngestError("too_large", "payload exceeds 1 MiB");

  let sensitive = payloadSensitive;
  let excerpt: string;
  if (typeof entry.excerpt === "string") {
    const r = redactText(entry.excerpt);
    sensitive = sensitive || r.found;
    excerpt = buildExcerpt(r.text);
  } else {
    excerpt = buildExcerpt(redacted);
  }

  const tsRaw = entry.ts ?? Date.now();
  const ts = tsRaw < 1e12 ? tsRaw * 1000 : tsRaw; // OpenCode time.created may be seconds

  let privacy: "normal" | "sensitive" | "restricted" = entry.privacy ?? "normal";
  if (privacy !== "restricted" && sensitive) privacy = "sensitive";

  return {
    fields: {
      id: entry.id ?? newEventId(),
      ts,
      source: entry.source,
      actor: entry.actor,
      trust: TRUST[entry.actor],
      sessionId: entry.session_id ?? null,
      kind: entry.kind,
      privacy,
      excerpt,
    },
    redactedBody: redacted,
  };
}

export async function ingestEvents(env: Env, scope: Scope, entries: EventInput[]): Promise<IngestResult> {
  if (!Array.isArray(entries) || entries.length === 0) throw new IngestError("bad_request", "empty batch");
  if (entries.length > BATCH_LIMIT) throw new IngestError("too_many", `batch exceeds ${BATCH_LIMIT} entries`);

  const results: IngestResult["results"] = [];
  const prepared: Prepared[] = [];
  const batchIds = new Set<string>();
  const batchSessionHmacs = new Set<string>();

  for (const entry of entries) {
    const { fields: p, redactedBody } = prepareEntry(entry);
    const hmac = await contentHmac(await contentSigningSecret(env.PAYLOAD_KEK, env.CONTENT_HMAC_KEY), redactedBody);

    // Dedupe BEFORE any charge or write (by id, by (session_id, hmac), within-batch).
    const sessionKey = p.sessionId === null ? null : `${p.sessionId}\u0000${hmac}`;
    let duplicate =
      batchIds.has(p.id) ||
      (sessionKey !== null && batchSessionHmacs.has(sessionKey)) ||
      (await env.BRAIN_DB.prepare(`SELECT 1 FROM events WHERE id = ?1`).bind(p.id).first()) !== null;
    if (!duplicate && p.sessionId !== null) {
      duplicate =
        (await env.BRAIN_DB.prepare(`SELECT 1 FROM events WHERE session_id = ?1 AND content_hmac = ?2`)
          .bind(p.sessionId, hmac)
          .first()) !== null;
    }
    if (duplicate) {
      results.push({ id: p.id, status: "duplicate" });
      continue;
    }

    batchIds.add(p.id);
    if (sessionKey !== null) batchSessionHmacs.add(sessionKey);

    // Encrypt now, store the blob only after the claim inserts land. Two
    // racing duplicate batches both pass the pre-insert dedupe and both
    // encrypt with fresh data keys; only the batch whose event_keys INSERT
    // actually lands owns `payloads/<id>`. A last-wins R2 put from the loser
    // would pair its orphaned data key with the winner's wrapped key and make
    // the payload permanently undecryptable (prod incident 2026-10-16: 1,678
    // payloads). A crash between claim and put leaves a key without a blob —
    // degraded, but never a key/blob mismatch.
    const { blob, wrappedKey } = await encryptPayload(env.PAYLOAD_KEK, redactedBody);

    prepared.push({ ...p, hmac, wrappedKey, blob });
    results.push({ id: p.id, status: "stored" });
  }

  let stored = 0;
  if (prepared.length > 0) {
    const verdict = await charge(env.BRAIN_DB, scope, prepared.length);
    if (verdict === "over_limit") throw new IngestError("over_limit", "daily propose cap reached");
    if (verdict === "breaker_open") throw new IngestError("breaker_open", "global write breaker open");

    const now = Date.now();
    const stmts: D1PreparedStatement[] = [];
    for (const p of prepared) {
      stmts.push(
        env.BRAIN_DB.prepare(
          `INSERT OR IGNORE INTO events (id, ts, ingested_at, source, actor, trust, session_id, kind, privacy, excerpt, content_hmac)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
        ).bind(p.id, p.ts, now, p.source, p.actor, p.trust, p.sessionId, p.kind, p.privacy, p.excerpt, p.hmac),
      );
      stmts.push(
        env.BRAIN_DB.prepare(
          `INSERT OR IGNORE INTO event_keys (event_id, wrapped_key, created_at) VALUES (?1, ?2, ?3)`,
        ).bind(p.id, p.wrappedKey, now),
      );
    }
    const batchResults = await env.BRAIN_DB.batch(stmts);
    // INSERT OR IGNORE keeps concurrent duplicate submissions from throwing: the
    // pre-insert SELECT above cannot see a writer that has not committed yet, so
    // two racing batches may both reach the INSERT. `meta.changes` says which
    // inserts actually landed; raced rows report "duplicate" exactly like the
    // sequential dedupe path. Budget was charged on the pre-race count (p.length).
    const resultIndex = new Map(results.map((r, i) => [r.id, i] as const));
    const puts: Array<Promise<unknown>> = [];
    for (let i = 0; i < prepared.length; i += 1) {
      const p = prepared[i];
      const eventLanded = (batchResults[i * 2]?.meta?.changes ?? 0) > 0;
      const keyLanded = (batchResults[i * 2 + 1]?.meta?.changes ?? 0) > 0;
      // Blob ownership follows the event_keys claim, never the events claim
      // alone or the arrival order of R2 puts.
      if (eventLanded && keyLanded) puts.push(env.BRAIN_RAW.put(`payloads/${p.id}`, p.blob));
      if (eventLanded) {
        stored += 1;
      } else {
        const idx = resultIndex.get(p.id);
        if (idx !== undefined) results[idx] = { id: p.id, status: "duplicate" };
      }
    }
    await Promise.all(puts);
  }

  return { results, stored, charged: prepared.length };
}

export async function handleEvents(request: Request, env: Env, scope: Scope): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_request", message: "invalid JSON" }, 400);
  }
  const entries = Array.isArray(body) ? body : [body];
  try {
    return json(await ingestEvents(env, scope, entries as EventInput[]), 201);
  } catch (err) {
    if (err instanceof IngestError) {
      const status =
        err.code === "too_large" ? 413 : err.code === "over_limit" ? 429 : err.code === "breaker_open" ? 503 : 400;
      return json({ error: err.code, message: err.message }, status);
    }
    throw err;
  }
}
