# Setup prompt — wire your agent to a deployed brain (client side only)

Paste everything below the line into your AI coding agent. It assumes:
shell access, an already-deployed brain worker (see README "Quick deploy"
or docs/setup.md first if not — this prompt deliberately does NOT touch the
worker), and your tokens. Re-runnable: every step is a check-if-done first.

---

You are setting up a local machine to use the owner's deployed **brain**
memory server. You are NOT deploying or modifying the server ("not the
server" rule). Your goal: MCP connection + skills + capture + escrow on this
machine, verified with live evidence at every stage. Work stage by stage;
never skip a verification; never print a secret value (mask tokens as their
first 4 characters + "…").

## Stage 0 — Intake

Collect (asking the user is fine):
1. `WORKER_URL` — e.g. `https://brain-api.<their-subdomain>.workers.dev`
   (ask; no guessing). If unsure, `GET /v1/health-report` variants can't
   identify it — only the user knows their subdomain.
2. Tokens: `MCP_READ_TOKEN`, `MCP_PROPOSE_TOKEN`, `ADMIN_TOKEN`
   (minimal-mode workers only set `ADMIN_TOKEN` — the same value then
   serves all scopes; the server enforces the rest).
3. Runtime(s) to wire: OpenCode / Claude Code / Cursor / Codex / other
   MCP-capable agent. Ask which, wire only those.

If the user has NO tokens yet: stop and route them to their Cloudflare
dashboard where the worker's secrets are set (the worker never ships
tokens; see docs/setup.md §3). Never invent values.

## Stage 1 — Escrow before anything

Write the provided values to a local escrow file before any further use of
them — paste discipline: "store every value before you paste it".

```sh
ESCROW="$HOME/.config/brain-escrow"
mkdir -p "$ESCROW" && chmod 700 "$ESCROW"

cat > "$ESCROW/brain.env" <<'EOF'
BRAIN_URL=https://REPLACE-ME.workers.dev
MCP_READ_TOKEN=""
MCP_PROPOSE_TOKEN=""
ADMIN_TOKEN=""
EOF
chmod 600 "$ESCROW/brain.env"
```

Fill the three values into that file (your editor or a careful `sed`),
keeping it outside any git repo; then load it for the stages below:

```sh
set -a; . "$ESCROW/brain.env"; set +a
```

Confirm with `ls -l "$ESCROW/brain.env"` (600) — and confirm the file is
NOT inside the repository you are working in.

## Stage 2 — Prove the worker answers

```sh
set -a; . ~/.config/brain-escrow/brain.env; set +a
curl -s -o /dev/null -w "%{http_code}" "$BRAIN_URL/v1/health-report" \
  -H "Authorization: Bearer ${MCP_READ_TOKEN:-$ADMIN_TOKEN}"
```

- `200` → proceed.
- `401` → wrong/mistyped token; show the user which scope failed, ask for a
  re-paste, Stage 1 again.
- `503` → the worker lacks `PAYLOAD_KEK`/`ADMIN_TOKEN` or schema boot
  failed: server-side. STOP wiring and hand the user the dashboard
  recovery path in docs/setup.md (§5 checklist).

## Stage 3 — Wire the MCP (two entries, disjoint scopes unless minimal mode)

Detect the runtime, then wire. Detect = look for its config presence; ask
when ambiguous.

- **OpenCode** — `~/.config/opencode/opencode.json` (merge, preserve
  existing keys; BACK UP the full file first, e.g.
  `opencode.json.bak-brain-$(date +%s)`): add
  `"mcp": { "brain": {...read...}, "brain-propose": {...propose...} }`,
  both `type: "remote"`, `url: $BRAIN_URL + "/mcp"`, Bearer header per scope.
- **Claude Code** —
  `claude mcp add --transport http --scope user brain "$BRAIN_URL/mcp"
     --header "Authorization: Bearer $MCP_READ_TOKEN"`
  (add a second server entry named e.g. `brain-propose` with the propose
  token only if the user wants writes from this client).
- **Cursor** — `~/.cursor/mcp.json` (user dir, never a committed project
  dir): `mcpServers.brain` with url + Authorization header.
- **Codex / other** — any MCP client supporting Streamable HTTP + custom
  headers; same URL and header.

Re-runs: if entries already exist with correct URL + headers, say so and
skip (idempotency).

## Stage 4 — Install the skills (any runtime that reads ~/.agents/skills)

```sh
npx skills add <REPO_SLUG> --skill brain-memory --yes --global
npx skills add <REPO_SLUG> --skill brain-connect --yes --global
```

`<REPO_SLUG>` = `owner/repo` of the brain the user is using (ask or read
`git remote get-url origin` if run inside the repo). Verify: the two
`SKILL.md` files exist under the runtime's skills dir
(`~/.agents/skills/brain-*/SKILL.md`) and mention their tool names.

## Stage 5 — Capture (optional but recommended)

Ask the user; then:
- **OpenCode**: repo `plugin/` — `cd plugin && npm i`; register the plugin
  with options `{ endpoint: $BRAIN_URL, token: $MCP_PROPOSE_TOKEN }`.
- **Claude Code**: copy `clients/claude-code/capture.mjs` somewhere stable,
  export `BRAIN_ENDPOINT` + `BRAIN_PROPOSE_TOKEN` in the shell profile, add
  the `SessionEnd` hook to `~/.claude/settings.json` (exact snippet in
  `clients/claude-code/README.md`).
- **Other runtimes / scripts**: POST bare JSON event arrays to
  `$BRAIN_URL/v1/events/batch` (contract in `clients/README.md`; cookbooks
  in `docs/rest-recipes.md`).

## Stage 6 — Final evidence suite (report all, then a verdict)

Run all; report statuses with counts, never token values:
1. `GET /v1/health-report` → expect `200`; report `events` count and
   `warn/breaker` flags.
2. MCP read tool (`get_blocks` or `recall("smoke")`) → expect a tool reply,
   not an auth error.
3. Write-path probe (ask permission — it charges budget): `POST
   /v1/events/batch` one event `{id:"smoke-<random>", source:"manual",
   actor:"user", kind:"message", payload:{text:"setup smoke"}}` → expect
   `201`; re-send → expect `duplicate` (dedupe proof); count rises by 1.
4. Skills present (Stage 4 check).
5. Capture client matching the runtime (Stage 5) — installed or declined.

Failure map: `401` → token/scope mismatch; `MCP_PROPOSE scope required` →
read token used for a write; `503` → server bootstrap (stop, dashboard);
`over_limit/breaker_open` → budget hit, report counters, stop pressing.

## Stage 7 — Close

Summarize: what was configured where (paths only), what remains manual
(student: nothing on the server must be touched by this prompt), and the
re-run instruction ("paste the same prompt; it will check-if-done and skip").
