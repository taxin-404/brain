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
          bindings: {
            PAYLOAD_KEK: "dev-kek",
            CONTENT_HMAC_KEY: "dev-hmac",
            MCP_READ_TOKEN: "dev-read",
            MCP_PROPOSE_TOKEN: "dev-propose",
            ADMIN_TOKEN: "dev-admin",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"] },
  };
});
