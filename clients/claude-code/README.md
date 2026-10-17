# Claude Code → brain auto-capture

A zero-dependency Node shim that wires Claude Code's native `SessionEnd` hook
to the brain event API — the same auto-capture the OpenCode plugin provides.

## What it does

1. Claude Code runs it at session end with hook JSON on stdin
   (`session_id`, `transcript_path`).
2. It reads the JSONL transcript and maps user/assistant/tool records exactly
   the way the bundled OpenCode plugin does (same `kind` names, same payload
   shapes, same string truncation) with `source: "file"`.
3. It POSTs bare JSON arrays to `POST /v1/events/batch` with your propose
   token. The server dedupes by id, so re-running a session is free.

Fail-open by contract: never exits nonzero, never prints payload text.

## Install

Requirements: Node ≥ 18 (global `fetch`), a brain worker, and your
**MCP_PROPOSE_TOKEN** (see the root README for minting one).

**1. Put the script somewhere permanent.** Clone or download this repo, e.g.
`~/brain/clients/claude-code/capture.mjs` — the path below must be absolute.

**2. Export the connection** in your shell profile (`~/.bashrc` / `~/.zshrc`):

```sh
export BRAIN_ENDPOINT="https://brain-api.<your-subdomain>.workers.dev"
export BRAIN_PROPOSE_TOKEN="<MCP_PROPOSE_TOKEN>"
```

**3. Register the hook** in `~/.claude/settings.json` (user scope, so every
project gets it — do not commit the token into a project's settings):

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "node /ABSOLUTE/PATH/clients/claude-code/capture.mjs" }
        ]
      }
    ]
  }
}
```

## Verify

```sh
# map a transcript without posting anything:
node clients/claude-code/capture.mjs \
  --transcript /path/to/some-transcript.jsonl --dry-run \
  --session-id manual-check | head -40

# then let a real session end, and check the server:
tail -n 5 ~/.claude/logs/* 2>/dev/null   # stderr lines: brain-capture: N events — X stored, Y duplicate
```

The MCP server has tools for the rest: read via `recall` / `get_blocks`, and
extraction promotes the captured events on its own schedule. If MCP is not
wired, `docs/rest-recipes.md` has the HTTP recipes.

## Manual / other-runtimes capture

The shim is intentionally boring input→output plumbing. Any runtime that can
write a JSONL transcript (or any post-session script that can build the same
event objects) can reuse it:

```sh
node clients/claude-code/capture.mjs --transcript <file>.jsonl --session-id <id>
```

…or POST the bare event array to `/v1/events/batch` yourself —
`docs/rest-recipes.md` documents the exact body contract.
