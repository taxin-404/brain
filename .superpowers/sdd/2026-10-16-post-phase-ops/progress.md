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
