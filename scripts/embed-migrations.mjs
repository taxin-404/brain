#!/usr/bin/env node
/**
 * Regenerate src/migrations.generated.ts from migrations/*.sql.
 *
 * The Worker applies pending migrations at first request (src/bootstrap.ts)
 * and cannot read files at runtime, so the split statements are embedded here.
 * readD1Migrations is the vitest plugin's own reader — using it guarantees the
 * embedded copy matches what `wrangler d1 migrations apply` and the test
 * harness produce (same statement splitter, same migration names).
 *
 * Run after any change under migrations/:  npm run migrations:embed
 * test/migrations.test.ts fails the build if this file goes stale.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFile = path.join(root, "src", "migrations.generated.ts");

const migrations = (await readD1Migrations(path.join(root, "migrations"))).map((m) => ({
  name: m.name,
  queries: m.queries,
}));

const header = `// GENERATED — do not edit by hand.
// Source of truth: migrations/*.sql. Regenerate: npm run migrations:embed.
// The Worker applies pending migrations at first request (src/bootstrap.ts);
// test/migrations.test.ts fails the suite if this copy goes stale.
//
// Migrations recorded in d1_migrations keep wrangler and the vitest plugin
// interoperable — same table, same names, same statement split.

export interface EmbeddedMigration {
  readonly name: string;
  readonly queries: readonly string[];
}

`;

const body = `export const MIGRATIONS: readonly EmbeddedMigration[] = ${JSON.stringify(migrations, null, 2)};\n`;

await writeFile(outFile, header + body);
const queries = migrations.reduce((n, m) => n + m.queries.length, 0);
console.log(
  `[embed-migrations] ${migrations.length} migrations / ${queries} queries -> src/migrations.generated.ts`,
);
