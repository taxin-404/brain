import { z } from "zod";
import { newEventId } from "./crypto";
import type { Env, Scope } from "./env";
import { json } from "./http";

export const factCandidateSchema = z.array(
  z
    .object({
      subject: z.string(),
      subject_type: z.string().optional(),
      predicate: z.string(),
      object: z.string(),
      fact_kind: z.string(),
      confidence: z.number(),
      sensitivity: z.string().optional(),
      evidence_quote: z.string().optional(),
      event_id: z.string(),
      valid_at: z.number().optional(),
      expires_at: z.number().optional(),
      injection_suspected: z.boolean().optional(),
    })
    .passthrough(),
);

type FactCandidate = z.infer<typeof factCandidateSchema>[number];

export type FactKind = "user_stated" | "observed" | "inferred" | "guess" | "temporary";
export type Sensitivity = "normal" | "sensitive" | "restricted";
export type SourceActor = "user" | "assistant" | "tool" | "external";

export interface SourceContext {
  actor: SourceActor;
  trust: number;
}

export interface NormalizedFact {
  subject: string;
  subjectType?: string;
  subjectNorm: string;
  predicate: string;
  objectText: string;
  factKind: FactKind;
  confidence: number;
  sensitivity: Sensitivity;
  validAt?: number;
  expiresAt?: number;
  eventId: string;
  evidenceQuote?: string;
}

const FACT_KINDS: ReadonlySet<string> = new Set(["user_stated", "observed", "inferred", "guess", "temporary"]);
const SENSITIVITIES: ReadonlySet<string> = new Set(["normal", "sensitive", "restricted"]);

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Entity-normalization for subjects: lowercase, punctuation → space, collapse. */
export function normalizeSubjectText(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Object text stored/deduped: trim, lowercase, collapse whitespace. */
export function normalizeObjectText(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Predicate keys: lowercase, whitespace → `_`, keep `[a-z0-9_]` only. */
export function normalizePredicate(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

/** Text embedded for vector search (T5): subject + de-underscored predicate + object. */
export function buildEmbedText(f: { subjectName: string; predicate: string; objectText: string }): string {
  return `${f.subjectName} ${f.predicate.replace(/_/g, " ")} ${f.objectText}`;
}

/** Fact rows reuse the event ULID generator (time-sortable ids). */
export function newFactId(): string {
  return newEventId();
}

/** Turn raw extractor output into normalized facts, enforcing the kind/confidence
 *  rules (plan "Global constraints"): user_stated=0.9 only from actor=user;
 *  observed≤0.5 only from actor=tool; inferred≤0.59; guess≤0.5; temporary needs
 *  expires_at; actor=external never above inferred and ≤0.4. Candidates for
 *  unknown events are dropped; an injection flag drops its whole event (or the
 *  whole batch when its event cannot be mapped). */
export function normalizeCandidates(
  raw: unknown,
  ctx: Map<string, SourceContext>,
): { facts: NormalizedFact[]; injectionEvents: string[] } {
  if (!Array.isArray(raw)) throw new Error("fact candidates: expected an array");
  const entrySchema = factCandidateSchema.element;

  const candidates: FactCandidate[] = [];
  for (const item of raw) {
    const parsed = entrySchema.safeParse(item);
    if (parsed.success) candidates.push(parsed.data); // unparseable entries skipped
  }

  // Injection handling scans raw items: the spec's emission shape
  // ({injection_suspected: true, quote}) carries no event_id, yet must still
  // drop the whole batch.
  const injectionEvents = new Set<string>();
  let dropBatch = false;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const flagged = (item as Record<string, unknown>).injection_suspected;
    if (flagged !== true) continue;
    const id = (item as Record<string, unknown>).event_id;
    if (typeof id === "string" && id.length > 0 && ctx.has(id)) injectionEvents.add(id);
    else dropBatch = true;
  }

  const facts: NormalizedFact[] = [];
  if (!dropBatch) {
    for (const c of candidates) {
      if (c.injection_suspected === true) continue;
      if (injectionEvents.has(c.event_id)) continue;
      const source = ctx.get(c.event_id);
      if (!source) continue; // event not known → drop

      const subject = c.subject.trim();
      const object = c.object.trim();
      if (!subject || !object) continue;

      const sensitivity: Sensitivity = SENSITIVITIES.has(c.sensitivity ?? "")
        ? (c.sensitivity as Sensitivity)
        : "normal";
      const objectText = sensitivity === "restricted" ? "[REDACTED]" : normalizeObjectText(object);

      const parsedConfidence = clamp01(c.confidence);
      let kind: FactKind = FACT_KINDS.has(c.fact_kind) ? (c.fact_kind as FactKind) : "inferred";
      if (kind === "user_stated" && source.actor !== "user") kind = "inferred";
      if (kind === "observed" && source.actor !== "tool") kind = "inferred";
      const expiresAt = c.expires_at;
      if (kind === "temporary" && expiresAt === undefined) kind = "inferred";

      let confidence: number;
      switch (kind) {
        case "user_stated":
          confidence = 0.9;
          break;
        case "observed":
          confidence = Math.min(parsedConfidence, 0.5);
          break;
        case "guess":
          confidence = Math.min(parsedConfidence, 0.5);
          break;
        default:
          // inferred + temporary share the single-pass ceiling
          confidence = Math.min(parsedConfidence, 0.59);
          break;
      }
      if (source.actor === "external") confidence = Math.min(confidence, 0.4);

      facts.push({
        subject,
        ...(c.subject_type?.trim() ? { subjectType: c.subject_type.trim() } : {}),
        subjectNorm: normalizeSubjectText(subject),
        predicate: normalizePredicate(c.predicate),
        objectText,
        factKind: kind,
        confidence,
        sensitivity,
        ...(c.valid_at !== undefined ? { validAt: c.valid_at } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        eventId: c.event_id,
        ...(c.evidence_quote?.trim() ? { evidenceQuote: c.evidence_quote.trim() } : {}),
      });
    }
  }

  return { facts, injectionEvents: [...injectionEvents] };
}

export interface FactDetail {
  id: string;
  subject: string;
  predicate: string | null;
  object: string | null;
  fact_kind: string;
  confidence: number;
  status: string;
  sensitivity: string;
  valid_at: number | null;
  invalid_at: number | null;
  expires_at: number | null;
  expired_at: number | null;
  learned_at: number;
  first_seen_at: number | null;
  last_confirmed_at: number | null;
}

/** GET /v1/facts/:id — the fact row plus its provenance (fact_sources → events,
 *  metadata only). Restricted facts are hidden (404) from non-admin scopes. */
export async function handleGetFact(env: Env, scope: Scope, id: string): Promise<Response> {
  const fact = await env.BRAIN_DB.prepare(
    `SELECT f.id, e.name AS subject, f.predicate, f.object_text AS object, f.fact_kind, f.confidence,
            f.status, f.sensitivity, f.valid_at, f.invalid_at, f.expires_at, f.expired_at,
            f.learned_at, f.first_seen_at, f.last_confirmed_at
     FROM facts f JOIN entities e ON e.id = f.subject_id
     WHERE f.id = ?1`,
  )
    .bind(id)
    .first<FactDetail>();
  if (!fact) return json({ error: "not_found" }, 404);
  if (fact.sensitivity === "restricted" && scope !== "ADMIN") return json({ error: "not_found" }, 404);

  const { results: sources } = await env.BRAIN_DB.prepare(
    `SELECT fs.event_id, ev.ts, ev.kind
     FROM fact_sources fs JOIN events ev ON ev.id = fs.event_id
     WHERE fs.fact_id = ?1
     ORDER BY ev.ts ASC`,
  )
    .bind(id)
    .all<{ event_id: string; ts: number; kind: string }>();

  return json({ ...fact, sources });
}
