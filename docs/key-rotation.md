# PAYLOAD_KEK rotation

Every payload is encrypted with a per-event data key; the data key is wrapped with
`PAYLOAD_KEK` (AES-GCM, key derived as SHA-256 of the secret). Rotating the KEK means
rewrapping every row in `event_keys` — payload blobs in R2 never change.

1. **Generate + escrow the new KEK first.**
   ```bash
   openssl rand -base64 32          # NEW_KEK — save to the password manager NOW
   ```
   The old KEK must stay in escrow until step 5 passes.

2. **Rewrap `event_keys` in batches** (run locally against prod):
   ```bash
   npx wrangler d1 execute brain-db --remote --command \
     "SELECT event_id, wrapped_key FROM event_keys LIMIT 500 OFFSET 0"
   ```
   For each row: `decryptPayload(OLD_KEK, wrapped_key, emptyBlob)`-style unwrap of the
   data key, then rewrap with `NEW_KEK` via the same code path as
   `encryptPayload`/`decryptPayload` in `src/crypto.ts` (unwrap step only — the payload
   blob is untouched):
   ```bash
   npx wrangler d1 execute brain-db --remote --command \
     "UPDATE event_keys SET wrapped_key = '<new>' WHERE event_id = '<id>'"
   ```
   Repeat with increasing OFFSET until all rows are rewrapped. `event_keys` has no
   append-only trigger, so these UPDATEs are allowed by design.

3. **Verify a decrypt spot-check** against the live Worker (admin token):
   recall a recent event through `GET /mcp` or `wrangler d1 execute` + the decrypt
   helper — it must succeed with `NEW_KEK` and fail with `OLD_KEK`.

4. **Activate the new KEK:**
   ```bash
   printf '%s' "$NEW_KEK" | npx wrangler secret put PAYLOAD_KEK
   ```

5. **Keep the old KEK in escrow** until a full-sample decrypt spot-check passes on the
   deployed Worker (batch 2 already proved decryption pre-activation; this confirms the
   secret took effect). Only then discard the old KEK.

Notes:
- Never rotate by `wrangler secret delete` + recreate — that leaves rows unwrappable.
- If a rewrap run dies halfway, rerun from OFFSET 0; rewrapping an already-rewrapped row
  with the NEW_KEK is a decrypt-with-NEW failure — skip rows that fail with OLD and
  succeed with NEW (idempotent recovery).
- `CONTENT_HMAC_KEY` rotation is separate: HMACs exist only for dedupe/integrity inside
  a session; a rotation invalidates historical dedupe hits (acceptable — dedupe is
  best-effort across sessions).
