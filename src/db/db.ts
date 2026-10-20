/**
 * SQLite bootstrap (PRD §7, §11): one better-sqlite3 file, WAL, foreign
 * keys on, and a minimal ordered-migrations runner.
 *
 * The schema lives in `schema.sql` next to this file (the PRD §11 tree);
 * `pnpm build` copies it into `dist/db/` so the emitted app finds it at
 * the same relative path.
 *
 * All timestamps stored in this DB are UTC ISO (AGENTS.md).
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

/** An open connection. */
export type DB = Database.Database;

interface Migration {
  version: number;
  sql: string;
}

/**
 * Ordered schema migrations. v1 is the PRD §7 schema verbatim (plus the
 * COALESCE dedupe index — see schema.sql). New migrations are appended,
 * never edited: applied versions are recorded in `schema_migrations`.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    // Eager: a missing schema.sql means a broken checkout/build — fail now,
    // not mid-poll.
    sql: readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8"),
  },
];

/**
 * Open (creating if needed) the database at `path` and apply pending
 * migrations. `":memory:"` is supported for tests — it skips the file
 * pragmas that do not apply to in-memory databases.
 *
 * Creates parent directories for file paths (PRD §10 default
 * `./data/parceltongue.db` implies `data/` may not exist yet).
 */
export function openDb(path: string): DB {
  if (path !== ":memory:") {
    const dir = dirname(resolve(path));
    if (dir !== "") {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(path);

  // OFF by default and per-connection: the events → packages FK (PRD §7)
  // is only enforced when this is on.
  db.pragma("foreign_keys = ON");
  if (!db.memory) {
    // WAL: crash-safe for a single-writer personal app; NORMAL is the
    // documented safe setting to pair with it. (In-memory DBs report
    // journal_mode "memory" and need no pragmas at all.)
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
  }
  // Single process by design, but never die on a transient lock (e.g. a
  // `sqlite3` CLI inspection).
  db.pragma("busy_timeout = 5000");

  migrate(db);
  return db;
}

/** Highest applied schema version (for boot logs). */
export function schemaVersion(db: DB): number {
  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null };
  return row.version ?? 0;
}

function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set<number>(
    (
      db.prepare("SELECT version FROM schema_migrations").all() as Array<{
        version: number;
      }>
    ).map((r) => r.version),
  );
  const pending = MIGRATIONS.filter((m) => !applied.has(m.version));
  if (pending.length === 0) return;

  const now = new Date().toISOString();
  const apply = db.transaction((migrations: readonly Migration[]) => {
    for (const m of migrations) {
      db.exec(m.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(m.version, now);
    }
  });
  apply(pending);
}
