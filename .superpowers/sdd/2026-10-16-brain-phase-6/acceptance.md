# Phase 6 — live acceptance evidence (2026-10-16)

Build/commit chain for the accepted artifact: `42a9356` (Worker build
`34de4b1e-7340-4077-81e2-eb17d3a4a50c`, outcome success). T7–T10 fix chain
(`8e39df5`, `1150ab5`, `5450602`, `b850d9a`) all deployed to `master` first.

## 1. Connector sync — PASS (build `5ad08322`, commit `71a455d`)

- `POST /v1/connectors/github/sync` (ADMIN, `taxin-404/brain`, lookback 720 h)
- sync #1: `{fetched:5, stored:5, duplicates:0}`
- sync #2: `{stored:0, duplicates:5}` (idempotent)

## 2. Backup export (+ resumable walk) — PASS

- start `GET /v1/export?profile=backup` → `state:"running"`, parts 1
- download of a running job → **409** `in_progress`
- 17 resumes `GET /v1/export?job=…` → all 200 (no 1101/1102) → `done`, 18 parts
- download → 200, 7,042,918 bytes, 1,801 lines, **exactly 1 header**, 1,780
  payload rows, table rows present (events/event_keys/entities/facts/…)
- audit: `action=export`, profile `backup`, 1 row

## 3. Portable export (+ retention) — PASS

- `GET /v1/export?profile=portable` without token → **403** `confirm_required`
- mint `POST /v1/confirm/token` target `export:portable` → 201 (single-use)
- start → running; 22 resumes all 200 → `done`, 23 parts
- download #1 → 200, 1,894,531 bytes, **exactly 1 header**, 1,787 payload rows,
  **zero `"wrapped_key":` fields**, no `event_keys` table (regex-verified)
- download #2 → **404** (meta deleted first; parts best-effort — T10)
- decrypted 201 / null 1,586: nulls are pre-existing foreign-key payloads from
  the owner's `oc_*` bridge ingestion. Offline check (escrowed KEK, backup
  artifact): ULID-era payloads 199/199 decrypt; 2 orphans (no wrapped key).
  Null-degradation is the designed behavior (§8); owner notified.

## Notes

- Free plan ceilings handled: subrequests (sliced walks + resume) and CPU
  10 ms (hoisted KEK, 400-row table slices, 100-object portable pages).
- Download fragments incident (pre-T10) documented in the ledger; hardened by
  deleting `meta.json` first + per-key try/catch; verified live (dl2 404).
