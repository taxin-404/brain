import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
        },
      },
    }),
  ],
});
