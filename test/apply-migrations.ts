import { env } from "cloudflare:workers";
import { ensureSchema } from "../src/bootstrap";

// Boot the schema through the Worker's real runtime path — the same code a
// fresh fork runs at its first request — instead of the plugin's
// applyD1Migrations. Storage is fresh per test file, so every file exercises a
// virgin-database boot; test/migrations.test.ts pins the details.
await ensureSchema(env.BRAIN_DB);
