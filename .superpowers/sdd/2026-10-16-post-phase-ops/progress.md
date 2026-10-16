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

## Export TTL race — found + fixed (2026-10-16, late)
The post-repair verification export surfaced a real DR-path bug: its resume walk ran past `EXPORT_TTL_MS` (15 min). Every payload page costs ~28 s (200 **sequential** R2 gets), so multi-thousand-payload walks exceed one TTL window; the link token derives from `meta.exp`, so **a finished-but-slow artifact is unreachable (download 403) while resumes keep returning 200/running** — and the still-running job becomes sweep-fodder once `exp + grace` lapses. Root cause style: measured, not guessed (28.6 s single resume call; meta exp long past; job at parts 21, state running).
Fix (commit `4777823`): every driven slice now renews `exp = now + EXPORT_TTL_MS`; abandoned jobs stop renewing and still expire/sweep normally. Test: resumed slice `expires_at` must exceed the previous one's. Full gate 236/236 + tsc.
Consequence for repair verification: re-export re-split is superseded — **direct prod-side verification** instead: download all 1,768 repaired blobs from prod R2 (`--remote`) and byte-compare (`cmp`) against the HMAC-gated local files. No worker/CPU involvement at all.

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

## Post-repair verification — artifact + direct R2 byte-gate (2026-10-16, close-out)
- Live checks on the deployed instance (single-shot calls only): `GET /v1/export?profile=backup&limit=500` → 200 (F1 clamp live); resume `expires_at` renewed across slices (+3,443 ms measured; TTL fix live).
- Fresh post-repair artifact walked to completion (job `01M51FHJHJ4BYTMSZYQT27S694`, done at part 24, 8,729,490 bytes, 2,276 payload rows — +249 rows from this session's own traffic). **Step-level re-split: `blob_fail = 5` — exactly the five permanently-degraded skips** (2 `_t2` post-ingest mutation, 1 empty-text, 2 idx_not_tool); plain 2,258 / no_key 13. All 1,768 repaired blobs decrypt from a fresh prod export.
- Orphan archaeology (pre 39 → post 13): 37 old orphans gained `event_keys` rows and now decrypt (consistent with the fixed ingest re-claiming on later re-ingest/reconcile); 2 remain (`oc_repro_*` test remnants); 11 new no_key are **export time-skew** — ids interleave with this session's own shell ids, i.e. events ingested *during* the walk (tables are read at walk start; payload pages stream minutes later). Documented as finding 6 in `docs/dr-drill.md`; not a defect.
- **Direct prod-R2 byte-gate: OK=1768 FAILED=0 MISMATCH=0** — every repaired blob in prod R2 is byte-identical (`cmp`) to its HMAC-gated local re-encryption. This is the authoritative prod-side proof (supersedes the earlier re-export plan; see TTL-race note).
- Teardown complete: drill worker/D1/Vectorize deleted; drill R2 bucket emptied (2,034 deletes) + deleted; `.secrets/drill.env` removed; local sim state cleaned. `wrangler.drill.jsonc` kept (gitignored template).
- CI: master builds green through `b218f60` (carries `9b3d627` race fix, `6f1cf8d` F1 clamp, `4777823` TTL renewal).
- Remaining (owner-only): GCP budget alert; rotate the chat-pasted Google key + revoke unrecognized `cfut_` tokens; KEK escrow of `.secrets/prod.env`, then delete the local copy.

## Dashboard errors triage — 37/37 historical dev-era, zero since (2026-10-16)
Owner flagged the brain-api dashboard: "4k requests, 37 errors". Investigation (systematic-debugging; evidence-first, no guessing):
- **Analytics** (GraphQL `workersInvocationsAdaptive`, 3-day window Oct 13 04:52Z → Oct 16 05:52Z): 3,973 requests = 3,934 success + **37 errors** (19 `scriptThrewException` + 18 `exceededResources`) + 2 `clientDisconnected` (aborts, not errors). Matches the dashboard exactly.
- **Timeline**: all 37 errors fall in Oct 15 12:42Z → Oct 15 23:37Z (= Oct 15 18:42 → Oct 16 05:37 local) — the single-sitting build-out night. **Zero errors since** (5.5h+, spanning the entire loop-injection/repair/DR-drill/live-check era — the heaviest real traffic yet).
- **Per-window correlation** (opencode.log shell commands ± local, git commit times):
  - 18:42–18:46 local (12:42–12:46Z): plugin v1 ingest dev — live crafted-batch curls during plugin/serialization debugging.
  - 20:27 (14:27Z): CI-webhook era probe (commit `docs(ci)` at 20:27:33 local, 12 s later).
  - 21:12 + 21:37 (15:12/15:37Z): phase-2 Gemini client + embeddings live tests (era commits 21:15/21:35).
  - 23:07–23:53 (17:07–17:53Z): phase-2/3/4 live acceptance — `why`/review-undo probes, factstore, crons, health probes; windows show the probe batteries in opencode.log.
  - 00:26 + 00:32 (18:26/18:32Z): phase-5 procedures era + phase-6 kickoff (probe batteries; vitest/ledger lines adjacent).
  - 01:09–01:17 (19:09–19:17Z): phase-6 resumable export dev — `wrangler tail` + acc6 export probes (that era even ran its own tail capture).
  - **01:38:49–01:40:25 (19:38:49–19:40:25Z): 15+1+1 `exceededResources`** — the export CPU-ceiling discovery burst (python probe scripts hammering export pages; crypto/KEK greps immediately after); fixed by `slice tables + hoist KEK` (01:48) → later F1 clamp.
  - 01:59 (19:59Z): export single-header era; fixed 02:01.
  - 02:15 (20:15Z): 1 `exceededResources` during portable-deletion testing; fixed meta-first at 02:20.
  - 05:37 local (23:37:39Z): last error — Gemini flash-lite availability probing; fallback fix `7ba7c76` landed 3 min later.
- **Current-state proofs**: post-fix plugin diag log (from 03:15Z) = 436 `ingest_ok` / 0 errors; `ingest.ts` race-safe (claim-before-put, all `INSERT OR IGNORE`); full suite 236/236 + tsc clean; post-repair export + R2 byte-gate + DR drill all green (above).
- **Verdict: no live defect.** Every error is a dev-era artifact whose class got fixed that same night/morning; each fix has a commit + regression test. The dashboard's 3-day rolling window will decay to 0 by ~Oct 19 on its own; nothing to repair.
- Tooling note for future forensics: the Workers Observability telemetry query API needs "Workers Observability Write" — absent from the wrangler OAuth scopes (fresh login re-verified) and from `CF_BUILDS_TOKEN` (403 both). Historical request logs are therefore not retrievable with current credentials; GraphQL analytics works via OAuth, and `wrangler tail` is the live-capture path. Optional owner-only item: mint an API token with Workers Observability Write if historical log retrieval is ever wanted.
