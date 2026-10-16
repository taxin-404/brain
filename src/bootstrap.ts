import { MIGRATIONS } from "./migrations.generated";

/** Runtime D1 schema bootstrap.
 *
 *  A fresh fork (id-less D1 binding, auto-provisioned at deploy) has no schema
 *  until its first request — there is no terminal in the fork flow. This runs
 *  the pending migrations embedded from `migrations/*.sql` and records them in
 *  the standard `d1_migrations` table, so all three worlds stay interoperable:
 *
 *  - fresh forks: bootstrap here, at first use;
 *  - existing deployments (`wrangler d1 migrations apply`): every name is
 *    already recorded — this no-ops after one small batch;
 *  - tests: the vitest setup boots through this same path, and the plugin's
 *    `applyD1Migrations` replay recognizes the bookkeeping.
 *
 *  Each migration is applied as one atomic `db.batch` (statements + the
 *  bookkeeping insert), so a mid-boot crash never leaves a half-applied
 *  migration recorded as done — the next request retries it. Two isolates
 *  racing the same fresh database resolve via the UNIQUE name: the loser's
 *  batch rolls back, sees the winner's row, and continues.
 *
 *  Memoized per D1 binding; a failed attempt is cleared so the next request
 *  retries it.
 */

const READY = new WeakMap<D1Database, Promise<void>>();

const ENSURE_BOOKKEEPING =
  "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)";
const SELECT_APPLIED = "SELECT name FROM d1_migrations";
const RECORD_APPLIED = "INSERT INTO d1_migrations (name) VALUES (?1)";
const SELECT_RECORDED = "SELECT name FROM d1_migrations WHERE name = ?1";

export function ensureSchema(db: D1Database): Promise<void> {
  let ready = READY.get(db);
  if (!ready) {
    ready = applyPending(db).catch((error: unknown) => {
      READY.delete(db);
      throw error;
    });
    READY.set(db, ready);
  }
  return ready;
}

async function applyPending(db: D1Database): Promise<void> {
  const results = await db.batch([db.prepare(ENSURE_BOOKKEEPING), db.prepare(SELECT_APPLIED)]);
  const applied = new Set(
    ((results[1]?.results ?? []) as Array<{ name: string }>).map((row) => row.name),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    try {
      await db.batch([
        ...migration.queries.map((query) => db.prepare(query)),
        db.prepare(RECORD_APPLIED).bind(migration.name),
      ]);
    } catch (error) {
      // A concurrent cold isolate may have applied it first; the atomic batch
      // rolled back here, so trust the bookkeeping row over the thrown error.
      const recorded = await db.prepare(SELECT_RECORDED).bind(migration.name).first<{ name: string }>();
      if (!recorded) throw error;
    }
  }
}
