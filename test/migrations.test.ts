import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { MIGRATIONS } from "../src/migrations.generated";

/** The plugin's own embedded copy of migrations/ (vitest.config.ts binding) —
 *  the same splitter, read at test-start. */
const dirMigrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;

describe("embedded migrations (src/migrations.generated.ts)", () => {
  it("stay in sync with migrations/ — on failure run: npm run migrations:embed", () => {
    expect(MIGRATIONS.map((m) => ({ name: m.name, queries: [...m.queries] }))).toEqual(
      dirMigrations.map((m) => ({ name: m.name, queries: [...m.queries] })),
    );
  });
});
