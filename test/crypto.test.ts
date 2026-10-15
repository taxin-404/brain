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
