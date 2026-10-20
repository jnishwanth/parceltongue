import { describe, expect, it } from "vitest";
import {
  ALERT_STREAK,
  BACKOFF_DAY_MS,
  BACKOFF_ONE_HOUR_MS,
  BACKOFF_SIX_HOURS_MS,
  backoffMs,
} from "./backoff.js";

describe("backoffMs (PRD §8: alert at streak 3, then 1 h → 6 h → 24 h)", () => {
  it("no pause below the alert streak", () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(1)).toBe(0);
    expect(backoffMs(2)).toBe(0);
    expect(ALERT_STREAK).toBe(3);
  });

  it("escalates 1 h → 6 h and plateaus at 24 h", () => {
    expect(backoffMs(ALERT_STREAK)).toBe(BACKOFF_ONE_HOUR_MS);
    expect(backoffMs(ALERT_STREAK + 1)).toBe(BACKOFF_SIX_HOURS_MS);
    expect(backoffMs(5)).toBe(BACKOFF_DAY_MS);
    expect(backoffMs(42)).toBe(BACKOFF_DAY_MS);
  });
});
