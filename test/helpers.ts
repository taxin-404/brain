import { env, exports } from "cloudflare:workers";
import type { Env as BrainEnv, Scope } from "../src/env";
import { newEventId } from "../src/crypto";

// workers-types v5: `env` is typed `Cloudflare.Env` and `exports` derives from
// `Cloudflare.GlobalProps.mainModule`; augment both globally (plan said
// ProvidedEnv, which does not exist in v5 — see ledger ruling).
declare global {
  namespace Cloudflare {
    interface Env extends BrainEnv {
      TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof import("../src/index");
    }
  }
}

export function bearer(env: BrainEnv, scope: Scope): Record<string, string> {
  const token =
    scope === "ADMIN" ? env.ADMIN_TOKEN : scope === "MCP_PROPOSE" ? env.MCP_PROPOSE_TOKEN : env.MCP_READ_TOKEN;
  return { authorization: `Bearer ${token}` };
}

export async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return exports.default.fetch(`https://brain.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Deterministic pseudo-embedding for tests (unit-length, seeded by the text):
 *  identical texts produce identical vectors, so a fake index can rank by
 *  cosine without a real model. */
export function fakeVec(text: string, dims = 768): number[] {
  let h = 2166136261;
  const out: number[] = new Array(dims);
  for (let i = 0; i < dims; i += 1) {
    h ^= text.charCodeAt(i % (text.length || 1));
    h = Math.imul(h, 16777619) >>> 0;
    out[i] = (h / 0xffffffff) * 2 - 1;
  }
  const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1;
  return out.map((v) => v / norm);
}

export interface StoredVector {
  id: string;
  values: number[];
  metadata: Record<string, unknown>;
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

/** In-memory Vectorize stand-in installed through the env proxy (the T1 seam —
 *  miniflare has no local Vectorize simulation). Query ranks by cosine over the
 *  stored vectors. Returns the backing store so tests can pre-seed vectors. */
export function installFakeVectorize(): Map<string, StoredVector> {
  const store = new Map<string, StoredVector>();
  const put = (vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>) => {
    for (const v of vectors) store.set(v.id, { id: v.id, values: v.values, metadata: v.metadata ?? {} });
    return { mutationId: "test" };
  };
  const index = {
    upsert: async (vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>) => put(vectors),
    insert: async (vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>) => put(vectors),
    query: async (values: number[], options?: { topK?: number }) => {
      const scored = [...store.values()]
        .map((v) => ({ id: v.id, score: cosine(values, v.values) }))
        .sort((a, b) => b.score - a.score);
      return { matches: scored.slice(0, options?.topK ?? 10) };
    },
    deleteByIds: async (ids: string[]) => {
      for (const id of ids) store.delete(id);
      return { mutationId: "test" };
    },
    describe: async () => ({ name: "fake", config: {}, vectorsCount: store.size }),
  };
  (env as unknown as Record<string, unknown>).VECTORIZE = index as unknown as VectorizeIndex;
  return store;
}

let factSeedTs = 1_750_000_000_000;

/** Seed an entity + source event + fact (+ its facts_fts and fact_sources rows)
 *  for tests that need existing facts without running the extraction pipeline. */
export async function seedFact(over: {
  name: string;
  predicate: string;
  object: string;
  sensitivity?: string;
  status?: string;
  confidence?: number;
  learnedAt?: number;
  lastConfirmedAt?: number | null;
}): Promise<string> {
  const now = over.learnedAt ?? (factSeedTs += 1000);
  const entityId = newEventId();
  await env.BRAIN_DB.prepare(
    `INSERT INTO entities (id, type, name, norm_name, first_seen_at, last_seen_at)
     VALUES (?1, 'Project', ?2, ?3, ?4, ?4)`,
  )
    .bind(entityId, over.name, over.name.toLowerCase(), now)
    .run();
  const factId = newEventId();
  const eventId = `evt-${factId}`;
  await env.BRAIN_DB.prepare(
    `INSERT INTO events (id, ts, ingested_at, source, actor, trust, session_id, kind, privacy, excerpt, content_hmac)
     VALUES (?1, ?2, ?3, 'manual', 'user', 1.0, NULL, 'note', 'normal', 'seed fact', ?4)`,
  )
    .bind(eventId, now, now, `hmac-${eventId}`)
    .run();
  const lastConfirmed = over.lastConfirmedAt === undefined ? now : over.lastConfirmedAt;
  await env.BRAIN_DB.prepare(
    `INSERT INTO facts (id, subject_id, predicate, object_text, fact_kind, confidence, status,
                        learned_at, first_seen_at, last_confirmed_at, sensitivity, source_event_id,
                        embedding_model, vec_id)
     VALUES (?1, ?2, ?3, ?4, 'user_stated', ?5, ?6, ?7, ?7, ?8, ?9, ?10, 'gemini-embedding-001', NULL)`,
  )
    .bind(
      factId,
      entityId,
      over.predicate,
      over.object,
      over.confidence ?? 0.9,
      over.status ?? "active",
      now,
      lastConfirmed,
      over.sensitivity ?? "normal",
      eventId,
    )
    .run();
  await env.BRAIN_DB.prepare(`INSERT INTO facts_fts(rowid, object_text) SELECT rowid, object_text FROM facts WHERE id = ?1`)
    .bind(factId)
    .run();
  await env.BRAIN_DB.prepare(`INSERT OR IGNORE INTO fact_sources (fact_id, event_id) VALUES (?1, ?2)`)
    .bind(factId, eventId)
    .run();
  return factId;
}
