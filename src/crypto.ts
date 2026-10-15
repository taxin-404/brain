const enc = new TextEncoder();
const dec = new TextDecoder();

// workers-types declares importKey usages as string[]; keep the union local.
type AesUsage = "encrypt" | "decrypt";

async function aesKeyFromSecret(secret: string, usages: AesUsage[]): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, usages);
}

function bytesToBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** Encrypt plaintext under a fresh per-event data key; the data key is wrapped with the KEK.
 *  blob = iv(12) || ciphertext+tag. wrappedKey = base64(iv(12) || wrapped data key). */
export async function encryptPayload(
  kekSecret: string,
  plaintext: string,
): Promise<{ blob: ArrayBuffer; wrappedKey: string }> {
  const dataKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const dataKey = await crypto.subtle.importKey("raw", dataKeyBytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  const kek = await aesKeyFromSecret(kekSecret, ["encrypt", "decrypt"]);

  const dataIv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: dataIv }, dataKey, enc.encode(plaintext));
  const blob = new Uint8Array(12 + ciphertext.byteLength);
  blob.set(dataIv, 0);
  blob.set(new Uint8Array(ciphertext), 12);

  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapIv }, kek, dataKeyBytes);
  const wrappedBytes = new Uint8Array(12 + wrapped.byteLength);
  wrappedBytes.set(wrapIv, 0);
  wrappedBytes.set(new Uint8Array(wrapped), 12);

  return { blob: blob.buffer, wrappedKey: bytesToBase64(wrappedBytes) };
}

export async function decryptPayload(kekSecret: string, wrappedKey: string, blob: ArrayBuffer): Promise<string> {
  const kek = await aesKeyFromSecret(kekSecret, ["encrypt", "decrypt"]);

  const wrappedBytes = base64ToBytes(wrappedKey);
  const dataKeyBytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: wrappedBytes.subarray(0, 12) },
    kek,
    wrappedBytes.subarray(12),
  );
  const dataKey = await crypto.subtle.importKey("raw", dataKeyBytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);

  const blobBytes = new Uint8Array(blob);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: blobBytes.subarray(0, 12) },
    dataKey,
    blobBytes.subarray(12),
  );
  return dec.decode(plaintext);
}

export async function contentHmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 48-bit ms timestamp (10 chars) + 80 random bits (16 chars), Crockford base32. */
export function newEventId(): string {
  const time = Date.now();
  const bytes = new Uint8Array(16);
  bytes[0] = Math.floor(time / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(time / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(time / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(time / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(time / 2 ** 8) & 0xff;
  bytes[5] = time & 0xff;
  crypto.getRandomValues(bytes.subarray(6));

  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(acc & 31n)] + out;
    acc >>= 5n;
  }
  return out;
}
