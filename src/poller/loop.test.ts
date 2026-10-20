import pino from "pino";
import { describe, expect, it } from "vitest";
import type {
  CarrierAdapter,
  CarrierEvent,
  CarrierPackage,
  CarrierResult,
} from "../carriers/types.js";
import { openDb, type DB } from "../db/db.js";
import { activePackages, addPackage, getPackage, recordPoll, type PollOutcome } from "../db/repo.js";
import {
  ALERT_STREAK,
  BACKOFF_DAY_MS,
  BACKOFF_ONE_HOUR_MS,
  backoffMs,
} from "./backoff.js";
import {
  createPoller,
  jitteredDelayMs,
  type PollNotification,
  type Poller,
} from "./loop.js";

// ---------------------------------------------------------------------------
// Fixtures & fakes
// ---------------------------------------------------------------------------

const AWB = "55540110035405";
const AWB_B = "55540110035406";
const AWB_C = "55540110035407";

const MIN = 60_000;
const HOUR = 3_600_000;
const INTERVAL = 15 * MIN;
const BOOT = Date.parse("2026-10-20T10:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

/** Deterministic zero-jitter RNG (0.5 → u = 0). */
const NO_JITTER = (): number => 0.5;

/** Fake clock with fake timers. Timers only fire via `flushDue`/`advance`. */
class Clock {
  private t: number;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start: number) {
    this.t = start;
  }

  get nowMs(): number {
    return this.t;
  }

  now = (): number => this.t;

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };

  clearTimeout = (id: unknown): void => {
    if (typeof id === "number") this.timers.delete(id);
  };

  /** Fire pending timers that are already due (real setTimeout(0) semantics). */
  flushDue(): number {
    let fired = 0;
    for (;;) {
      const key = this.dueKey();
      if (key === null) break;
      const entry = this.timers.get(key)!;
      this.timers.delete(key);
      fired += 1;
      entry.fn();
    }
    return fired;
  }

  /** Advance to +ms, firing timers that come due along the way (time order). */
  advance(ms: number): number {
    const target = this.t + ms;
    let fired = 0;
    for (;;) {
      let key: number | null = null;
      let at = Infinity;
      for (const [k, v] of this.timers) {
        if (v.at <= target && v.at < at) {
          at = v.at;
          key = k;
        }
      }
      if (key === null) break;
      this.t = Math.max(this.t, at);
      const entry = this.timers.get(key)!;
      this.timers.delete(key);
      fired += 1;
      entry.fn();
    }
    this.t = target;
    return fired;
  }

  pending(): number {
    return this.timers.size;
  }

  /** Earliest pending timer time, or null when nothing is scheduled. */
  nextAt(): number | null {
    let at: number | null = null;
    for (const v of this.timers.values()) {
      if (at === null || v.at < at) at = v.at;
    }
    return at;
  }

  private dueKey(): number | null {
    let key: number | null = null;
    let at = Infinity;
    for (const [k, v] of this.timers) {
      if (v.at <= this.t && v.at < at) {
        at = v.at;
        key = k;
      }
    }
    return key;
  }
}

/**
 * Pump the real microtask/macrotask queue, fire due fake timers, and —
 * if the condition is still unmet and time is the only thing standing in
 * the way — advance the clock to the next pending timer (real "time
 * passes" semantics). Timer-driven ticks are fire-and-forget
 * (`void tick()`), so tests must drain the loop before asserting.
 */
async function settle(clock: Clock, until: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    clock.flushDue();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (until()) return;
    const next = clock.nextAt();
    if (next !== null && next > clock.nowMs) {
      clock.advance(next - clock.nowMs);
    }
  }
  throw new Error("settle: condition not reached within 500 iterations");
}

/**
 * Fake adapter: per-AWB result queue (the last queued result repeats),
 * call-order recording, and max-in-flight accounting. An unqueued AWB
 * makes `track` reject — the "adapter threw outside its contract" path.
 */
function fakeAdapter(): {
  adapter: CarrierAdapter;
  calls: string[];
  maxInFlight: () => number;
  queue: (awb: string, ...results: CarrierResult[]) => void;
} {
  const queues = new Map<string, CarrierResult[]>();
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  return {
    adapter: {
      name: "fake",
      track(awb: string): Promise<CarrierResult> {
        calls.push(awb);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const q = queues.get(awb);
        let result: CarrierResult | undefined;
        if (q !== undefined) {
          if (q.length > 1) result = q.shift();
          else if (q.length === 1) result = q[0];
        }
        return new Promise<CarrierResult>((resolve, reject) => {
          // Resolve on a macrotask so all pool lanes can grab a slot
          // first (what the concurrency assertions rely on).
          setImmediate(() => {
            inFlight -= 1;
            if (result === undefined) {
              reject(new Error(`fakeAdapter: no result queued for ${awb}`));
            } else {
              resolve(result);
            }
          });
        });
      },
    },
    calls,
    maxInFlight: () => maxInFlight,
    queue(awb: string, ...results: CarrierResult[]): void {
      queues.set(awb, [...results]);
    },
  };
}

const ok = (p: CarrierPackage): CarrierResult => ({ kind: "ok", pkg: p });

function pkg(awb: string, over: Partial<CarrierPackage> = {}): CarrierPackage {
  return {
    awb,
    stage: "in_transit",
    statusText: "Shipment picked up",
    statusAt: "2026-10-19T15:37:44.000Z",
    deliveryEta: "26 Oct 2026, Evening",
    destCity: "Bangalore",
    referenceNo: "GNPC17375",
    productType: "B2C",
    leg: "forward",
    terminal: false,
    terminalReason: null,
    events: [],
    ...over,
  };
}

function ev(over: Partial<CarrierEvent> = {}): CarrierEvent {
  return {
    occurredAt: "2026-10-19T15:37:44.000Z",
    description: "In Transit",
    location: "Delhi_Airport_GW (Delhi)",
    stage: "in_transit",
    leg: "forward",
    isSummary: false,
    ...over,
  };
}

interface Harness {
  clock: Clock;
  db: DB;
  fake: ReturnType<typeof fakeAdapter>;
  emitted: PollNotification[];
  poller: Poller;
}

function makeHarness(
  opts: {
    rng?: () => number;
    intervalMs?: number;
    maxConcurrent?: number;
    emit?: (n: PollNotification) => void | Promise<void>;
  } = {},
): Harness {
  const clock = new Clock(BOOT);
  const db = openDb(":memory:");
  const fake = fakeAdapter();
  const emitted: PollNotification[] = [];
  const poller = createPoller(
    {
      db,
      adapter: fake.adapter,
      emit: opts.emit ?? ((n: PollNotification): void => {
        emitted.push(n);
      }),
      log: pino({ level: "silent" }),
    },
    {
      intervalMs: opts.intervalMs ?? INTERVAL,
      rng: opts.rng ?? NO_JITTER,
      maxConcurrent: opts.maxConcurrent ?? 3,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
  );
  return { clock, db, fake, emitted, poller };
}

/** Track a parcel in the DB (the M6 `/track` path, minus the fetch). */
function track(
  h: Harness,
  awb: string,
  over: Partial<CarrierPackage> = {},
  at: number = BOOT,
): void {
  if (!addPackage(h.db, pkg(awb, over), null, iso(at))) {
    throw new Error("test setup: package should have been created");
  }
}

// ---------------------------------------------------------------------------
// jitteredDelayMs
// ---------------------------------------------------------------------------

describe("jitteredDelayMs (PRD §8: jitter ±20%)", () => {
  it("maps rng 0 → -jitter, 0.5 → no jitter, 1 → +jitter", () => {
    expect(jitteredDelayMs(INTERVAL, 0.2, () => 0)).toBe(12 * MIN);
    expect(jitteredDelayMs(INTERVAL, 0.2, () => 0.5)).toBe(15 * MIN);
    expect(jitteredDelayMs(INTERVAL, 0.2, () => 1)).toBe(18 * MIN);
  });

  it("keeps interior rng values inside the band", () => {
    for (const r of [0.1, 0.3, 0.7, 0.9]) {
      const d = jitteredDelayMs(INTERVAL, 0.2, () => r);
      expect(d).toBeGreaterThanOrEqual(12 * MIN);
      expect(d).toBeLessThanOrEqual(18 * MIN);
    }
  });

  it("rejects a non-positive interval", () => {
    expect(() => jitteredDelayMs(0, 0.2, NO_JITTER)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Scheduling: stagger, cadence floor, restart semantics
// ---------------------------------------------------------------------------

describe("scheduling (PRD §8 stagger + PRD §9 cadence floor)", () => {
  it("fresh parcel: first poll ≈ one interval after start, then every interval", async () => {
    const h = makeHarness();
    const { clock, poller, fake, emitted, db } = h;
    try {
      track(h, AWB);
      fake.queue(AWB, ok(pkg(AWB, { events: [ev()] })));

      poller.start();
      clock.advance(14 * MIN);
      await settle(clock, () => true); // drain any (unexpected) early work
      expect(fake.calls).toEqual([]);
      expect(emitted).toHaveLength(0);

      clock.advance(MIN); // BOOT + 15 min
      await settle(clock, () => fake.calls.length === 1);
      expect(fake.calls).toEqual([AWB]);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ kind: "update", pkg: { awb: AWB } });

      clock.advance(15 * MIN); // BOOT + 30 min
      await settle(clock, () => fake.calls.length === 2);
      // Same payload, no new events → still exactly one notification.
      expect(emitted).toHaveLength(1);
      expect(getPackage(db, AWB)!.polls).toBe(2);
    } finally {
      poller.stop();
      db.close();
    }
  });

  it("boots a fleet staggered across one window (parcel i of n due at boot + i·interval/(n−1))", async () => {
    const h = makeHarness();
    const { clock, poller, fake } = h;
    try {
      for (const awb of [AWB, AWB_B, AWB_C]) {
        track(h, awb, {}, BOOT - 3 * HOUR);
        recordPoll(h.db, awb, { ok: true, pkg: pkg(awb) }, iso(BOOT - 2 * HOUR));
      }
      for (const awb of [AWB, AWB_B, AWB_C]) fake.queue(awb, ok(pkg(awb)));

      poller.start(); // BOOT
      await settle(clock, () => fake.calls.length === 1);
      expect(fake.calls).toEqual([AWB]); // i=0 → slot boot → immediately due

      clock.advance(7.5 * MIN);
      await settle(clock, () => fake.calls.length === 2);
      expect(fake.calls).toEqual([AWB, AWB_B]);

      // BOOT + 15 min: AWB (second poll, rescheduled from BOOT) and
      // AWB_C (first poll, slot boot + 15 min) are due together —
      // with real ±20% jitter they would be apart.
      clock.advance(7.5 * MIN);
      await settle(clock, () => fake.calls.length === 4);
      expect(fake.calls).toEqual([AWB, AWB_B, AWB, AWB_C]);

      // AWB_B was polled at 7.5 min → not due again before 22.5 min.
      clock.advance(5 * MIN);
      await settle(clock, () => true);
      expect(fake.calls).toHaveLength(4);
    } finally {
      poller.stop();
      h.db.close();
    }
  });

  it("a restart never polls within one interval of the last poll (PRD §9)", async () => {
    const h = makeHarness();
    const { clock, poller, fake } = h;
    try {
      track(h, AWB, {}, BOOT - 2 * HOUR);
      recordPoll(h.db, AWB, { ok: true, pkg: pkg(AWB) }, iso(BOOT - MIN)); // last poll 1 min before "restart"
      fake.queue(AWB, ok(pkg(AWB)));

      poller.start(); // "restart" at BOOT
      clock.advance(10 * MIN);
      await settle(clock, () => true);
      expect(fake.calls).toEqual([]); // floor is BOOT + 14 min

      clock.advance(4 * MIN); // BOOT + 14 min
      await settle(clock, () => fake.calls.length === 1);
      expect(fake.calls).toEqual([AWB]);
    } finally {
      poller.stop();
      h.db.close();
    }
  });

  it("floors steady-state reschedules at one interval when rng draws negative jitter (PRD §9)", async () => {
    const h = makeHarness({ rng: () => 0 }); // raw draw = 12 min — an unfloored reschedule would poll there
    const { clock, poller, fake, db } = h;
    try {
      track(h, AWB, {}, BOOT - HOUR);
      recordPoll(h.db, AWB, { ok: true, pkg: pkg(AWB) }, iso(BOOT - HOUR));
      fake.queue(AWB, ok(pkg(AWB)), ok(pkg(AWB)));

      poller.start(); // cadence floor already elapsed → due at BOOT
      await settle(clock, () => fake.calls.length === 1);
      const firstPollStart = clock.nowMs;

      clock.advance(12 * MIN); // raw jittered delay would fall due here
      await settle(clock, () => true);
      expect(fake.calls).toHaveLength(1);

      clock.advance(3 * MIN); // firstPollStart + intervalMs
      await settle(clock, () => fake.calls.length === 2);
      expect(clock.nowMs - firstPollStart).toBeGreaterThanOrEqual(INTERVAL);
    } finally {
      poller.stop();
      db.close();
    }
  });

  it("a parcel in backoff stays paused across a restart (derived from last_polled_at + streak)", async () => {
    const h = makeHarness();
    const { clock, poller, fake, emitted, db } = h;
    try {
      track(h, AWB, {}, BOOT - 2 * HOUR);
      const authFail: PollOutcome = { ok: false, kind: "auth", message: "401" };
      recordPoll(h.db, AWB, authFail, iso(BOOT - 45 * MIN));
      recordPoll(h.db, AWB, authFail, iso(BOOT - 30 * MIN));
      recordPoll(h.db, AWB, authFail, iso(BOOT - 15 * MIN));
      expect(getPackage(db, AWB)!.errorStreak).toBe(3);
      fake.queue(AWB, { kind: "auth", message: "401" }); // still failing

      poller.start(); // "restart" at BOOT — pause floor = BOOT − 15 min + 1 h
      clock.advance(30 * MIN);
      await settle(clock, () => true);
      expect(fake.calls).toEqual([]); // still inside the 1 h pause

      clock.advance(15 * MIN); // BOOT + 45 min = pause end
      await settle(clock, () => fake.calls.length === 1);
      expect(getPackage(db, AWB)!.errorStreak).toBe(4);
      expect(emitted).toHaveLength(0); // no re-alert: the streak-3 alert belongs to the previous run
      expect(backoffMs(4)).toBe(6 * HOUR); // next pause tier

      clock.advance(3 * HOUR); // half of the 6 h pause
      await settle(clock, () => true);
      expect(fake.calls).toHaveLength(1);
    } finally {
      poller.stop();
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Notifications (PRD §5/§8)
// ---------------------------------------------------------------------------

describe("notifications (PRD §5/§8)", () => {
  it("terminal: one terminal notification with the new events; polling stops", async () => {
    const h = makeHarness();
    const { clock, poller, fake, emitted, db } = h;
    try {
      track(h, AWB);
      fake.queue(
        AWB,
        ok(
          pkg(AWB, {
            stage: "delivered",
            statusText: "Delivered",
            statusAt: "2026-10-20T08:15:00.000Z",
            terminal: true,
            terminalReason: "delivered",
            events: [ev({ description: "Delivered", stage: "delivered", location: "Bangalore Hub" })],
          }),
        ),
      );

      poller.start();
      clock.advance(15 * MIN);
      await settle(clock, () => fake.calls.length === 1);

      const n = emitted[0];
      expect(emitted).toHaveLength(1);
      expect(n).toMatchObject({
        kind: "terminal",
        reason: "delivered",
        pkg: { awb: AWB, terminal: true, terminalReason: "delivered" },
      });
      if (n?.kind === "terminal") expect(n.events).toHaveLength(1);
      expect(getPackage(db, AWB)!.terminal).toBe(true);
      expect(activePackages(db)).toHaveLength(0);

      clock.advance(45 * MIN);
      await settle(clock, () => true);
      expect(fake.calls).toHaveLength(1); // excluded from polling
    } finally {
      poller.stop();
      db.close();
    }
  });

  it("notFound: told once per episode, keeps polling, no streak", async () => {
    const h = makeHarness();
    const { clock, poller, fake, emitted, db } = h;
    try {
      track(h, AWB);
      const notFound = (): CarrierResult => ({
        kind: "notFound",
        message: "invalid AWB or very old package",
      });
      // polls 1..5: ok, notFound, notFound, ok, notFound
      fake.queue(AWB, ok(pkg(AWB)), notFound(), notFound(), ok(pkg(AWB)), notFound());

      poller.start();
      clock.advance(75 * MIN); // polls at 15, 30, 45, 60, 75
      await settle(clock, () => fake.calls.length === 5);

      const tells = emitted.filter((n) => n.kind === "notFound");
      expect(tells).toHaveLength(2);
      for (const n of tells) {
        if (n.kind === "notFound") {
          expect(n).toMatchObject({
            awb: AWB,
            message: "invalid AWB or very old package",
          });
        }
      }
      const row = getPackage(db, AWB)!;
      expect(row.errorStreak).toBe(0);
      expect(row.lastError).toBe("invalid AWB or very old package");
      expect(row.polls).toBe(5);
    } finally {
      poller.stop();
      db.close();
    }
  });

  it("network failure: silent, no error marked, cadence continues", async () => {
    const h = makeHarness();
    const { clock, poller, fake, emitted, db } = h;
    try {
      track(h, AWB);
      fake.queue(AWB, { kind: "network", message: "timeout" }, ok(pkg(AWB)));

      poller.start();
      clock.advance(30 * MIN);
      await settle(clock, () => fake.calls.length === 2);

      expect(emitted).toHaveLength(0);
      const row = getPackage(db, AWB)!;
      expect(row.polls).toBe(2);
      expect(row.lastError).toBeNull();
      expect(row.errorStreak).toBe(0);
      expect(row.lastPolledAt).toBe(iso(BOOT + 30 * MIN));
    } finally {
      poller.stop();
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Error streak, alert and backoff (PRD §8; test plan §12.4)
// ---------------------------------------------------------------------------

describe("error streak, alert and backoff (PRD §8; test plan §12.4)", () => {
  it("alerts exactly once at streak 3, then pauses 1 h → 6 h → 24 h per continued failure", async () => {
    const h = makeHarness();
    const { clock, poller, fake, emitted, db } = h;
    try {
      track(h, AWB);
      fake.queue(AWB, { kind: "auth", message: "HTTP 401 (front door changed?)" }); // repeats

      poller.start();
      clock.advance(45 * MIN); // polls at 15, 30, 45
      await settle(clock, () => fake.calls.length === 3);

      const alerts = emitted.filter((n) => n.kind === "endpointBroken");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        kind: "endpointBroken",
        awb: AWB,
        streak: ALERT_STREAK,
        pauseMs: BACKOFF_ONE_HOUR_MS,
      });
      expect(getPackage(db, AWB)!.errorStreak).toBe(3);

      // 1 h pause: no 4th poll before BOOT + 45 min + 1 h
      clock.advance(60 * MIN - 1); // → BOOT + 104 min
      await settle(clock, () => true);
      expect(fake.calls).toHaveLength(3);

      // BOOT + 105 min: retry → streak 4, no second alert
      clock.advance(1);
      await settle(clock, () => fake.calls.length === 4);
      expect(emitted.filter((n) => n.kind === "endpointBroken")).toHaveLength(1);
      expect(getPackage(db, AWB)!.errorStreak).toBe(4);

      // 6 h pause → streak 5 at BOOT + 105 min + 6 h
      clock.advance(6 * HOUR - 1);
      await settle(clock, () => true);
      expect(fake.calls).toHaveLength(4);
      clock.advance(1);
      await settle(clock, () => fake.calls.length === 5);
      expect(getPackage(db, AWB)!.errorStreak).toBe(5);
      expect(backoffMs(5)).toBe(BACKOFF_DAY_MS); // 24 h plateau next
      expect(emitted.filter((n) => n.kind === "endpointBroken")).toHaveLength(1);
    } finally {
      poller.stop();
      db.close();
    }
  });

  it("a success resets the streak and ends the pause; a later break re-arms a fresh alert", async () => {
    const h = makeHarness();
    const { clock, poller, fake, emitted, db } = h;
    try {
      track(h, AWB);
      const auth = (): CarrierResult => ({ kind: "auth", message: "401" });
      fake.queue(AWB, auth(), auth(), auth(), ok(pkg(AWB))); // 3 fails, then recovery

      poller.start();
      clock.advance(45 * MIN); // fails at 15, 30, 45 → alert at 45
      await settle(clock, () => fake.calls.length === 3);
      expect(emitted.filter((n) => n.kind === "endpointBroken")).toHaveLength(1);

      // 1 h pause, then recovery at BOOT + 105 min
      clock.advance(60 * MIN);
      await settle(clock, () => fake.calls.length === 4);
      const row = getPackage(db, AWB)!;
      expect(row.errorStreak).toBe(0);
      expect(row.lastError).toBeNull();

      // Still broken afterwards → new episode → fresh alert at the next streak 3
      fake.queue(AWB, auth()); // replace the repeat with auth
      clock.advance(45 * MIN); // polls at 120, 135, 150
      await settle(clock, () => fake.calls.length === 7);
      expect(emitted.filter((n) => n.kind === "endpointBroken")).toHaveLength(2);
      expect(getPackage(db, AWB)!.errorStreak).toBe(3);
    } finally {
      poller.stop();
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrency (PRD §8: ≤ 3 in flight)
// ---------------------------------------------------------------------------

describe("concurrency (PRD §8: ≤ 3 in flight)", () => {
  it("caps in-flight requests at 3 by default", async () => {
    const h = makeHarness();
    const { clock, poller, fake, db } = h;
    try {
      const awbs = Array.from({ length: 5 }, (_, i) => `555401100354${10 + i}`);
      for (const awb of awbs) {
        track(h, awb); // never polled → all seeded due at BOOT + 15 min
        fake.queue(awb, ok(pkg(awb)));
      }

      await poller.tick(); // seeds everything (no start)
      expect(fake.calls).toHaveLength(0);
      clock.advance(15 * MIN);
      await poller.tick(); // all five due at once
      expect(fake.calls).toHaveLength(5);
      expect(fake.maxInFlight()).toBe(3);
    } finally {
      db.close();
    }
  });

  it("honours an explicit maxConcurrent", async () => {
    const h = makeHarness({ maxConcurrent: 2 });
    const { clock, poller, fake, db } = h;
    try {
      const awbs = Array.from({ length: 4 }, (_, i) => `555401100354${20 + i}`);
      for (const awb of awbs) {
        track(h, awb);
        fake.queue(awb, ok(pkg(awb)));
      }

      await poller.tick();
      clock.advance(15 * MIN);
      await poller.tick();
      expect(fake.calls).toHaveLength(4);
      expect(fake.maxInFlight()).toBe(2);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Resilience (PRD §11 done: no crash loop) & lifecycle
// ---------------------------------------------------------------------------

describe("resilience and lifecycle (PRD §11 done: no crash loop)", () => {
  it("an emit failure is swallowed; the loop and cadence continue", async () => {
    let emits = 0;
    const h = makeHarness({
      emit: () => {
        emits += 1;
        throw new Error("telegram down");
      },
    });
    const { clock, poller, fake, db } = h;
    try {
      track(h, AWB);
      fake.queue(AWB, ok(pkg(AWB, { events: [ev()] })));

      poller.start();
      clock.advance(15 * MIN);
      await settle(clock, () => fake.calls.length === 1);
      expect(emits).toBe(1); // attempted, then dropped
      expect(getPackage(db, AWB)!.polls).toBe(1); // still recorded

      // Next cycle still happens (reschedule intact).
      fake.queue(AWB, ok(pkg(AWB, { events: [ev({ description: "Second scan" })] })));
      clock.advance(15 * MIN);
      await settle(clock, () => fake.calls.length === 2);
      expect(emits).toBe(2);
    } finally {
      poller.stop();
      db.close();
    }
  });

  it("an adapter throw (contract violation) is logged, not fatal", async () => {
    const h = makeHarness();
    const { clock, poller, fake, emitted, db } = h;
    try {
      track(h, AWB);
      // Nothing queued → the fake adapter rejects (InvalidAwbError-style throw).

      poller.start();
      clock.advance(15 * MIN);
      await settle(clock, () => fake.calls.length === 1);
      expect(emitted).toHaveLength(0);
      expect(getPackage(db, AWB)!.polls).toBe(0); // not recorded

      clock.advance(15 * MIN);
      await settle(clock, () => fake.calls.length === 2); // cadence continues
      expect(getPackage(db, AWB)!.polls).toBe(0);
    } finally {
      poller.stop();
      db.close();
    }
  });

  it("start() schedules, start() again is a no-op, stop() clears the timer", () => {
    const h = makeHarness();
    const { clock, poller } = h;
    try {
      track(h, AWB);
      expect(clock.pending()).toBe(0);
      poller.start();
      expect(clock.pending()).toBe(1);
      poller.start();
      expect(clock.pending()).toBe(1); // idempotent
      poller.stop();
      expect(clock.pending()).toBe(0);
    } finally {
      h.db.close();
    }
  });
});
