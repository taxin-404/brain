# Brain — Phase 5 (procedural) plan

> Branch `phase-5` from `master` @ `4bdf2c3` (Phase 4 closed, merged, accepted,
> CI green). Same discipline as phases 0–4: tests-first per task (watch RED),
> one commit per task with its plan boxes ticked in the same commit, gate =
> unpiped `npx vitest run` + `npx tsc --noEmit` before every commit, ledger
> rulings in `.superpowers/sdd/2026-10-16-brain-phase-5/`. Free-tier: no new
> model calls anywhere in this phase; live acceptance single-shot.

## Context

Design §8 Phase 5: **"Versioning, human approval gate, trust requirements on
origin. Done when: Repeated workflow becomes an approved procedure; agent
cannot self-approve."**

Already in place: `procedures` + `procedure_versions` tables (migration 0002);
`propose_procedure` MCP tool (name + steps → proposals row, always manual);
`computeReviewMode` makes kind=procedure always manual; `applyProposal` throws
`unsupported` for procedures (`src/review.ts:233` — the Phase-5 hook).
Schema constraints: `procedures.origin_trust` (default 0), status
`draft|approved|deprecated`; `procedure_versions` UNIQUE(procedure_id, version),
`promoted_from_events`; design line 217: "PROCEDURAL (never promoted from
`external`-origin evidence)"; line 343: approve is **not** an MCP tool.

## Pinned decisions (Phase 5)

1. **Payload** (MCP propose_procedure + any REST proposer):
   `{name, steps[], trigger?, tools?[], success_criteria?, failure_notes?,
   procedure_id?, reason?, evidence_event_id?}`. `procedure_id` (optional)
   explicitly targets an existing procedure for a new version; otherwise apply
   matches by normalized name (lower/trim) against existing procedures; no
   match → new procedure. Validation caps (ledgered): name 1–120 chars,
   steps 1–50 non-empty strings ≤500 chars each, trigger ≤2000, tools ≤50
   non-empty strings, criteria/notes ≤2000.
2. **Trust on origin:** evidence is optional (mirrors propose_correction).
   At apply: evidence event present → `actor='external'` **hard-refuses**
   (`untrusted_origin`, 400; nothing written); otherwise
   `origin_trust = event.trust`. No evidence → `origin_trust = 0.5` (neutral,
   conservative — a human still has to apply + approve). Never promoted from
   external-origin evidence, enforced at the promotion gate.
3. **Promotion (apply):** kind=procedure → `promoteProcedureProposal`:
   creates the procedure (`status='draft'`, `current_version=1`) + version
   row, or appends version N+1 (updates name + `current_version`), writing
   `promoted_from_events` as a JSON array of evidence ids. **Any new version
   flips an `approved` procedure back to `draft`** — every version needs a
   fresh human approval. `deprecated` targets refuse (409). One audit row,
   action `approve`, target_type `procedure`. `applyProposal` return gains
   `{procedure_id?, version?}` additively; the REST apply response passes it
   through.
4. **Approval gate:** `POST /v1/procedures/:id/approve` (ADMIN only): draft →
   `approved` + audit (`approve_procedure`, actor `user`); already approved →
   409; deprecated → 409; unknown → 404. **Not an MCP tool** — the agent
   surface cannot approve even with a propose token (403), which is the
   "agent cannot self-approve" done-when.
5. **Undo:** procedure promotion has no undo (manual-tier; design requires
   undo only for auto-applied rows) → `undoProposal` for kind=procedure
   refuses (`unsupported`). Versions are append-only history; deprecation is
   a future flow (ledgered).
6. **Read routes (ops + Phase-6 inspector groundwork, ledgered like
   `GET /v1/why`):** `GET /v1/procedures` (read) → list; `GET
   /v1/procedures/:id` (read) → procedure + all versions (newest first),
   404 when unknown.
7. **No new embeddings/crons/secrets/migrations.** Procedures are not added
   to Vectorize/search this phase (done-when does not require it; reflection
   search parity stays deferred too) — ledgered.

## Review Focus (attack these)

- Self-approval: no code path lets MCP_PROPOSE/MCP_READ tokens flip a
  procedure to `approved`; the direct route check is the only gate.
- Poisoned origin: external evidence must leave zero rows behind on refusal.
- Version honesty: v1 never mutates when v2 lands; `current_version` and the
  `procedure_versions` count always agree.
- Re-approval: an approved procedure with an applied v2 is `draft` until a
  human approves again.

### Task 1 — promotion core (`src/procedures.ts` + review integration)

**Files:** Create `src/procedures.ts`; Modify `src/review.ts`; Test
`test/procedures.test.ts`.

**Interfaces:** `promoteProcedureProposal(env, row: ProposalRow, opts {now,
actor, reason}) → {procedure_id, version}`; `applyProposal` kind=procedure
calls it and returns `{applied:true, kind, procedure_id, version}`;
`undoProposal` refuses kind=procedure.

- [x] **Step 1: Tests** — draft v1 created (row + version row with steps JSON
  + `promoted_from_events` `[evidence]` + audit); external evidence refused
  with zero rows (proposal stays pending); no evidence → origin_trust 0.5;
  explicit `procedure_id` → v2 + `current_version` 2, **approved → draft**;
  name-match → v2; deprecated → 409-style refusal; payload validation
  failures; undo refused.
- [x] **Step 2: Run and watch fail.**
- [x] **Step 3: Implement** module + integration.
- [x] **Step 4: Gate + commit** — `feat(procedures): promotion + versioning engine`.

### Task 2 — approval gate + agent-cannot-self-approve

**Files:** Modify `src/procedures.ts`, `src/index.ts`; Test
`test/procedures.test.ts`.

**Interfaces:** `approveProcedure(env, id, {now}) → {id, status}`;
`handleApproveProcedure(request, env, id)`; route
`POST /^\/v1\/procedures\/([^/]+)\/approve$/` need admin.

- [x] **Step 1: Tests** — draft → approved + audit (`approve_procedure`);
  second approve → 409; unknown → 404; deprecated → 409; **MCP_READ and
  MCP_PROPOSE tokens → 403 on the approve route and on apply**; ADMIN apply
  of an external-evidence procedure → 400 `untrusted_origin`.
- [x] **Step 2: Run and watch fail.**
- [x] **Step 3: Implement** gate + route.
- [x] **Step 4: Gate + commit** — `feat(procedures): human approval gate`.

### Task 3 — read routes

**Files:** Modify `src/procedures.ts`, `src/index.ts`; Test
`test/procedures.test.ts`.

**Interfaces:** `handleListProcedures(env)` → `{procedures:[{id, name,
status, current_version, origin_trust, last_success_at, created_at}]}`;
`handleGetProcedure(env, id)` → `{procedure, versions:[...]}` newest first;
404 unknown; need read.

- [x] **Step 1: Tests** — list surfaces a created procedure; get returns both
  versions after a v2 (v1 payload intact); 404 unknown; MCP_READ works;
  MCP_PROPOSE → 403 (strict read).
- [x] **Step 2: Run and watch fail.**
- [x] **Step 3: Implement** both handlers + routes.
- [x] **Step 4: Gate + commit** — `feat(procedures): list + detail read routes`.

### Task 4 — MCP surface + done-when eval

**Files:** Modify `src/mcp.ts`; Create `test/eval-procedure.test.ts`; Test
`test/procedures.test.ts` (MCP schema case).

**Interfaces:** `propose_procedure` input gains optional `procedure_id`,
`trigger`, `tools[]`, `success_criteria`, `failure_notes`,
`evidence_event_id`; payload carries them.

- [x] **Step 1: Tests** — MCP propose with the new fields lands a manual
  proposal; e2e narrative (the done-when sentence): agent proposes a repeated
  workflow → admin applies (draft v1) → admin approves → **approved
  procedure exists**; agent proposes a refinement (`procedure_id`) → apply →
  **draft again** (re-approval gate) → approve → v2 approved, v1 intact; and
  every agent-token attempt to approve is 403.
- [x] **Step 2: Run and watch fail.**
- [x] **Step 3: Implement** schema extension; fix honestly if the eval bites.
- [x] **Step 4: Gate + commit** — `feat(mcp): propose_procedure fields + procedure eval`.

### Task 5 — docs + close-out

**Files:** Modify `README.md`; ledger close-out; mirror plan to
`/home/taxin/Work/docs/superpowers/plans/`.

- [ ] **Step 1: Full gate** — `npx vitest run` + `npx tsc --noEmit`.
- [ ] **Step 2: README** Phase 5 section (proposal → apply → approve, trust
  rules, versioning, routes) + status line.
- [ ] **Step 3: Tick every box; ledger close-out; mirror.**
- [ ] **Step 4: Commit** — `docs: close phase 5 (procedures + approval gate)`.

## Merge + acceptance (closing — one push)

- [ ] Merge `phase-5` → `master`, push; watch the CI build once. No migration.
- [ ] Live acceptance, single-shot each:
      1. `/mcp` `propose_procedure` (propose-capable token) → proposal id.
      2. `POST /v1/proposals/:id/apply` (ADMIN) → draft v1 + `procedure_id`.
      3. `GET /v1/procedures/:id` (read) → draft, version 1.
      4. `POST /v1/procedures/:id/approve` (ADMIN) → approved.
      5. `POST /v1/procedures/:id/approve` with MCP_READ → 403 (agent cannot
         self-approve).
      6. `GET /v1/procedures/:id` → approved v1.
- [ ] Owner actions (reminder only): Google Cloud budget alert; key rotation
      from the Phase-2 ledger.
