import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Migration-free D1s for bootstrap tests (test/migrations.test.ts):
          // MIGRATION_DB exercises a genuine first boot; REPLAY_DB is
          // pre-migrated via the plugin to pin the replay no-op; BROKEN_DB
          // gets a hostile d1_migrations table to pin the memo-clear retry.
          d1Databases: ["MIGRATION_DB", "REPLAY_DB", "BROKEN_DB"],
          bindings: {
            PAYLOAD_KEK: "dev-kek",
            CONTENT_HMAC_KEY: "dev-hmac",
            MCP_READ_TOKEN: "dev-read",
            MCP_PROPOSE_TOKEN: "dev-propose",
            ADMIN_TOKEN: "dev-admin",
            GEMINI_API_KEY: "dev-gemini",
            AI_GATEWAY_BASE: "https://gw.test/google-ai-studio",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"] },
  };
});
