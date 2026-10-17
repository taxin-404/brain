# REST recipes — the brain over plain HTTP (no MCP required)

Every capability is reachable with `curl`-grade Bearer/JSON — any agent,
scheduler, or language HTTP client can use the full brain without an MCP
runtime. Verified live against a real worker (read + write + dedupe flows).

## Conventions

```sh
export BRAIN_URL="https://brain-api.<your-subdomain>.workers.dev"
export TOKEN="$MCP_READ_TOKEN"        # or MCP_PROPOSE_TOKEN / ADMIN_TOKEN per scope
```

Scopes: `read` (search/health/blocks/...), `propose` (+ events), `admin`
(always ADMIN_TOKEN-authored verbs: purge, apply, raw blocks PUT, pipeline
runs). Wrong token → `401 unauthorized`; scope miss → the endpoint's scope
error. Unconfigured worker → `503` from the bootstrap.

## Liveness & discovery

```sh
curl "$BRAIN_URL/v1/health-report" -H "Authorization: Bearer $TOKEN"        # read
curl "$BRAIN_URL/inspector" 2>&1 | head -5                                  # public; browser page
```

## Reading (read scope)

```sh
curl "$BRAIN_URL/v1/search?q=deploy+prefix"  -H "Authorization: Bearer $TOKEN"
curl "$BRAIN_URL/v1/facts/<fact_id>"         -H "Authorization: Bearer $TOKEN"  # + provenance
curl "$BRAIN_URL/v1/why/<fact_id>"           -H "Authorization: Bearer $TOKEN"  # evidence chain
curl "$BRAIN_URL/v1/entities/<entity_id>"    -H "Authorization: Bearer $TOKEN"
curl "$BRAIN_URL/v1/blocks"                  -H "Authorization: Bearer $TOKEN"  # working memory
curl "$BRAIN_URL/v1/procedures"              -H "Authorization: Bearer $TOKEN"
curl "$BRAIN_URL/v1/proposals"?status=pending  -H "Authorization: Bearer $TOKEN" # review queue (default)
curl "$BRAIN_URL/v1/reflections/latest"      -H "Authorization: Bearer $TOKEN"
```

## Writing events (propose scope) — the capture contract

Body is a **bare JSON array** (or one bare object). Contract per event, from
`src/ingest.ts`:

```sh
curl -X POST "$BRAIN_URL/v1/events/batch" \
  -H "Authorization: Bearer $MCP_PROPOSE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
    {
      "id": "cc_11111111-2222-3333-4444-555555555555",
      "ts": 1760695200000,
      "source": "file",
      "actor": "user",
      "kind": "message",
      "session_id": "my-session-1",
      "payload": { "text": "we always deploy with tb/ prefixed branches" }
    }
  ]'
```

- `source`: `"opencode" | "file" | "github" | "manual"` — pick by record origin
- `actor`: `"user" | "assistant" | "tool" | "external"`
- `id` optional, `^[A-Za-z0-9_-]{1,64}$`, stable → replay dedupe
- batch ≤ 500 events, each ≤ 1 MiB after server-side redaction
- reply: `201 { "results": [{ "id", "status": "stored" | "duplicate" }], "stored", "charged" }`
- re-send the same array → every entry `status:"duplicate"`, `stored:0`

Sealed payloads land encrypted; restricted input never becomes readable.

## Admin verbs (ADMIN_TOKEN only)

```sh
# destructive verbs need a one-time confirm token, minted for that exact target:
CONFIRM=$(curl -X POST "$BRAIN_URL/v1/confirm/token" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"target": "<event_id>"}' | jq -r .token)
# store every value before you paste it — the mint reply is the only copy
# purge an event that captured something it must not keep
curl -X POST "$BRAIN_URL/v1/events/<event_id>/purge" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"confirm_token\": \"$CONFIRM\", \"reason\": \"leaked credential\"}"
# review a proposal tier decision
curl -X POST "$BRAIN_URL/v1/proposals/<id>/apply"    -H "Authorization: Bearer $ADMIN_TOKEN"  # | discard | undo
# fact maintenance (correct | dispute | purge)
curl -X POST "$BRAIN_URL/v1/facts/<fact_id>/correct" -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"correction": "..."}'
# approve a proposed procedure
curl -X POST "$BRAIN_URL/v1/procedures/<id>/approve" -H "Authorization: Bearer $ADMIN_TOKEN"
# working-memory block overwrite (blocks read are read-scope; writes are admin)
curl -X PUT  "$BRAIN_URL/v1/blocks/preferences"      -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"value":"..."}'
# manual pipeline runs (normally on crons */30, 03:00, Mon 04:00)
curl -X POST "$BRAIN_URL/v1/extract"      -H "Authorization: Bearer $ADMIN_TOKEN"
curl -X POST "$BRAIN_URL/v1/consolidate"  -H "Authorization: Bearer $ADMIN_TOKEN"
curl -X POST "$BRAIN_URL/v1/reflect"      -H "Authorization: Bearer $ADMIN_TOKEN"
# mint a fresh token (e.g. after rotation); store the value before use
# (token minting itself: `cf` CLI or the Cloudflare dashboard — the worker's
#  /v1/confirm/token endpoint mints the one-time confirm tokens above only)
# backup / restore
curl "$BRAIN_URL/v1/export" -H "Authorization: Bearer $ADMIN_TOKEN"     # job → download URL
curl -X POST "$BRAIN_URL/v1/restore" -H "Authorization: Bearer $ADMIN_TOKEN" -d @backup.json
```

## Non-MCP agent loop

Session start: `GET /v1/blocks` (+ `recall`-shaped `GET /v1/search`) → work
normally → session end: POST the transcript as events (or run the
[`clients/claude-code`](../clients/claude-code/) shim) → the pipeline turns
repetitions into facts between sessions.
