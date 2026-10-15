import type { Env } from "./env";
import { writeAudit } from "./audit";
import { json } from "./http";

export const BLOCK_KEYS = [
  "identity",
  "preferences",
  "active_projects",
  "infrastructure",
  "constraints",
  "objective",
] as const;
export type BlockKey = (typeof BLOCK_KEYS)[number];

export async function handleGetBlocks(env: Env): Promise<Response> {
  const { results } = await env.BRAIN_DB.prepare(
    `SELECT key, value, updated_at FROM blocks ORDER BY key`,
  ).all<{ key: string; value: string; updated_at: number }>();
  return json({ blocks: results });
}

export async function handlePutBlock(request: Request, env: Env, key: string): Promise<Response> {
  if (!(BLOCK_KEYS as readonly string[]).includes(key)) {
    return json({ error: "bad_request", message: "unknown block key" }, 400);
  }
  const body = (await request.json().catch(() => null)) as { value?: unknown } | null;
  if (!body || typeof body.value !== "string" || body.value.trim() === "") {
    return json({ error: "bad_request", message: "value required" }, 400);
  }
  const value = body.value;

  const existing = await env.BRAIN_DB.prepare(`SELECT value FROM blocks WHERE key = ?1`)
    .bind(key)
    .first<{ value: string }>();
  const now = Date.now();
  await env.BRAIN_DB.prepare(
    `INSERT INTO blocks (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value, now)
    .run();

  await writeAudit(env.BRAIN_DB, {
    actor: "user",
    action: existing ? "correct" : "create",
    targetType: "block",
    targetId: key,
    before: existing ? { value: existing.value } : undefined,
    after: { value },
  });

  return json({ key, value, updated_at: now }, 200);
}
