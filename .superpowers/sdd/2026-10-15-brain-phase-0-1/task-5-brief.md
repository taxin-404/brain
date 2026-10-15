### Task 5: Payload crypto + HMAC + doc

**Files:**
- Create: `src/crypto.ts`, `test/crypto.test.ts`, `docs/key-rotation.md`

**Interfaces:**
- Produces: `contentHmac(secret: string, body: string): Promise<string>` (HMAC-SHA256 over UTF-8 body, hex); `encryptPayload(kekSecret: string, plaintext: string): Promise<{ blob: ArrayBuffer; wrappedKey: string }>`; `decryptPayload(kekSecret: string, wrappedKey: string, blob: ArrayBuffer): Promise<string>`; `newEventId(): string` (26-char ULID).

- [ ] **Step 1: Write the failing crypto test** — `test/crypto.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { contentHmac, decryptPayload, encryptPayload, newEventId } from "../src/crypto";

describe("crypto", () => {
  it("round-trips a payload", async () => {
    const { blob, wrappedKey } = await encryptPayload("kek-1", "hello brain");
    expect(await decryptPayload("kek-1", wrappedKey, blob)).toBe("hello brain");
  });

  it("uses independent keys and IVs per call", async () => {
    const a = await encryptPayload("kek-1", "same");
    const b = await encryptPayload("kek-1", "same");
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
    expect(new Uint8Array(a.blob)).not.toEqual(new Uint8Array(b.blob));
  });

  it("rejects the wrong KEK", async () => {
    const { blob, wrappedKey } = await encryptPayload("kek-1", "hello");
    await expect(decryptPayload("kek-2", wrappedKey, blob)).rejects.toThrow();
  });

  it("contentHmac is stable per key and differs across keys/bodies", async () => {
    const h1 = await contentHmac("hmac-key", '{"a":1}');
    expect(await contentHmac("hmac-key", '{"a":1}')).toBe(h1);
    expect(await contentHmac("other-key", '{"a":1}')).not.toBe(h1);
    expect(await contentHmac("hmac-key", '{"a":2}')).not.toBe(h1);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("newEventId returns unique ULIDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newEventId()));
    expect(ids.size).toBe(100);
    expect([...ids][0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
```

- [ ] **Step 2: Run it, verify it fails** → FAIL (module missing).

- [ ] **Step 3: Implement `src/crypto.ts`**

Pinned choices: derive the AES-GCM key as `SHA-256(secret)` (any non-empty secret string is valid key material); data key = 32 random bytes from `crypto.getRandomValues`; `blob = iv(12) || ciphertext+tag` for the payload; `wrappedKey = base64(iv(12) || ct+tag)` of the data key wrapped with the KEK; `contentHmac` imports the secret string bytes directly as the HMAC key. ULID: Crockford base32, 48-bit ms timestamp (10 chars) + 80 random bits (16 chars).

- [ ] **Step 4: Run it, verify it passes** → PASS (5 tests).

- [ ] **Step 5: Write `docs/key-rotation.md`**

Outline to fill in (spec §3: "rotation procedure written before launch"): generate new KEK + escrow to password manager → rewrap walk over `event_keys` in batches (`SELECT id, wrapped_key LIMIT/OFFSET`, decrypt with old, wrap with new, `UPDATE … WHERE id = ?`) executed via `wrangler d1 execute brain-db --remote` → verify a sample decrypt → `wrangler secret put PAYLOAD_KEK` → keep the old KEK in escrow until a full decrypt spot-check passes.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: per-event payload encryption, keyed HMAC, ULIDs + rotation doc"
```

---

