#!/usr/bin/env node
/**
 * Make `npm run deploy` self-provisioning on fresh accounts.
 *
 * Cloudflare auto-provisions D1 and R2 from id-less bindings, but NOT
 * Vectorize: deploying with a missing index hard-fails (error 10159). This
 * runs before `wrangler deploy` (see the "deploy" script) to create
 * `brain-memory` (768 dims, cosine) plus its metadata indexes when missing,
 * and to do nothing when they already exist.
 *
 * Failure posture — a fork must stay guided, a healthy deployment must never
 * be blocked for a no-op:
 * - Cannot verify (token lacks Vectorize permissions): warn, exit 0. The
 *   deploy's own 10159 check remains the guard; docs/setup.md carries the
 *   dashboard fallback.
 * - Index known-missing and creation failed, or the index exists but a
 *   metadata index could not be created: print the dashboard steps and
 *   exit 1 — metadata filters must not degrade silently.
 *
 * Set CLOUDFLARE_ACCOUNT_ID (Workers Builds does this itself); override the
 * index name with VECTORIZE_INDEX for drills or renamed indexes.
 */
import { execFileSync } from "node:child_process";

const INDEX = process.env.VECTORIZE_INDEX || "brain-memory";
const DIMENSIONS = 768;
const METRIC = "cosine";
const METADATA = ["type", "status", "sensitivity"];

const wrangler = (...args) =>
  execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });

const output = (error) => `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error?.message ?? ""}`;
const alreadyExists = (error) => /already exists|duplicate/i.test(output(error));
const firstLine = (error) => {
  const lines = output(error).split("\n");
  const line = lines.find((l) => l.includes("[ERROR]")) ?? lines.find((l) => l.trim() !== "");
  return (line ?? String(error)).trim().slice(0, 200);
};

const fallbackSteps = [
  "Create it in the Cloudflare dashboard instead, then retry the deployment",
  "(Settings → Builds → Retry):",
  `  1. Vectorize → Create index → name "${INDEX}", dimensions ${DIMENSIONS}, metric ${METRIC}`,
  `  2. Metadata indexes (string): ${METADATA.join(", ")}`,
];

function listIndexes() {
  const parsed = JSON.parse(wrangler("vectorize", "list", "--json"));
  if (!Array.isArray(parsed)) throw new Error("unexpected vectorize list output");
  return parsed.map((index) => index?.name);
}

function listMetadata() {
  const parsed = JSON.parse(wrangler("vectorize", "list-metadata-index", INDEX, "--json"));
  if (!Array.isArray(parsed)) throw new Error("unexpected metadata index output");
  return parsed.map((entry) => entry?.propertyName ?? entry?.name);
}

let indexNames;
try {
  indexNames = listIndexes();
} catch (error) {
  console.warn(`[ensure-vectorize] could not verify indexes (${firstLine(error)})`);
  console.warn("[ensure-vectorize] continuing — the deploy stays the guard; if it fails with 10159:");
  console.warn(fallbackSteps.join("\n"));
  process.exit(0);
}

if (indexNames.includes(INDEX)) {
  console.log(`[ensure-vectorize] index "${INDEX}" exists`);
} else {
  try {
    wrangler("vectorize", "create", INDEX, "--dimensions", String(DIMENSIONS), "--metric", METRIC);
    console.log(`[ensure-vectorize] created index "${INDEX}" (${DIMENSIONS} dims, ${METRIC})`);
  } catch (error) {
    if (alreadyExists(error)) {
      console.log(`[ensure-vectorize] index "${INDEX}" already exists`);
    } else {
      console.error(`[ensure-vectorize] could not create index "${INDEX}": ${firstLine(error)}`);
      console.error(fallbackSteps.join("\n"));
      process.exit(1);
    }
  }
}

let existingMetadata;
try {
  existingMetadata = listMetadata();
} catch {
  existingMetadata = undefined; // fall through to creates; "already exists" is tolerated
}

for (const property of METADATA) {
  if (existingMetadata?.includes(property)) {
    console.log(`[ensure-vectorize] metadata index "${property}" exists`);
    continue;
  }
  try {
    wrangler("vectorize", "create-metadata-index", INDEX, "--propertyName", property, "--type", "string");
    console.log(`[ensure-vectorize] metadata index "${property}" created`);
  } catch (error) {
    if (alreadyExists(error)) {
      console.log(`[ensure-vectorize] metadata index "${property}" already exists`);
      continue;
    }
    console.error(`[ensure-vectorize] could not create metadata index "${property}": ${firstLine(error)}`);
    console.error(fallbackSteps.join("\n"));
    process.exit(1);
  }
}

console.log(`[ensure-vectorize] "${INDEX}" ready`);
