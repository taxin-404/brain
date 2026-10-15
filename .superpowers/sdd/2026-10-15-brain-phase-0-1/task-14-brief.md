### Task 14: Phase 1 acceptance gate

**Files:** none created — this task runs the done-when checks from spec §8 and captures results.

- [ ] **Step 1: Full suite, naming the spec's gates**

Run: `npx vitest run && cd plugin && npx vitest run` → ALL PASS. Specifically confirm: `test/purge.test.ts` (crypto-shred end-to-end + identical-payload independence), `test/rebuild.test.ts` (purge-survives-rebuild), `test/budget.test.ts` (breaker at 80,000, ADMIN exempt).

- [ ] **Step 2: Deploy Phase 1**

Run: `npx wrangler deploy` → green (the `*/30` cron is now registered); `npx wrangler d1 migrations apply brain-db --remote` → no new migrations.

- [ ] **Step 3: Register the capture plugin** (ask the owner before editing their global config)

In `~/.config/opencode/opencode.json(c)` add to `plugins`:

```jsonc
{ "package": "/home/taxin/Work/brain/plugin",
  "options": { "endpoint": "https://brain-api.<your-subdomain>.workers.dev", "token": "<MCP_PROPOSE_TOKEN prod value>" } }
```

Then: `opencode service restart`; confirm the plugin loaded once a session starts: `grep brain-capture ~/.local/share/opencode/log/opencode.log | tail -1`.

- [ ] **Step 4: Live end-to-end — a full session lands automatically** (spec: no agent cooperation)

Run an OpenCode session (any project) whose prompt contains the marker `brain-e2e-marker-7f3a`, let it go idle, then:

```bash
curl -s "$ENDPOINT/v1/health-report" -H "Authorization: Bearer $MCP_READ_TOKEN"   # expect events >= 1
curl -s "$ENDPOINT/v1/search?q=brain-e2e-marker-7f3a" -H "Authorization: Bearer $MCP_READ_TOKEN"  # expect a hit whose excerpt contains the marker
```

- [ ] **Step 5: MCP registration spot-check (optional, recommended)**

Run: `opencode mcp add brain --url "$ENDPOINT/mcp" --header "Authorization: Bearer $MCP_READ_TOKEN"` (check `--help` for exact flags first) then `opencode mcp list` → shows the server; ask an agent in a session to call `recall` with a term from Step 4.

- [ ] **Step 6: Record results + commit**

Append the observed events count and search hit to the commit (or `git status` → commit any stragglers):

```bash
git add -A && git commit -m "chore: phase 1 acceptance run" || git status
```

---

