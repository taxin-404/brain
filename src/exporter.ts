import { writeAudit } from "./audit";
import { contentHmac, newEventId } from "./crypto";
import type { Env } from "./env";
import { json } from "./http";

/** Export profiles (design §8 phase 6 + amendment 3): a chunked NDJSON job
 *  written to R2 and reachable only through a short-TTL HMAC-signed link.
 *
 *  - `backup` (default): content tables verbatim — encrypted payload blobs
 *    (R2) + wrapped keys (D1) — plus a header. Useless without the escrowed
 *    KEK, so a leaked link or R2 object exposes nothing.
 *  - `portable`: payloads decrypted on the walk, wrapped keys omitted,
 *    requires an admin-minted single-use confirmation token.
 *
 *  FTS virtual tables are excluded (D1 cannot export them); restore re-derives
 *  them with `rebuildProjections`. */

export const EXPORT_TABLES = [
  "events",
  "event_keys",
  "entities",
  "entity_aliases",
  "facts",
  "fact_sources",
  "edges",
  "blocks",
  "proposals",
  "procedures",
  "procedure_versions",
  "reflections",
  "reflection_sources",
  "audit_log",
] as const;

export const EXPORT_TTL_MS = 15 * 60_000;
const CHUNK_ROWS = 500;
const PART_BYTES = 4 * 1024 * 1024;

export interface ExportResult {
  job: string;
  profile: "backup" | "portable";
  url: string;
  expires_at: number;
  parts: number;
}

const partKey = (job: string, seq: number) => `exports/${job}/${String(seq).padStart(3, "0")}.ndjson`;
const metaKey = (job: string) => `exports/${job}/meta.json`;
const PART_RE = /\/\d{3}\.ndjson$/;

const b64encode = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

export const exportLinkToken = (hmacKey: string, job: string, exp: number): Promise<string> =>
  contentHmac(hmacKey, `export:${job}:${exp}`);

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export async function runExport(
  env: Env,
  profile: "backup" | "portable",
  now = Date.now(),
): Promise<ExportResult> {
  const job = newEventId();
  const exp = now + EXPORT_TTL_MS;
  const meta = { profile, exp: String(exp) };

  let buf: string[] = [];
  let size = 0;
  let seq = 0;
  const flush = async () => {
    if (buf.length === 0) return;
    await env.BRAIN_RAW.put(partKey(job, seq), buf.join("\n") + "\n", { customMetadata: meta });
    seq += 1;
    buf = [];
    size = 0;
  };
  const line = async (s: string) => {
    buf.push(s);
    size += s.length;
    if (size >= PART_BYTES) await flush();
  };

  await line(
    JSON.stringify({
      kind: "header",
      format: "brain-export",
      version: 1,
      profile,
      exported_at: now,
      tables: [...EXPORT_TABLES, "r2_payloads"],
    }),
  );

  for (const table of EXPORT_TABLES) {
    const { results } = await env.BRAIN_DB.prepare(`SELECT * FROM ${table}`).all();
    for (let i = 0; i < results.length; i += CHUNK_ROWS) {
      await line(JSON.stringify({ table, rows: results.slice(i, i + CHUNK_ROWS) }));
    }
  }

  // Raw payload objects (R2). Backup ships ciphertext; portable decrypts.
  let cursor: string | undefined;
  do {
    const list = await env.BRAIN_RAW.list({ prefix: "payloads/", cursor, limit: 500 });
    for (const obj of list.objects) {
      const body = await env.BRAIN_RAW.get(obj.key);
      if (!body) continue;
      const blob = await body.arrayBuffer();
      if (profile === "backup") {
        await line(JSON.stringify({ table: "r2_payloads", rows: [{ key: obj.key, b64: b64encode(blob) }] }));
      } else {
        await line(JSON.stringify({ table: "r2_payloads", rows: [{ key: obj.key, text: null }] }));
      }
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  await flush();

  // Sidecar manifest (profile + retention) — the download and sweep read this
  // instead of relying on R2 custom metadata (invisible to `list()` locally).
  await env.BRAIN_RAW.put(
    metaKey(job),
    JSON.stringify({ profile, exp, exported_at: now, parts: seq }),
    { customMetadata: meta },
  );

  await writeAudit(env.BRAIN_DB, {
    actor: "user",
    action: "export",
    targetType: "export",
    targetId: job,
    after: { profile, exp },
    reason: "",
  });

  const token = await exportLinkToken(env.CONTENT_HMAC_KEY, job, exp);
  return { job, profile, url: `/v1/export/${job}/download?exp=${exp}&token=${token}`, expires_at: exp, parts: seq };
}

export async function handleExportRequest(request: Request, env: Env): Promise<Response> {
  const profile = new URL(request.url).searchParams.get("profile") ?? "backup";
  if (profile !== "backup" && profile !== "portable") {
    return json({ error: "bad_request", message: "profile must be backup|portable" }, 400);
  }
  if (profile === "portable") return json({ error: "unsupported", message: "portable arrives in T3" }, 501);
  return json(await runExport(env, profile));
}

export async function handleExportDownload(env: Env, job: string, url: URL): Promise<Response> {
  const exp = Number(url.searchParams.get("exp"));
  const token = url.searchParams.get("token") ?? "";
  if (!Number.isFinite(exp) || exp < Date.now()) return json({ error: "expired" }, 403);
  const expected = await exportLinkToken(env.CONTENT_HMAC_KEY, job, exp);
  if (!constantTimeEqual(token, expected)) return json({ error: "forbidden" }, 403);

  const metaObj = await env.BRAIN_RAW.get(metaKey(job));
  if (!metaObj) return json({ error: "not_found" }, 404);
  const meta = (await metaObj.json()) as { profile?: string };
  const profile = meta.profile ?? "backup";

  const list = await env.BRAIN_RAW.list({ prefix: `exports/${job}/` });
  const sorted = list.objects
    .filter((o) => PART_RE.test(o.key))
    .sort((a, b) => a.key.localeCompare(b.key));
  if (sorted.length === 0) return json({ error: "not_found" }, 404);

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  void (async () => {
    try {
      for (const o of sorted) {
        const obj = await env.BRAIN_RAW.get(o.key);
        if (!obj) continue;
        const reader = obj.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
      }
      if (profile === "portable") {
        // "auto-delete from R2 after download" — the bytes are flushed first.
        for (const o of sorted) await env.BRAIN_RAW.delete(o.key);
      }
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      "content-type": "application/x-ndjson",
      "content-disposition": `attachment; filename="${job}.ndjson"`,
      "cache-control": "no-store",
    },
  });
}
