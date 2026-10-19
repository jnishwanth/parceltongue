import { existsSync } from "node:fs";
import pino from "pino";
import { ConfigError, loadConfig, type Config } from "./config.js";

/**
 * Bootstrap.
 *
 * M1 state: validates config, builds the logger, logs the boot line and
 * exits. The real pipeline (db → poller → bot, PRD §6) is wired in M3–M6;
 * process keep-alive comes with the bot (M6).
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
    "parceltongue booting (M1 scaffold)",
  );
  log.info(
    "db/poller/bot not wired yet — see MILESTONES.md (next: M2 Delhivery adapter)",
  );
}

main();
