/**
 * Error-streak backoff (PRD §8).
 *
 * `error_streak` (see `recordPoll` in db/repo.ts) counts consecutive
 * auth/schema failures for one parcel — the failures where *we* are the
 * suspect (stale front-door headers, PRD §4.3 pitfall 6, or a response
 * shape we no longer understand). It deliberately does not count
 * per-parcel feed glitches (`notFound`) or network blips.
 *
 * Policy: at streak 3 the poller alerts the owner exactly once per
 * episode ("Delhivery endpoint looks broken — pausing") and stops
 * polling that parcel at the 15-min cadence. Each continued failure
 * after a retry escalates the pause:
 *
 *   streak 3 → 1 h pause, streak 4 → 6 h, streak ≥ 5 → 24 h (plateau)
 *
 * The streak only grows while polls actually fail, so a paused parcel
 * retries exactly once per pause, then steps up a tier. A successful
 * poll resets the streak to 0 (repo), which ends the pause and re-arms
 * a fresh streak-3 alert if the endpoint breaks again later.
 *
 * The pause is *derived*, never stored: `last_polled_at + backoffMs(streak)`
 * is the next-eligible-poll time, and both inputs are persisted — so a
 * restart mid-pause resumes the pause exactly.
 */

/** Streak at which the owner is alerted once and backoff begins (PRD §8). */
export const ALERT_STREAK = 3;

export const BACKOFF_ONE_HOUR_MS = 60 * 60 * 1000;
export const BACKOFF_SIX_HOURS_MS = 6 * 60 * 60 * 1000;
export const BACKOFF_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pause for a parcel at the given (post-failure) error streak.
 * 0 means "keep polling at the normal cadence".
 */
export function backoffMs(errorStreak: number): number {
  if (errorStreak < ALERT_STREAK) return 0;
  if (errorStreak === ALERT_STREAK) return BACKOFF_ONE_HOUR_MS;
  if (errorStreak === ALERT_STREAK + 1) return BACKOFF_SIX_HOURS_MS;
  return BACKOFF_DAY_MS;
}
