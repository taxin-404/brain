### Task 15: Keyword eval harness (recall@5 regression gate)

**Files:**
- Create: `eval/keyword.json`, `test/eval.test.ts`

**Interfaces:**
- Produces: eval file schema `[{ "q": string, "expect": string, "doc": string }]` — `doc` is a real excerpt captured during Tasks 13/14 (or the owner's sessions), `q` a natural query for it, `expect` a substring that must appear in one of the top-5 excerpts. ≥ 10 pairs now; the spec's 100-pair personal eval set grows from here. Gate: recall@5 ≥ 0.9.

- [ ] **Step 1: Seed the eval file with ≥ 10 real pairs**

Derive each `doc`/`q`/`expect` from actual captured sessions (start with the Task 14 live session). No invented content.

- [ ] **Step 2: Write the harness test** — `test/eval.test.ts`

Ingest every `doc` as a manual note (session `eval-<i>`), then assert `hits / pairs.length ≥ 0.9` where a hit means one of the top-5 `searchEvents(env, q, 5, { includeRestricted: false })` excerpts contains `expect`.

- [ ] **Step 3: Run it; prove the gate can fail, then restore**

Run: `npx vitest run test/eval.test.ts` → PASS. Garble `expect` values, re-run → FAIL (recall drops), restore → PASS. This proves the gate detects regressions, not just that it passes. (Executed note: with 12 pairs, garbling ONE expectation still yields 11/12 = 0.917 ≥ 0.9; the failure demonstration garbled TWO → 10/12 = 0.833 → FAIL.)

- [ ] **Step 4: Full suite + commit**

Run: `npx vitest run` → ALL PASS.

```bash
git add -A && git commit -m "test: keyword eval harness with recall@5 regression gate"
```

---
