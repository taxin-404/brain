import { writeAudit } from "./audit";
import { contentHmac, decryptPayload, newEventId } from "./crypto";
import type { Env } from "./env";
import { json } from "./http";
import { consumeConfirmToken, PurgeError } from "./purge";
import { rebuildProjections } from "./rebuild";

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

const b64decode = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// ---------------------------------------------------------------------------
// Restore (design §8 phase 6, done-when): consume a backup-profile export and
// rebuild the brain on a fresh account. Only PAYLOAD_KEK-protected material
// is ever involved: payloads stay encrypted at rest; restore copies rows and
// blobs verbatim and never needs the HMAC key (stored content_hmac values are
// preserved as data — fidelity over re-derivation on a clean account).
// ---------------------------------------------------------------------------

const columnCache = new Map<string, Set<string>>();

async function tableColumns(env: Env, table: string): Promise<Set<string>> {
  const cached = columnCache.get(table);
  if (cached) return cached;
  const { results } = await env.BRAIN_DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  const cols = new Set(results.map((r) => r.name));
  columnCache.set(table, cols);
  return cols;
}

const normalizeValue = (v: unknown): string | number | null =>
  v === null || v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : (v as string | number);

async function insertRows(env: Env, table: string, rows: Array<Record<string, unknown>>): Promise<number> {
  const cols = await tableColumns(env, table);
  const stmts: D1PreparedStatement[] = [];
  for (const row of rows) {
    const keys = Object.keys(row).filter((k) => /^[a-z_]+$/.test(k) && cols.has(k));
    if (keys.length === 0) continue;
    const sql = `INSERT OR REPLACE INTO ${table} (${keys.join(", ")}) VALUES (${keys.map((_, i) => `?${i + 1}`).join(", ")})`;
    stmts.push(env.BRAIN_DB.prepare(sql).bind(...keys.map((k) => normalizeValue(row[k]))));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.BRAIN_DB.batch(stmts.slice(i, i + 50));
  return stmts.length;
}

export async function restoreFromJob(env: Env, job: string): Promise<{ status: number; body: unknown }> {
  const metaObj = await env.BRAIN_RAW.get(metaKey(job));
  if (!metaObj) return { status: 404, body: { error: "not_found" } };
  const meta = (await metaObj.json()) as { profile?: string };
  if (meta.profile !== "backup") {
    return { status: 400, body: { error: "bad_request", message: "restore requires a backup-profile export" } };
  }

  const parts = (await env.BRAIN_RAW.list({ prefix: `exports/${job}/` })).objects
    .filter((o) => PART_RE.test(o.key))
    .sort((a, b) => a.key.localeCompare(b.key));
  if (parts.length === 0) return { status: 404, body: { error: "not_found" } };

  const restored: Record<string, number> = {};
  const payloads: Array<{ key: string; b64: string }> = [];
  let headerOk = false;

  for (const part of parts) {
    const obj = await env.BRAIN_RAW.get(part.key);
    if (!obj) continue;
    const text = await obj.text();
    for (const line of text.split("\n")) {
      if (!line) continue;
      let item: { kind?: string; format?: string; version?: number; table?: string; rows?: Array<Record<string, unknown>> };
      try {
        item = JSON.parse(line);
      } catch {
        return { status: 400, body: { error: "bad_request", message: "corrupt export line" } };
      }
      if (item.kind === "header") {
        if (item.format !== "brain-export" || item.version !== 1) {
          return { status: 400, body: { error: "bad_request", message: "unsupported export format" } };
        }
        headerOk = true;
        continue;
      }
      if (!headerOk || !item.table || !Array.isArray(item.rows)) continue;
      if (item.table === "r2_payloads") {
        for (const row of item.rows) {
          if (typeof row.key === "string" && typeof row.b64 === "string") payloads.push({ key: row.key, b64: row.b64 });
        }
        continue;
      }
      // Unknown content tables are ignored (forward-compatible exports).
      if (!(EXPORT_TABLES as readonly string[]).includes(item.table)) continue;
      if (item.rows.length === 0) continue;
      const n = await insertRows(env, item.table, item.rows);
      restored[item.table] = (restored[item.table] ?? 0) + n;
    }
  }

  let r2_payloads = 0;
  for (const p of payloads) {
    if (!p.key.startsWith("payloads/")) continue; // belt & braces: payload prefix only
    await env.BRAIN_RAW.put(p.key, b64decode(p.b64));
    r2_payloads += 1;
  }

  const { fts_rows } = await rebuildProjections(env);

  await writeAudit(env.BRAIN_DB, {
    actor: "user",
    action: "restore",
    targetType: "export",
    targetId: job,
    after: { restored, r2_payloads, fts_rows },
    reason: "",
  });

  return { status: 200, body: { job, restored, r2_payloads, fts_rows } };
}

export async function handleRestore(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { job?: unknown } | null;
  if (!body || typeof body.job !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.job)) {
    return json({ error: "bad_request", message: "job required" }, 400);
  }
  const out = await restoreFromJob(env, body.job);
  return json(out.body, out.status);
}

export const exportLinkToken = (hmacKey: string, job: string, exp: number): Promise<string> =>
  contentHmac(hmacKey, `export:${job}:${exp}`);

const loadWrappedKeys = async (env: Env): Promise<Map<string, string>> => {
  const { results } = await env.BRAIN_DB.prepare(`SELECT event_id, wrapped_key FROM event_keys`).all<{
    event_id: string;
    wrapped_key: string;
  }>();
  return new Map(results.map((r) => [r.event_id, r.wrapped_key]));
};

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
  // Portable artifacts are decrypted on the walk and ship no wrapped keys.
  const tables = profile === "backup" ? EXPORT_TABLES : EXPORT_TABLES.filter((t) => t !== "event_keys");
  const wrappedKeys = profile === "portable" ? await loadWrappedKeys(env) : null;

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
      tables: [...tables, "r2_payloads"],
    }),
  );

  for (const table of tables) {
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
        // Decrypt with the KEK + this event's wrapped key; orphans stay null.
        let text: string | null = null;
        const eventId = obj.key.slice("payloads/".length);
        const wrappedKey = wrappedKeys?.get(eventId);
        if (wrappedKey) {
          try {
            text = await decryptPayload(env.PAYLOAD_KEK, wrappedKey, blob);
          } catch {
            text = null;
          }
        }
        await line(JSON.stringify({ table: "r2_payloads", rows: [{ key: obj.key, text }] }));
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
  const url = new URL(request.url);
  const profile = url.searchParams.get("profile") ?? "backup";
  if (profile !== "backup" && profile !== "portable") {
    return json({ error: "bad_request", message: "profile must be backup|portable" }, 400);
  }
  if (profile === "portable") {
    // Load-bearing confirmation: decrypted data only ever leaves R2 when an
    // admin minted (and we just consumed) a single-use token for this target.
    const confirmToken = url.searchParams.get("confirm_token") ?? "";
    if (!confirmToken) return json({ error: "confirm_required" }, 403);
    try {
      await consumeConfirmToken(env, "export:portable", confirmToken);
    } catch (err) {
      if (err instanceof PurgeError) return json({ error: "forbidden", message: err.message }, 403);
      throw err;
    }
  }
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
        // "auto-delete from R2 after download" — deletes run before the writer
        // closes, so by the time the client sees EOF the job is gone.
        for (const o of sorted) await env.BRAIN_RAW.delete(o.key);
        await env.BRAIN_RAW.delete(metaKey(job));
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
