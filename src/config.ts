/**
 * Env parsing + validation (PRD §10).
 *
 * `loadConfig` accepts an env map (defaults to `process.env`) so tests can
 * run without touching the real environment.
 */

export type LogLevel =
  | "fatal"
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "trace"
  | "silent";

export interface Config {
  telegramBotToken: string;
  ownerChatId: number;
  pollIntervalMin: number;
  dbPath: string;
  logLevel: LogLevel;
}

const LOG_LEVELS: readonly LogLevel[] = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
];

/** Raised when one or more env vars are missing or malformed. `problems` lists all of them. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
    this.name = "ConfigError";
  }
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const problems: string[] = [];

  // --- required ---------------------------------------------------------
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  if (telegramBotToken === "") {
    problems.push("TELEGRAM_BOT_TOKEN is required (create a bot via @BotFather)");
  } else if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(telegramBotToken)) {
    problems.push(
      "TELEGRAM_BOT_TOKEN looks malformed (expected `<botId>:<secret>`, e.g. 123456:ABC-…)",
    );
  }

  const ownerChatIdRaw = env.OWNER_CHAT_ID?.trim() ?? "";
  const ownerChatId = Number(ownerChatIdRaw);
  if (ownerChatIdRaw === "") {
    problems.push("OWNER_CHAT_ID is required (your numeric Telegram chat id, e.g. from @userinfobot)");
  } else if (!Number.isInteger(ownerChatId)) {
    problems.push("OWNER_CHAT_ID must be an integer (negative values are fine for channel ids)");
  }

  // --- optional with defaults -------------------------------------------
  let pollIntervalMin = 15;
  const pollRaw = env.POLL_INTERVAL_MIN?.trim() ?? "";
  if (pollRaw !== "") {
    const n = Number(pollRaw);
    if (!Number.isInteger(n) || n < 1 || n > 1440) {
      problems.push("POLL_INTERVAL_MIN must be an integer between 1 and 1440");
    } else {
      pollIntervalMin = n;
    }
  }

  const dbPath = env.DB_PATH?.trim() || "./data/parceltongue.db";

  const logLevelRaw = (env.LOG_LEVEL?.trim() || "info").toLowerCase();
  if (!(LOG_LEVELS as readonly string[]).includes(logLevelRaw)) {
    problems.push(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(", ")}`);
  }

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  return {
    telegramBotToken,
    ownerChatId,
    pollIntervalMin,
    dbPath,
    logLevel: logLevelRaw as LogLevel,
  };
}
