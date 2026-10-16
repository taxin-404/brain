import type { Env } from "./env";
import { buildEmbedText } from "./facts";
import { embedConfig, embedTexts, LlmError } from "./llm";

export interface EmbedRun {
  embedded: number;
  failed: number;
}

const CHUNK = 10;
const DEFAULT_MAX = 100;

interface UnembeddedFact {
  id: string;
  subject_name: string;
  predicate: string;
  object_text: string;
  status: string;
  sensitivity: string;
}

/** Embed active, non-restricted facts whose vector is missing or was built by
 *  a different embedding model/size, and upsert them into Vectorize (vector
 *  id = fact id). Failures are counted, never thrown: the old vector stays
 *  and the next sweep retries. A config-level mismatch (index dims) throws —
 *  every upsert below would fail silently in a loop otherwise. */
export async function embedPendingFacts(env: Env, opts: { maxFacts?: number } = {}): Promise<EmbedRun> {
  const maxFacts = opts.maxFacts ?? DEFAULT_MAX;
  const run: EmbedRun = { embedded: 0, failed: 0 };

  const cfg = embedConfig(env);
  const info = await env.VECTORIZE.describe();
  const indexDims = "dimensions" in info.config ? info.config.dimensions : null;
  if (indexDims !== null && indexDims !== cfg.dims) {
    throw new LlmError(
      "config",
      `vectorize index is ${indexDims}-dim but AI_EMBED_DIMS is ${cfg.dims} — recreate the index at ${cfg.dims} dims or fix AI_EMBED_DIMS`,
    );
  }

  // Pre-signature rows carry the bare model name (the column is NOT NULL
  // since its first migration); the ?1 bind counts them as current at the
  // default dims, while a model switch re-embeds them via the ?2 signature.
  const { results } = await env.BRAIN_DB.prepare(
    `SELECT f.id, e.name AS subject_name, f.predicate, f.object_text, f.status, f.sensitivity
     FROM facts f JOIN entities e ON e.id = f.subject_id
     WHERE (f.vec_id IS NULL OR (f.embedding_model IS NOT ?1 AND f.embedding_model IS NOT ?2))
       AND f.sensitivity != 'restricted' AND f.status = 'active'
     ORDER BY f.learned_at ASC LIMIT ?3`,
  )
    .bind(cfg.model, cfg.signature, maxFacts)
    .all<UnembeddedFact>();

  for (let i = 0; i < results.length; i += CHUNK) {
    const chunk = results.slice(i, i + CHUNK);
    try {
      const texts = chunk.map((f) =>
        buildEmbedText({ subjectName: f.subject_name, predicate: f.predicate, objectText: f.object_text }),
      );
      const vectors = await embedTexts(env, texts);
      const now = Date.now();
      await env.VECTORIZE.upsert(
        chunk.map((f, j) => ({
          id: f.id,
          values: vectors[j],
          metadata: {
            fact_id: f.id,
            type: "fact",
            status: f.status,
            sensitivity: f.sensitivity,
            embedding_model: cfg.signature,
            updated_at: now,
          },
        })),
      );
      for (const f of chunk) {
        await env.BRAIN_DB.prepare(`UPDATE facts SET vec_id = ?1, embedding_model = ?2 WHERE id = ?1`)
          .bind(f.id, cfg.signature)
          .run();
      }
      run.embedded += chunk.length;
    } catch {
      // provider or Vectorize failure: the old vector stays, retry next sweep
      run.failed += chunk.length;
    }
  }

  return run;
}
