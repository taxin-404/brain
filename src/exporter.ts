import { writeAudit } from "./audit";
import { contentHmac, decryptPayloadWithKek, newEventId, payloadKek } from "./crypto";
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

/** Payload objects walked per invocation. The Workers Free plan allows only
 *  1,000 Cloudflare-service subrequests per invocation, so the walk is paged:
 *  one bounded R2 list page per call with the cursor persisted in meta.json
 *  (`state:"running"` → resume via `GET /v1/export?job=…` until `done:true`). */
const DEFAULT_EXPORT_SLICE = 200;
export const MAX_EXPORT_SLICE = 500;
/** Portable decrypts have real per-object CPU cost on the free plan (10 ms);
 *  keep the payload page under the backup default. */
const PORTABLE_PAYLOAD_PAGE = 100;
/** Table rows stringified per invocation (1 MB in one call flaked 1102). */
const TABLES_ROWS_PER_CALL = 400;
const DEFAULT_RESTORE_SLICE = 800;
export const MAX_RESTORE_SLICE = 1200;

export interface ExportJobView {
  job: string;
  profile: "backup" | "portable";
  state: "running" | "done";
  done: boolean;
  parts: number;
  url: string;
  expires_at: number;
}

interface ExportMeta {
  profile: "backup" | "portable";
  exp: number;
  exported_at: number;
  state: "running" | "done";
  cursor: string | null;
  seq: number;
  parts: number;
  tables: boolean;
  table_index: number;
  row_offset: number;
}

interface RestoreState {
  tables_done: boolean;
  restored_tables: Record<string, number>;
  payload_index: number;
  done: boolean;
  fts_rows: number | null;
}

const partKey = (job: string, seq: number) => `exports/${job}/${String(seq).padStart(3, "0")}.ndjson`;
const metaKey = (job: string) => `exports/${job}/meta.json`;
const restoreStateKey = (job: string) => `exports/${job}/restore-state.json`;
const PART_RE = /\/\d{3}\.ndjson$/;

const clampSlice = (n: number | undefined, max: number, dflt: number): number =>
  n !== undefined && Number.isFinite(n) && n >= 1 ? Math.min(Math.trunc(n), max) : dflt;

/** Reads the meta sidecar. Legacy (pre-resume) metas were written only at
 *  completion and carry no `state` — they normalize to `done`. */
const readMeta = async (env: Env, job: string): Promise<ExportMeta | null> => {
  const obj = await env.BRAIN_RAW.get(metaKey(job));
  if (!obj) return null;
  try {
    const m = (await obj.json()) as Partial<ExportMeta>;
    if (m.profile !== "backup" && m.profile !== "portable") return null;
    if (!Number.isFinite(m.exp)) return null;
    return {
      profile: m.profile,
      exp: m.exp as number,
      exported_at: typeof m.exported_at === "number" ? m.exported_at : 0,
      state: m.state === "running" ? "running" : "done",
      cursor: typeof m.cursor === "string" ? m.cursor : null,
      seq: typeof m.seq === "number" ? m.seq : typeof m.parts === "number" ? m.parts : 0,
      parts: typeof m.parts === "number" ? m.parts : 0,
      tables: m.tables !== false,
      table_index: typeof m.table_index === "number" ? m.table_index : 0,
      row_offset: typeof m.row_offset === "number" ? m.row_offset : 0,
    };
  } catch {
    return null;
  }
};

const exportView = async (env: Env, job: string, meta: ExportMeta): Promise<ExportJobView> => {
  const token = await exportLinkToken(env.CONTENT_HMAC_KEY, job, meta.exp);
  return {
    job,
    profile: meta.profile,
    state: meta.state,
    done: meta.state === "done",
    parts: meta.parts,
    url: `/v1/export/${job}/download?exp=${meta.exp}&token=${token}`,
    expires_at: meta.exp,
  };
};

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

export async function restoreFromJob(
  env: Env,
  job: string,
  opts: { limit?: number } = {},
): Promise<{ status: number; body: unknown }> {
  const slice = clampSlice(opts.limit, MAX_RESTORE_SLICE, DEFAULT_RESTORE_SLICE);
  const metaObj = await env.BRAIN_RAW.get(metaKey(job));
  if (!metaObj) return { status: 404, body: { error: "not_found" } };
  const meta = (await metaObj.json()) as { profile?: string; state?: string };
  if (meta.profile !== "backup") {
    return { status: 400, body: { error: "bad_request", message: "restore requires a backup-profile export" } };
  }
  if (meta.state === "running") {
    return { status: 409, body: { error: "in_progress", message: "export is still running; resume it first" } };
  }

  // Restore progress lives in a sidecar inside the job prefix (download
  // filters part keys, the sweep deletes the whole prefix).
  let state: RestoreState | null = null;
  const stateObj = await env.BRAIN_RAW.get(restoreStateKey(job));
  if (stateObj) {
    try {
      state = (await stateObj.json()) as RestoreState;
    } catch {
      state = null;
    }
  }
  if (state?.done) {
    return {
      status: 200,
      body: { job, done: true, restored: {}, r2_payloads: 0, fts_rows: state.fts_rows, cached: true },
    };
  }
  if (!state) state = { tables_done: false, restored_tables: {}, payload_index: 0, done: false, fts_rows: null };

  const parts = (await env.BRAIN_RAW.list({ prefix: `exports/${job}/` })).objects
    .filter((o) => PART_RE.test(o.key))
    .sort((a, b) => a.key.localeCompare(b.key));
  if (parts.length === 0) return { status: 404, body: { error: "not_found" } };

  const restored: Record<string, number> = {}; // table counts from this call only
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
      if (!state.tables_done) {
        const n = await insertRows(env, item.table, item.rows);
        restored[item.table] = (restored[item.table] ?? 0) + n;
      }
    }
  }

  if (!state.tables_done) {
    state.tables_done = true;
    state.restored_tables = { ...restored };
  }

  // Payload re-puts are the subrequest-heavy step: bounded per call, resumable
  // by index. `payloads/` prefix guard is belt & braces.
  let r2_payloads = 0;
  const to = Math.min(payloads.length, state.payload_index + slice);
  for (let i = state.payload_index; i < to; i += 1) {
    const p = payloads[i];
    if (!p.key.startsWith("payloads/")) continue;
    await env.BRAIN_RAW.put(p.key, b64decode(p.b64));
    r2_payloads += 1;
  }
  state.payload_index = to;

  if (!state.done && state.payload_index >= payloads.length) {
    state.done = true;
    const { fts_rows } = await rebuildProjections(env);
    state.fts_rows = fts_rows;
    await writeAudit(env.BRAIN_DB, {
      actor: "user",
      action: "restore",
      targetType: "export",
      targetId: job,
      after: { restored: state.restored_tables, r2_payloads: payloads.length, fts_rows },
      reason: "",
    });
  }

  await env.BRAIN_RAW.put(restoreStateKey(job), JSON.stringify(state));

  return {
    status: 200,
    body: { job, done: state.done, restored, r2_payloads, fts_rows: state.done ? state.fts_rows : null },
  };
}

export async function handleRestore(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { job?: unknown; limit?: unknown } | null;
  if (!body || typeof body.job !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.job)) {
    return json({ error: "bad_request", message: "job required" }, 400);
  }
  const limit = typeof body.limit === "number" ? body.limit : undefined;
  const out = await restoreFromJob(env, body.job, { limit });
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

/** One bounded slice of the walk: (first call) header + content tables, then
 *  one R2 list page of payload objects. Cursor + seq persist in meta.json. */
async function exportSlice(env: Env, job: string, meta: ExportMeta, slice: number): Promise<ExportMeta> {
  const profile = meta.profile;
  // Portable artifacts are decrypted on the walk and ship no wrapped keys.
  const tables = profile === "backup" ? EXPORT_TABLES : EXPORT_TABLES.filter((t) => t !== "event_keys");

  let buf: string[] = [];
  let size = 0;
  let seq = meta.seq;
  const flush = async () => {
    if (buf.length === 0) return;
    await env.BRAIN_RAW.put(partKey(job, seq), buf.join("\n") + "\n");
    seq += 1;
    buf = [];
    size = 0;
  };
  const line = async (s: string) => {
    buf.push(s);
    size += s.length;
    if (size >= PART_BYTES) await flush();
  };

  let ti = meta.table_index;
  let off = meta.row_offset;
  let tablesDone = meta.tables;
  if (!meta.tables) {
    await line(
      JSON.stringify({
        kind: "header",
        format: "brain-export",
        version: 1,
        profile,
        exported_at: meta.exported_at,
        tables: [...tables, "r2_payloads"],
      }),
    );
    // Tables walk in ≤400-row slices: LIMIT/OFFSET pages with the position in
    // meta.json. When the budget runs out mid-table the call ends early —
    // the payload walk only starts on a call that finished the tables.
    let rowsLeft = TABLES_ROWS_PER_CALL;
    while (ti < tables.length && rowsLeft > 0) {
      const table = tables[ti];
      const requested = rowsLeft;
      const { results } = await env.BRAIN_DB.prepare(`SELECT * FROM ${table} LIMIT ?1 OFFSET ?2`)
        .bind(requested, off)
        .all();
      const got = results.length;
      if (got > 0) {
        for (let i = 0; i < got; i += CHUNK_ROWS) {
          await line(JSON.stringify({ table, rows: results.slice(i, i + CHUNK_ROWS) }));
        }
        off += got;
        rowsLeft -= got;
      }
      if (got < requested) {
        ti += 1;
        off = 0;
      }
    }
    tablesDone = ti >= tables.length;
  }

  if (!tablesDone) {
    // Budget spent inside the tables: flush, persist position, end the call.
    await flush();
    const next: ExportMeta = {
      ...meta,
      tables: false,
      table_index: ti,
      row_offset: off,
      seq,
      parts: seq,
      state: "running",
    };
    await env.BRAIN_RAW.put(metaKey(job), JSON.stringify(next));
    return next;
  }

  // Raw payload objects (R2): one bounded page per invocation. Backup ships
  // ciphertext; portable decrypts with the KEK + wrapped key per event.
  const page = profile === "portable" ? Math.min(slice, PORTABLE_PAYLOAD_PAGE) : slice;
  const list = await env.BRAIN_RAW.list({ prefix: "payloads/", cursor: meta.cursor ?? undefined, limit: page });
  const wrappedKeys = profile === "portable" && list.objects.length > 0 ? await loadWrappedKeys(env) : null;
  const kek = profile === "portable" && list.objects.length > 0 ? await payloadKek(env.PAYLOAD_KEK) : null;
  for (const obj of list.objects) {
    const body = await env.BRAIN_RAW.get(obj.key);
    if (!body) continue;
    const blob = await body.arrayBuffer();
    if (profile === "backup") {
      await line(JSON.stringify({ table: "r2_payloads", rows: [{ key: obj.key, b64: b64encode(blob) }] }));
    } else {
      // Orphan blobs (no wrapped key) and decrypt failures degrade to null.
      let text: string | null = null;
      const eventId = obj.key.slice("payloads/".length);
      const wrappedKey = wrappedKeys?.get(eventId);
      if (wrappedKey && kek) {
        try {
          text = await decryptPayloadWithKek(kek, wrappedKey, blob);
        } catch {
          text = null;
        }
      }
      await line(JSON.stringify({ table: "r2_payloads", rows: [{ key: obj.key, text }] }));
    }
  }
  await flush();

  const cursor = list.truncated ? (list.cursor ?? null) : null;
  const next: ExportMeta = {
    ...meta,
    tables: true,
    table_index: ti,
    row_offset: 0,
    cursor,
    seq,
    parts: seq,
    state: cursor === null ? "done" : "running",
  };
  await env.BRAIN_RAW.put(metaKey(job), JSON.stringify(next));

  if (next.state === "done") {
    await writeAudit(env.BRAIN_DB, {
      actor: "user",
      action: "export",
      targetType: "export",
      targetId: job,
      after: { profile, exp: meta.exp, parts: seq },
      reason: "",
    });
  }
  return next;
}

export async function startExport(
  env: Env,
  profile: "backup" | "portable",
  opts: { limit?: number } = {},
  now = Date.now(),
): Promise<{ status: number; body: unknown }> {
  const job = newEventId();
  const meta: ExportMeta = {
    profile,
    exp: now + EXPORT_TTL_MS,
    exported_at: now,
    state: "running",
    cursor: null,
    seq: 0,
    parts: 0,
    tables: false,
    table_index: 0,
    row_offset: 0,
  };
  const next = await exportSlice(env, job, meta, clampSlice(opts.limit, MAX_EXPORT_SLICE, DEFAULT_EXPORT_SLICE));
  return { status: 200, body: await exportView(env, job, next) };
}

export async function resumeExport(
  env: Env,
  job: string,
  opts: { limit?: number } = {},
): Promise<{ status: number; body: unknown }> {
  const meta = await readMeta(env, job);
  if (!meta) return { status: 404, body: { error: "not_found" } };
  if (meta.state === "done") return { status: 200, body: await exportView(env, job, meta) };
  const next = await exportSlice(env, job, meta, clampSlice(opts.limit, MAX_EXPORT_SLICE, DEFAULT_EXPORT_SLICE));
  return { status: 200, body: await exportView(env, job, next) };
}

export async function handleExportRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? limitRaw : undefined;

  const jobParam = url.searchParams.get("job");
  if (jobParam !== null) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(jobParam)) return json({ error: "bad_request" }, 400);
    const out = await resumeExport(env, jobParam, { limit });
    return json(out.body, out.status);
  }

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
  const out = await startExport(env, profile, { limit });
  return json(out.body, out.status);
}

export async function handleExportDownload(env: Env, job: string, url: URL): Promise<Response> {
  const exp = Number(url.searchParams.get("exp"));
  const token = url.searchParams.get("token") ?? "";
  if (!Number.isFinite(exp) || exp < Date.now()) return json({ error: "expired" }, 403);
  const expected = await exportLinkToken(env.CONTENT_HMAC_KEY, job, exp);
  if (!constantTimeEqual(token, expected)) return json({ error: "forbidden" }, 403);

  const metaObj = await env.BRAIN_RAW.get(metaKey(job));
  if (!metaObj) return json({ error: "not_found" }, 404);
  const meta = (await metaObj.json()) as { profile?: string; state?: string };
  if (meta.state === "running") {
    return json({ error: "in_progress", message: "export is still running; resume via GET /v1/export?job=" }, 409);
  }
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
