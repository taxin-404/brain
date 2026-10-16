# Post-phase ops — progress

- [start] Plan written. Kicking backup export for the DR drill; scratch env setup in parallel.

## F1 — export resume `?limit=500` dies with 1102 (found 2026-10-16)
Kicking a backup export with `limit=500` returned a non-JSON error (empty/1102 class): one payload page of 500 objects = 500 R2 gets + b64encode per call, over the free-plan 10 ms CPU. Default 200 (acceptance-proven) is safe. Fix to land with the drill hardening: clamp the backup payload page to 200 in exporter.ts (`BACKUP_PAYLOAD_PAGE`), README slice note.

## F2 — `oc_*` payloads undecryptable: root cause = ingest race (fixed in code 2026-10-16)
Step-level analysis of a fresh backup export (1,908 blobs): 205 decrypt, **1,678 fail with ZERO unwrap failures** (every `wrapped_key` unwraps with the escrowed prod KEK — the KEK was never the problem), 25 orphans (16 purge tombstones + 9 strays, no `event_keys` row).
Failing blobs do not decrypt under any KEK/sibling-key variant (300 crossing probes, 0 hits). Hour histogram shows interleaved pass/fail with no era boundary — per-event, not per-era.
Root cause: `ingest.ts` stored the R2 blob during preparation, **before** the claim inserts. The plugin fires ingest concurrently (idle + step.ended + 30-min reconcile, un-mutexed): two racing identical batches both pass the pre-insert dedupe, both encrypt with fresh data keys, both `put payloads/<id>` (last wins), then `INSERT OR IGNORE` keeps the **first** `event_keys` row → stored key ≠ stored blob → permanently undecryptable. ULID-era events were written single-threaded by tests ⇒ passed.
Fix (commit): encrypt during prepare; PUT the blob only for rows whose `event_keys` INSERT actually landed; serialize plugin ingest via `makeSerialQueue`. RED test added (fails 22 ms on old code, passes after).
Repair plan (F2-repair): re-encrypt the failing blobs offline from the original local OpenCode store, each gated by the stored `content_hmac` (byte-exact redacted body), then direct R2 puts; verify by re-export + analyzer.

## Progress — 2026-10-16 (later)
- F2 fix shipped: `360b318` pushed; CI build `8426f1cf` success → prod runs the race-safe ingest (all writers route through `ingestEvents`: MCP, connector, purge).
- Artifact TTL learned the hard way: `EXPORT_TTL_MS = 15 min` — the first drill artifact expired before the repair pipeline could run (and the harness restart wiped the local copy). Export→download→use must happen inside 15 minutes. Fresh export running for the repair.
- Drill creds regenerated + re-put (restart wiped /tmp); now stored at `.secrets/drill.env` (gitignored). Drill worker redeployed on current master.
- **Item 4 (blocks) verdict — no defect.** Blocks are written only by admin `PUT /v1/blocks/:key` or an approved `block_edit` proposal (`src/blocks.ts`, `src/review.ts`). Prod truth: blocks 0; proposals ever = 2 (both resolved: 1 create→approve→undo at 17:28-17:29, plus 1 other); zero block/proposal audit rows beyond those. The curated-memory layer is empty because no curation call has ever been made — extraction-driven layers (72 facts, entities, edges) are populated. Nothing to fix; seeding path = `propose_block_edit` (MCP) by the owner's assistant, or direct admin PUT.

## F2-repair — offline re-encryption (in flight 2026-10-16)
- Pipeline: fresh backup artifact (job `01M51BR9K6Z194TK931JFS1FE1`, 7,854,315 bytes / 21 parts, downloaded inside the 15-min TTL) → step-level split (plain 215 / blob_fail 1,773 / no_key 39) → source reconstruction from the local OpenCode store (`session_message` v2 rows; full ids, no truncation) → `redactPayload` (esbuild-bundled from src) → **byte-exact gate: HMAC(redacted) must equal the stored `content_hmac`** → unwrap the event's own data key with the escrowed KEK → re-encrypt → direct R2 put.
- Verified: **1,768 / 1,773** reconstructed byte-exact. Skipped 5 (all "content mutated between ingest and now": 2 `_t2` tool parts whose state completed after ingest, 1 live-streaming message's text/parts — 0.28%).
- Sample round-trip proven first: `oc_msg_13f92782e001C3wbaZ7Nf9i8m4` re-uploaded → downloaded from prod R2 → decrypts under its stored wrapped key → HMAC MATCHES stored content_hmac. **Correction (2026-10-16 late): CLI `r2 object` commands defaulted to the local simulation — that round-trip exercised local storage only. The authoritative prod-side proof is the post-repair export re-split (F2-repair verify, below).**
- Upload: 1,768 files, 4× wrangler puts, retry-drain for flakes.
- Post-verify plan: fresh export after uploads → re-run step-level split → expect `blob_fail ≈ 5` (the skipped); then reuse that artifact for the DR drill.

## F2-repair upload — local/remote trap caught mid-flight (2026-10-16)
The first upload drain "completed" 1,357/1,768 with 61 flakes — then the demand surfaced: **`wrangler r2 object put/get` default to the LOCAL simulation in this environment** (`--remote` required; without it objects land in `.wrangler/state/v3/r2/…` and CLI round-trips falsely succeed while the worker sees nothing). Discovered while debugging staged drill artifacts that the worker 404'd. All repair scripts fixed (`upload.sh`, `drill-restore.sh`), drain re-run clean: **1,768/1,768 remote, 0 failed**.
Discrimination method (keep for ops): `wrangler r2 object get <bucket>/<key> --local` vs `--remote` on the same key.

## DR drill — GREEN (2026-10-16)
- Scratch env (worker `brain-drill`, D1 `brain-drill-db`, R2 `brain-drill-raw`, Vectorize `brain-memory-drill`), all on free plan, driven with single-shot/bounded calls only. Full report: `docs/dr-drill.md`.
- Artifact staged **remotely** (7,854,315 bytes, 2,027 payload rows) → `POST /v1/restore` loop → **done:true in 3 calls**; every table's restored count equals the artifact exactly; 2,027 payload puts (800/800/427); `fts_rows:2004`; drill health-report parity; restore audit entry written.
- Spot check: restored R2 blob sha256-identical to the artifact b64; decrypts with the KEK under the stored `wrapped_key`; redact→HMAC matches stored `content_hmac`. `GET /v1/search` returns ranked hits.
- **Ceiling not reproduced at current scale**: restore v1 (full re-walk per call, 800 puts/call) fits free-plan limits at 7.85 MB. **Restore-v2 deferred** — trigger: artifact > ~25 MB (3× today) or an observed 1102/1101 in a restore call; design (line cursor, 250 puts/call) stays queued in this ledger.
- F1 fixed + committed `6f1cf8d` (`BACKUP_PAYLOAD_PAGE = 200` clamp + regression test; 235/235 tests, tsc clean).
- Note: the drill artifact was the pre-repair export — restore copies ciphertext verbatim, so old damage would persist in that restored copy; prod-side healing was the repair upload above, and future exports carry the repaired blobs.
