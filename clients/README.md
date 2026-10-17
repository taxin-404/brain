# Capture clients — wiring any agent runtime to the brain

Auto-capture is what makes the memory self-writing: session transcripts flow
into `POST /v1/events/batch`, and the worker's scheduled pipeline
(extraction → consolidation → weekly reflection) promotes repeated patterns
into durable facts. Clients are optional — an agent with no capture client
can still read (MCP or REST) and deliberately store via `remember`, but
capture is what compounds.

| Client | Runtime | Coverage |
|---|---|---|
| [`plugin/`](../plugin/) — bundled capture plugin | OpenCode | install via npm, options `{ endpoint, token }`; full message + tool capture |
| [`claude-code/`](claude-code/) — SessionEnd hook shim | Claude Code (and anything that ships JSONL transcripts) | zero-dep Node ≥ 18; map + POST contract identical to the plugin |
| [`docs/rest-recipes.md`](../docs/rest-recipes.md) | everything else — Codex, Gemini CLI, custom relays, CI | plain Bearer/JSON recipes for every endpoint, no MCP required |

## The shared event contract

All clients post **bare JSON arrays** of event objects to
`POST /v1/events/batch` with an `MCP_PROPOSE_TOKEN` Bearer token
(single object bodies also accepted for one event). Server-side validation
lives in `src/ingest.ts`:

- `source` — `"opencode" | "file" | "github" | "manual"` (pick by origin of
  the record; transcript-fed shims use `"file"`)
- `actor` — `"user" | "assistant" | "tool" | "external"`
- `kind` — any non-empty string; the built-ins are `"message"` and
  `"tool_call"`
- `id` — optional; `^[A-Za-z0-9_-]{1,64}$`. Keep stable per source record so
  replays dedupe (`stored` vs `duplicate` in the reply)
- `ts` — optional epoch millis (epoch seconds are auto-normalized)
- `payload` — required; strings are recursively truncated and redacted
  server-side; ≤ 1 MiB per event after redaction
- batches ≤ 500 events; duplicate detection also by
  `(session_id, payload-hmac)` so identical re-sends are free

Adding a new client? Mirror [`plugin/src/capture.ts`](../plugin/src/capture.ts)
payload shapes (`{ text }`, `{ tool, call_id, … }`) — downstream extraction
was built around them — and ship the mapping tests the shim's tests model.
