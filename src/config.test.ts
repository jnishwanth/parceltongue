import { describe, expect, it } from "vitest";
import { loadConfig, ConfigError } from "./config.js";

const validEnv: NodeJS.ProcessEnv = {
  TELEGRAM_BOT_TOKEN: "123456:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789",
  OWNER_CHAT_ID: "424242",
};

describe("loadConfig", () => {
  it("parses a valid env", () => {
    const cfg = loadConfig(validEnv);
    expect(cfg.telegramBotToken).toBe(validEnv.TELEGRAM_BOT_TOKEN);
    expect(cfg.ownerChatId).toBe(424242);
    expect(cfg.pollIntervalMin).toBe(15);
    expect(cfg.dbPath).toBe("./data/parceltongue.db");
    expect(cfg.logLevel).toBe("info");
  });

  it("applies option overrides", () => {
    const cfg = loadConfig({
      ...validEnv,
      POLL_INTERVAL_MIN: "7",
      DB_PATH: "/tmp/pt.db",
      LOG_LEVEL: "DEBUG",
    });
    expect(cfg.pollIntervalMin).toBe(7);
    expect(cfg.dbPath).toBe("/tmp/pt.db");
    expect(cfg.logLevel).toBe("debug");
  });

  it("trims surrounding whitespace", () => {
    const cfg = loadConfig({
      TELEGRAM_BOT_TOKEN: "  123456:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789  ",
      OWNER_CHAT_ID: " 77 ",
    });
    expect(cfg.telegramBotToken).toBe("123456:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789");
    expect(cfg.ownerChatId).toBe(77);
  });

  it("accepts a negative OWNER_CHAT_ID (channel ids)", () => {
    const cfg = loadConfig({ ...validEnv, OWNER_CHAT_ID: "-1001234567890" });
    expect(cfg.ownerChatId).toBe(-1001234567890);
  });

  it("reports every problem, not just the first", () => {
    expect(() => loadConfig({})).toThrowError(ConfigError);
    try {
      loadConfig({});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const problems = (err as ConfigError).problems;
      expect(problems.some((p) => p.startsWith("TELEGRAM_BOT_TOKEN"))).toBe(true);
      expect(problems.some((p) => p.startsWith("OWNER_CHAT_ID"))).toBe(true);
    }
  });

  it("rejects a malformed bot token", () => {
    try {
      loadConfig({ ...validEnv, TELEGRAM_BOT_TOKEN: "not-a-token" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).problems[0]).toContain("malformed");
    }
  });

  it("rejects non-integer OWNER_CHAT_ID", () => {
    expect(() => loadConfig({ ...validEnv, OWNER_CHAT_ID: "abc" })).toThrowError(
      /OWNER_CHAT_ID must be an integer/,
    );
    expect(() => loadConfig({ ...validEnv, OWNER_CHAT_ID: "4.2" })).toThrowError(
      /OWNER_CHAT_ID must be an integer/,
    );
  });

  it("rejects out-of-range POLL_INTERVAL_MIN", () => {
    for (const bad of ["0", "-3", "abc", "2000"]) {
      expect(
        () => loadConfig({ ...validEnv, POLL_INTERVAL_MIN: bad }),
        `POLL_INTERVAL_MIN=${bad}`,
      ).toThrowError(/POLL_INTERVAL_MIN/);
    }
  });

  it("rejects an unknown LOG_LEVEL", () => {
    expect(() => loadConfig({ ...validEnv, LOG_LEVEL: "loud" })).toThrowError(
      /LOG_LEVEL must be one of/,
    );
  });
});
