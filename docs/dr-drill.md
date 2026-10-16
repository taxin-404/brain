# Disaster-recovery drill — 2026-10-16

Goal: prove the design-v1.2 DR story end to end on a scratch environment:
a prod backup artifact restores into a fresh account and the restored brain
serves (counts, payloads, search) — within free-plan limits.

## Scratch environment

| Resource  | Name                              | Notes                                  |
| --------- | --------------------------------- | -------------------------------------- |
| Worker    | `brain-drill.taxin-404.workers.dev` | deployed from master via `wrangler.drill.jsonc` (gitignored; no crons) |
| D1        | `brain-drill-db`                  | all 6 migrations applied                |
| R2        | `brain-drill-raw`                 | artifact + restored payload blobs       |
| Vectorize | `brain-memory-drill`              | bound (empty)                           |
| Secrets   | `.secrets/drill.env` (never committed) | admin token only for driving the drill |

## Artifact staging

An existing prod backup artifact (7,854,315 bytes, 1 header + table lines +
2,027 `r2_payloads` rows) was staged as
`exports/drill01/{000.ndjson,meta.json}` and driven with
`POST /v1/restore {job:"drill01"}` repeated until `done:true` (bounded loop).

## Result — restore green in 3 calls

| Table              | Artifact | Restored |
| ------------------ | -------- | -------- |
| events             | 2004     | 2004     |
| event_keys         | 1988     | 1988     |
| entities           | 35       | 35       |
| entity_aliases     | 1        | 1        |
| facts              | 73       | 73       |
| fact_sources       | 74       | 74       |
| edges              | 5        | 5        |
| proposals          | 2        | 2        |
| procedures         | 1        | 1        |
| procedure_versions | 1        | 1        |
| reflections        | 1        | 1        |
| audit_log          | 107      | 107      |
| r2_payloads        | 2027     | 2027     (800 + 800 + 427 puts) |

- Final call returned `done:true`, `fts_rows:2004`; the restore wrote its own
  `audit_log` entry.
- `GET /v1/health-report` on the drill agrees: events 2004, purges 16,
  reflections 1.
- Payload spot check (event `oc_msg_13f939975001W1yJrCqIU6uya8_t2`): the
  restored R2 object is byte-identical to the artifact's b64 (sha256 match),
  decrypts with the KEK under its stored `wrapped_key`, and the redacted body
  re-derives the stored `content_hmac`.
- `GET /v1/search?q=…` returned ranked hits — FTS + vector + embedding
  pipeline live on the restored data.

## Findings

1. **No CPU/subrequest ceiling at current scale.** Restore v1 re-walks the
   whole artifact per call and pages 800 payload puts per call
   (`DEFAULT_RESTORE_SLICE`); at 7.85 MB this stays inside free-plan limits.
   The planned restore-v2 (line-cursor, 250 puts/call) is **deferred**: revisit
   when an artifact exceeds roughly 3× today's size (~25 MB), where the
   per-call re-walk is expected to breach the 10 ms CPU ceiling.
2. **`wrangler r2 object put/get` default to the local simulation in this
   environment.** Objects written without `--remote` land in
   `.wrangler/state/v3/r2/…` and are invisible to the deployed worker, while
   CLI round-trips still "succeed" — a convincing false positive. Discriminate
   with `--local` vs `--remote` on the same key; always pass `--remote` for
   real staging. (This was discovered when the first staged drill artifact
   produced 404s from the worker.)
3. **Restore copies ciphertext verbatim** (`content_hmac` preserved as data,
   no re-derivation). Blobs damaged before an exported snapshot stay damaged
   after restore — healing happens at the source (the offline repair) or in
   later exports, not in the restore path.
4. **Export F1 clamp** (`BACKUP_PAYLOAD_PAGE = 200`, commit `6f1cf8d`): with
   `?limit=500` the payload page used to b64encode 500 objects (~2.5 MB) per
   call, breaching the 10 ms CPU ceiling in live testing (1102-class
   failures). Backup pages now clamp to the proven-safe 200.
5. **Export links renew on every driven slice** (commit `4777823`). A payload
   page costs ~28 s (200 *sequential* R2 gets), so large export walks can
   outrun the 15-minute `EXPORT_TTL_MS`. The download token derives from
   `meta.exp`, so a walk that outlived its window produced a finished
   artifact that could never be downloaded while resumes kept reporting
   `running` — and the running job was seconds from being swept. Resumes now
   renew `exp`; abandoned jobs stop renewing and still expire normally.

## Free-tier discipline

Export, restore and search calls are single-shot or bounded-resume of the
designed job mechanisms; all against the scratch environment. No load or
loops. Teardown (worker, D1, R2, Vectorize) follows in the ops ledger.
