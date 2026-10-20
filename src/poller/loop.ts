/**
 * Poller loop (PRD §8, §11): polls due parcels through the carrier
 * adapter, persists outcomes through the repo, and emits one structured
 * notification per parcel per poll (M5 formats, M6 sends to Telegram).
 *
 * Cadence (PRD §8):
 * - base `intervalMs` (config `POLL_INTERVAL_MIN`), jittered per poll by
 *   ±`jitter` (default 20%) — every completed poll reschedules its parcel;
 * - at boot, parcels are staggered across one window (parcel i of n is
 *   due at boot + i·interval/n) so a fleet of N never hits the endpoint
 *   at one instant;
 * - a parcel is never polled within one full interval of its last poll
 *   (PRD §9 ToS note) and never before its backoff pause has elapsed
 *   (PRD §8) — both floors derive from persisted state, so restarts
 *   honor them.
 *
 * Concurrency is capped at `maxConcurrent` (default 3) in-flight adapter
 * requests per tick.
 *
 * The loop never throws out: adapter contract violations, emit failures
 * and unexpected worker crashes are logged and the next tick proceeds
 * (PRD §11 done: "no crash loop").
 *
 * Wiring: `emit` is the notification sink. M4 does not start this in
 * main.ts — the sink has nowhere to go until the bot exists; M6 wires
 * `emit` to the Telegram bot and starts the loop (main.ts: db → poller
 * → bot).
 */
import type { Logger } from "pino";
import type {
  CarrierAdapter,
  CarrierEvent,
  CarrierResult,
  TerminalReason,
} from "../carriers/types.js";
import type { DB } from "../db/db.js";
import {
  activePackages,
  getPackage,
  insertEvents,
  recordPoll,
  type PackageRow,
  type PollOutcome,
} from "../db/repo.js";
import { ALERT_STREAK, backoffMs } from "./backoff.js";

/**
 * One thing the owner should be told after a poll (PRD §5/§8).
 * Structured on purpose: M5's format.ts turns these into Telegram text,
 * M6 sends them.
 */
export type PollNotification =
  | {
      /** New events on a successful poll — one bundled message per parcel
       * per poll (a 5-scan backlog is one message, not five, PRD §8). */
      kind: "update";
      pkg: PackageRow;
      events: CarrierEvent[];
    }
  | {
      /** The parcel reached a terminal stage: final message, polling
       * stops (PRD §5, §8). `events` are the new events of this poll. */
      kind: "terminal";
      pkg: PackageRow;
      reason: TerminalReason | null;
      events: CarrierEvent[];
    }
  | {
      /** auth/schema failures hit the alert streak: one alert per
       * episode, then 1 h → 6 h → 24 h backoff (PRD §8, pitfall 6). */
      kind: "endpointBroken";
      awb: string;
      streak: number;
      pauseMs: number;
      lastError: string | null;
    }
  | {
      /** A tracked parcel came back "invalid AWB or very old package" —
       * told once per episode, keep polling (PRD §8). */
      kind: "notFound";
      awb: string;
      message: string;
    };

export interface PollerDeps {
  db: DB;
  adapter: CarrierAdapter;
  /**
   * Notification sink (M6: the Telegram bot). Throwing is tolerated —
   * it is logged, never fatal.
   */
  emit: (n: PollNotification) => void | Promise<void>;
  log: Logger;
}

export interface PollerOptions {
  /** Base cadence in ms (config `pollIntervalMin * 60_000`). */
  intervalMs: number;
  /** Per-poll jitter as a fraction of the interval (default 0.2 = ±20%, PRD §8). */
  jitter?: number;
  /** Max in-flight adapter requests per tick (default 3, PRD §8). */
  maxConcurrent?: number;
  /** Injectable clock (tests). Default `Date.now`. */
  now?: () => number;
  /** Injectable RNG in [0,1) for the jitter (tests). Default `Math.random`. */
  rng?: () => number;
  /** Injectable timers (tests). Defaults to the globals. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
  /**
   * How long to sleep between ticks at most (default 60 s), so parcels
   * added after start (M6 `/track`) are noticed promptly.
   */
  maxCheckDelayMs?: number;
}

export interface Poller {
  /** Start scheduling. Idempotent. */
  start(): void;
  /** Stop the loop (clears the pending timer). Idempotent. */
  stop(): void;
  /** One pass: poll every due parcel. Exposed for tests and manual runs. */
  tick(): Promise<void>;
}

const DEFAULT_JITTER = 0.2;
const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_MAX_CHECK_DELAY_MS = 60_000;

/**
 * Next-poll delay for one parcel: `intervalMs · (1 + u)` with
 * `u ∈ [-jitter, +jitter]` (PRD §8: jitter ±20%).
 */
export function jitteredDelayMs(
  intervalMs: number,
  jitter: number,
  rng: () => number,
): number {
  if (!(intervalMs > 0)) {
    throw new Error(
      `jitteredDelayMs: intervalMs must be positive, got ${intervalMs}`,
    );
  }
  const u = (2 * rng() - 1) * jitter;
  return Math.max(1, Math.round(intervalMs * (1 + u)));
}

export function createPoller(deps: PollerDeps, options: PollerOptions): Poller {
  const { db, adapter, emit, log } = deps;
  const intervalMs = options.intervalMs;
  const jitter = options.jitter ?? DEFAULT_JITTER;
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const maxCheckDelayMs = options.maxCheckDelayMs ?? DEFAULT_MAX_CHECK_DELAY_MS;
  const now = options.now ?? Date.now;
  const rng = options.rng ?? Math.random;
  const setTimer = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimeout ??
    ((id: unknown): void => {
      if (id !== null && id !== undefined) {
        clearTimeout(id as ReturnType<typeof setTimeout>);
      }
    });

  /**
   * Per-parcel next-eligible-poll time (epoch ms). In memory only —
   * re-derived from the DB on start (see `seedAll`), so a restart loses
   * nothing (the floors come from persisted state).
   */
  const nextDueAt = new Map<string, number>();
  let timer: unknown = null;
  let running = false;
  let ticking = false;

  const iso = (ms: number): string => new Date(ms).toISOString();
  const errText = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

  /** Map the carrier's result onto the repo's poll outcome (M3 contract). */
  const toPollOutcome = (result: CarrierResult): PollOutcome => {
    switch (result.kind) {
      case "ok":
        return { ok: true, pkg: result.pkg };
      case "notFound":
        return { ok: false, kind: "notFound", message: result.message };
      case "auth":
        return { ok: false, kind: "auth", message: result.message };
      case "schema":
        return { ok: false, kind: "schema", message: result.message };
      case "network":
        return { ok: false, kind: "network", message: result.message };
    }
  };

  /**
   * Set the next-due time for one parcel relative to a reference `boot`
   * instant and its stagger `slot`:
   * - no last poll yet (freshly added): first poll ≈ one interval later,
   *   jittered — the add-time snapshot is the first message (PRD §8);
   * - otherwise: the later of the stagger slot, `lastPoll + interval`
   *   (PRD §9: ≤ 1 request per parcel per 15 min) and
   *   `lastPoll + backoff` (a pause survives a restart, PRD §8).
   */
  function seed(awb: string, boot: number, slot: number): void {
    const row = getPackage(db, awb);
    if (row === null || row.terminal) {
      nextDueAt.delete(awb);
      return;
    }
    const last = row.lastPolledAt === null ? null : Date.parse(row.lastPolledAt);
    const cadenceFloor = last === null ? 0 : last + intervalMs;
    const pauseFloor = last === null ? 0 : last + backoffMs(row.errorStreak);
    const firstPoll = last === null ? boot + jitteredDelayMs(intervalMs, jitter, rng) : 0;
    nextDueAt.set(awb, Math.max(slot, cadenceFloor, pauseFloor, firstPoll));
  }

  /** Boot-time stagger: spread N parcels across one window (PRD §8). */
  function seedAll(boot: number): void {
    const active = activePackages(db);
    const n = active.length;
    nextDueAt.clear();
    active.forEach((row, i) => {
      const slot = boot + (n > 1 ? Math.round((i / (n - 1)) * intervalMs) : 0);
      seed(row.awb, boot, slot);
    });
  }

  async function safeEmit(n: PollNotification): Promise<void> {
    try {
      await emit(n);
    } catch (err) {
      log.error(
        { kind: n.kind, awb: "awb" in n ? n.awb : n.pkg.awb, err: errText(err) },
        "emit failed — notification dropped",
      );
    }
  }

  /**
   * Poll one parcel end-to-end: adapter → repo → notification →
   * reschedule. Never throws. The poll's logical time is anchored to
   * when it *started* (the tick that found it due), not when the
   * (up-to-15 s) adapter call resolves — so the cadence is measured
   * poll-start to poll-start.
   */
  async function pollOne(awb: string): Promise<void> {
    const t = now();
    const tIso = iso(t);

    const before = getPackage(db, awb);
    if (before === null || before.terminal) {
      nextDueAt.delete(awb);
      return;
    }

    let result: CarrierResult;
    try {
      result = await adapter.track(awb);
    } catch (err) {
      // The adapter contract: it throws only InvalidAwbError (a caller
      // violation — the DB should only hold 13–14 digit AWBs) or on a
      // genuine bug. Log loudly, keep the cadence, do not crash the loop.
      log.error({ awb, err: errText(err) }, "adapter threw outside its contract — poll skipped");
      nextDueAt.set(awb, t + jitteredDelayMs(intervalMs, jitter, rng));
      return;
    }

    switch (result.kind) {
      case "ok": {
        const fresh = insertEvents(db, awb, result.pkg.events, tIso);
        recordPoll(db, awb, toPollOutcome(result), tIso);
        const after = getPackage(db, awb);
        if (after === null) break; // cannot happen in-process; defensive
        if (result.pkg.terminal) {
          log.info(
            { awb, stage: after.currentStage, terminalReason: after.terminalReason },
            "parcel reached terminal state — polling stops",
          );
          await safeEmit({
            kind: "terminal",
            pkg: after,
            reason: after.terminalReason as TerminalReason | null,
            events: fresh,
          });
        } else if (fresh.length > 0) {
          log.debug({ awb, newEvents: fresh.length }, "poll: new events");
          await safeEmit({ kind: "update", pkg: after, events: fresh });
        } else {
          log.debug({ awb, polls: after.polls }, "poll: no changes");
        }
        nextDueAt.set(awb, t + jitteredDelayMs(intervalMs, jitter, rng));
        break;
      }
      case "notFound": {
        recordPoll(db, awb, toPollOutcome(result), tIso);
        // "Tell you once" per episode (PRD §8): only the first notFound
        // after a clean last_error. Consecutive notFounds stay quiet.
        if (before.lastError === null) {
          log.warn({ awb, message: result.message }, "feed reports no such parcel — told once, keeping up polls");
          await safeEmit({ kind: "notFound", awb, message: result.message });
        }
        nextDueAt.set(awb, t + jitteredDelayMs(intervalMs, jitter, rng));
        break;
      }
      case "auth":
      case "schema": {
        recordPoll(db, awb, toPollOutcome(result), tIso);
        const after = getPackage(db, awb);
        if (after === null) break;
        if (after.errorStreak === ALERT_STREAK) {
          // The streak only crosses 3 exactly once (per failure it is
          // +1, per success it resets to 0), so "streak === 3" is
          // "alert exactly once per episode" with no extra state.
          log.error(
            { awb, streak: after.errorStreak, lastError: after.lastError },
            "endpoint looks broken — alerting once, then backing off",
          );
          await safeEmit({
            kind: "endpointBroken",
            awb,
            streak: after.errorStreak,
            pauseMs: backoffMs(after.errorStreak),
            lastError: after.lastError,
          });
        } else {
          log.warn(
            { awb, kind: result.kind, streak: after.errorStreak },
            "poll failed (auth/schema) — below alert streak",
          );
        }
        const pause = backoffMs(after.errorStreak);
        nextDueAt.set(awb, t + (pause > 0 ? pause : jitteredDelayMs(intervalMs, jitter, rng)));
        break;
      }
      case "network": {
        recordPoll(db, awb, toPollOutcome(result), tIso);
        log.debug({ awb, message: result.message }, "poll: network error — silent retry next tick (PRD §8)");
        nextDueAt.set(awb, t + jitteredDelayMs(intervalMs, jitter, rng));
        break;
      }
    }
  }

  /**
   * Run `worker` over `awbs` with at most `maxConcurrent` in flight
   * (PRD §8). A worker crash is logged; the rest of the tick proceeds.
   */
  async function runPool(
    awbs: string[],
    worker: (awb: string) => Promise<void>,
  ): Promise<void> {
    let next = 0;
    const lanes = Math.min(maxConcurrent, awbs.length);
    await Promise.all(
      Array.from({ length: lanes }, async () => {
        for (;;) {
          const idx = next++;
          const awb = idx < awbs.length ? awbs[idx] : undefined;
          if (awb === undefined) return;
          try {
            await worker(awb);
          } catch (err) {
            log.error({ awb, err: errText(err) }, "poll worker crashed — continuing");
          }
        }
      }),
    );
  }

  function scheduleNext(): void {
    if (!running) return;
    clearTimer(timer);
    let minDue = Infinity;
    for (const at of nextDueAt.values()) {
      if (at < minDue) minDue = at;
    }
    // No active parcels → idle-check at the heartbeat (one cheap query).
    // Otherwise wake for the earliest due parcel, but at most
    // `maxCheckDelayMs` out — so parcels added after start (M6 /track)
    // are noticed promptly.
    const delay =
      minDue === Infinity
        ? maxCheckDelayMs
        : Math.max(0, Math.min(minDue - now(), maxCheckDelayMs));
    timer = setTimer(() => {
      void tick();
    }, delay);
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const t = now();
      const active = activePackages(db);
      const activeAwb = new Set(active.map((r) => r.awb));

      // Drop schedules for parcels that are no longer active (terminal,
      // or — M6 — removed).
      for (const awb of [...nextDueAt.keys()]) {
        if (!activeAwb.has(awb)) nextDueAt.delete(awb);
      }

      const due: string[] = [];
      for (const row of active) {
        const at = nextDueAt.get(row.awb);
        if (at === undefined) {
          // Added after start (M6 /track path): seed it — first poll ≈
          // one interval away (see `seed`).
          seed(row.awb, t, t);
          continue;
        }
        if (at <= t) due.push(row.awb);
      }

      if (due.length > 0) {
        log.debug({ due: due.length, adapter: adapter.name }, "polling due parcels");
        await runPool(due, pollOne);
      }
    } finally {
      ticking = false;
      scheduleNext();
    }
  }

  function start(): void {
    if (running) return;
    running = true;
    seedAll(now());
    log.info(
      { parcels: nextDueAt.size, intervalMs, jitter, maxConcurrent, adapter: adapter.name },
      "poller started",
    );
    scheduleNext();
  }

  function stop(): void {
    if (!running) return;
    running = false;
    clearTimer(timer);
    timer = null;
    log.info("poller stopped");
  }

  return { start, stop, tick };
}
