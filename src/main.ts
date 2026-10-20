import { existsSync } from "node:fs";
import pino from "pino";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { openDb, schemaVersion, type DB } from "./db/db.js";

/**
 * Bootstrap.
 *
 * M3 state: validates config, builds the logger, opens the SQLite database
 * (creating the file + parent dir, applying migrations) and exits. The
 * real pipeline (db → poller → bot, PRD §6) completes in M4–M6; process
 * keep-alive comes with the bot (M6).
 */
function main(): void {
  // Node 22 built-in .env loading; does not override already-set vars.
  if (existsSync(".env")) {
    try {
      process.loadEnvFile(".env");
    } catch {
      // A broken .env must not kill boot before loadConfig can report it.
    }
  }

  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Logger doesn't exist yet for this path — the one sanctioned console.error.
      console.error(err.message);
      console.error("Copy .env.example to .env and fill in the required values.");
      process.exit(1);
    }
    throw err;
  }

  const log = pino({ level: cfg.logLevel });
  log.info(
    {
      dbPath: cfg.dbPath,
      pollIntervalMin: cfg.pollIntervalMin,
      logLevel: cfg.logLevel,
    },
    "parceltongue booting (M4: db + poller module; wired together with the bot in M6)",
  );

  let db: DB;
  try {
    db = openDb(cfg.dbPath);
  } catch (err) {
    log.fatal({ err: err instanceof Error ? err.message : String(err) }, "failed to open database");
    process.exit(1);
  }
  log.info(
    { dbPath: cfg.dbPath, schemaVersion: schemaVersion(db) },
    "database ready",
  );

  db.close();
  log.info(
    "poller not started yet — emit sink + keep-alive come with the bot (M6); see MILESTONES.md",
  );
}

main();
