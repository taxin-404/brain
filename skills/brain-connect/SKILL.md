---
name: brain-connect
description: Use when connecting an AI coding agent (OpenCode, Claude Code, Cursor, Codex, Windsurf, or any MCP client) to a hosted "brain" memory server — configuring remote MCP HTTP URLs and Bearer tokens, choosing read vs propose vs admin token scopes, wiring auto-capture of session events, or troubleshooting brain connection health (unauthorized, 503 not configured, MCP_PROPOSE scope required).
---

# brain-connect — wire any agent to a brain memory server

**Endpoint:** `https://<worker>/mcp` — remote **Streamable HTTP** MCP, auth is
`Authorization: Bearer <token>`.

**Sanity check** (no client needed):
`GET /v1/health-report` with the token → `200` with counters = wired;
`401`/`unauthorized` = wrong/missing token; `503 {"error":"not configured"}`
= the worker lacks its secrets (`PAYLOAD_KEK`, `ADMIN_TOKEN`) — set those in
the Cloudflare dashboard first.

## Tokens — least privilege, deliberately split

- `MCP_READ_TOKEN` — read-only surface: `recall`, `get_blocks`,
  `health_report` (refuse writes with `MCP_PROPOSE scope required`). The
  standing choice for code agents.
- `MCP_PROPOSE_TOKEN` — adds `remember` + all `propose_*` tools (capture and
  knowledge maintenance). **Must differ from the read token.**
- Minimal setup: only `ADMIN_TOKEN` exists on the worker — use it everywhere
  (it covers every scope).
- Keep two MCP entries with disjoint scopes (`brain` read, `brain-propose`
  write) rather than one entry that can both read and write — each session
  then carries the least scope it needs.

## Per-agent config (remote HTTP + header auth)

**Claude Code** (terminal, any project):
```bash
claude mcp add --transport http --scope user brain https://<worker>/mcp \
  --header "Authorization: Bearer <MCP_READ_TOKEN>"
```
Verify: `claude mcp list`, then `/mcp` in-session.

**OpenCode** — `~/.config/opencode/opencode.json` (merge, existing keys kept):
```jsonc
{
  "mcp": { "brain": { "type": "remote", "url": "https://<worker>/mcp",
    "headers": { "Authorization": "Bearer <READ>" } },
    "brain-propose": { "type": "remote", "url": "https://<worker>/mcp",
    "headers": { "Authorization": "Bearer <PROPOSE>" } } }
}
```

**Cursor** — `~/.cursor/mcp.json` (never the project dir if committed):
```json
{ "mcpServers": { "brain": { "url": "https://<worker>/mcp",
  "headers": { "Authorization": "Bearer <READ>" } } } }
```
Windsurf similar (`~/.codeium/windsurf/mcp_config.json`); verify its current
header-auth field before trusting a cached snippet.

**Codex / others:** any MCP client that supports Streamable HTTP + custom
headers; same URL and header shape.

## Auto-capture (the layer that makes memory self-writing)

Ready-made capture clients ship in the repo:

- **OpenCode** — the bundled plugin (`plugin/`, install `cd plugin && npm i`,
  options `{ endpoint, token }`).
- **Claude Code** — a zero-dependency SessionEnd hook shim
  (`clients/claude-code/capture.mjs`); register it in
  `~/.claude/settings.json` → its README has the exact snippet.
- **Anything else** — POST bare JSON event arrays to the same endpoint; the
  shared event contract is in `clients/README.md` and per-endpoint recipes
  (MCP-free agents, schedulers, CI) are in `docs/rest-recipes.md`.

The server also accepts `POST /v1/events/batch` with the **propose** token
from any runtime (mirror the schema from `plugin/src/capture.ts`; never
invent field names — the server validates strictly). Without capture, agents
only store what they deliberately propose.

## Common mistakes

- wrong token scope → `MCP_PROPOSE scope required`; use the propose token for
  that entry
- 401 after a token rotation → both entries and the plugin need the new value
- tokens pasted into committed files → keep configs in the home directory /
  env vars, never in `project/.cursor` style paths that share with the repo
- proposal created ≠ applied — `propose_*` lands reviewable rows only; the
  apply/discard/undo steps (and every purge) are admin REST verbs — the exact
  calls live in `docs/rest-recipes.md`
