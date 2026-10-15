import type { Env } from "./env";
import { buildEmbedText } from "./facts";
import { EMBEDDING_MODEL, embedTexts } from "./llm";

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

/** Embed active, non-restricted facts that have no vector yet and upsert them
 *  into Vectorize (vector id = fact id). Failures are counted, never thrown:
 *  the fact keeps `vec_id` NULL and the next sweep retries it. */
export async function embedPendingFacts(env: Env, opts: { maxFacts?: number } = {}): Promise<EmbedRun> {
  const maxFacts = opts.maxFacts ?? DEFAULT_MAX;
  const run: EmbedRun = { embedded: 0, failed: 0 };

  const { results } = await env.BRAIN_DB.prepare(
    `SELECT f.id, e.name AS subject_name, f.predicate, f.object_text, f.status, f.sensitivity
     FROM facts f JOIN entities e ON e.id = f.subject_id
     WHERE f.vec_id IS NULL AND f.sensitivity != 'restricted' AND f.status = 'active'
     ORDER BY f.learned_at ASC LIMIT ?1`,
  )
    .bind(maxFacts)
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
            embedding_model: EMBEDDING_MODEL,
            updated_at: now,
          },
        })),
      );
      for (const f of chunk) {
        await env.BRAIN_DB.prepare(`UPDATE facts SET vec_id = ?1 WHERE id = ?2`).bind(f.id, f.id).run();
      }
      run.embedded += chunk.length;
    } catch {
      // gateway or Vectorize failure: vec_id stays NULL, retry on a later sweep
      run.failed += chunk.length;
    }
  }

  return run;
}
