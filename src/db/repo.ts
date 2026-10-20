/**
 * Repository over the PRD §7 schema. Carrier-agnostic: everything comes
 * in as `CarrierPackage`/`CarrierEvent` (src/carriers/types.ts), so a
 * future carrier needs no changes here.
 *
 * Conventions:
 * - All timestamps are UTC ISO strings; `now` is injected by the caller
 *   so tests stay deterministic.
 * - Single-process by design (PRD §6): no locking beyond SQLite's own.
 */
import type {
  CarrierEvent,
  CarrierPackage,
  Leg,
  Stage,
} from "../carriers/types.js";
import type { DB } from "./db.js";

// ---------------------------------------------------------------------------
// Row shapes (camelCase outward, snake_case inward)
// ---------------------------------------------------------------------------

/** `packages` row as stored. */
interface PackageDbRow {
  awb: string;
  added_at: string;
  source_link: string | null;
  dest_city: string | null;
  reference_no: string | null;
  product_type: string | null;
  current_stage: string | null;
  status_text: string | null;
  status_at: string | null;
  delivery_eta: string | null;
  terminal: number;
  terminal_reason: string | null;
  polls: number;
  last_polled_at: string | null;
  last_error: string | null;
  error_streak: number;
}

/** `events` row as stored. */
interface EventDbRow {
  id: number;
  awb: string;
  occurred_at: string | null;
  description: string;
  location: string | null;
  stage: string | null;
  leg: string;
  is_summary: number;
  first_seen_at: string;
}

/** A tracked parcel (PRD §7 `packages`). */
export interface PackageRow {
  awb: string;
  addedAt: string;
  sourceLink: string | null;
  destCity: string | null;
  referenceNo: string | null;
  productType: string | null;
  currentStage: Stage | null;
  statusText: string | null;
  statusAt: string | null;
  /** Raw ETA prose, never parsed (PRD §9). */
  deliveryEta: string | null;
  /** 1 = delivered/returned/exception: excluded from polling (PRD §8). */
  terminal: boolean;
  terminalReason: string | null;
  polls: number;
  lastPolledAt: string | null;
  lastError: string | null;
  errorStreak: number;
}

/** A stored event (PRD §7 `events`). */
export interface EventRow {
  id: number;
  awb: string;
  /** UTC ISO, or null when the feed gave no parseable time. */
  occurredAt: string | null;
  description: string;
  location: string | null;
  stage: Stage | null;
  leg: Leg;
  /** True for the current-status snapshot, false for scans. */
  isSummary: boolean;
  /** When this event first appeared to us (UTC ISO). */
  firstSeenAt: string;
}

function mapPackageRow(r: PackageDbRow): PackageRow {
  return {
    awb: r.awb,
    addedAt: r.added_at,
    sourceLink: r.source_link,
    destCity: r.dest_city,
    referenceNo: r.reference_no,
    productType: r.product_type,
    currentStage: (r.current_stage ?? null) as Stage | null,
    statusText: r.status_text,
    statusAt: r.status_at,
    deliveryEta: r.delivery_eta,
    terminal: r.terminal === 1,
    terminalReason: r.terminal_reason,
    polls: r.polls,
    lastPolledAt: r.last_polled_at,
    lastError: r.last_error,
    errorStreak: r.error_streak,
  };
}

function mapEventRow(r: EventDbRow): EventRow {
  return {
    id: r.id,
    awb: r.awb,
    occurredAt: r.occurred_at,
    description: r.description,
    location: r.location,
    stage: (r.stage ?? null) as Stage | null,
    leg: r.leg as Leg,
    isSummary: r.is_summary === 1,
    firstSeenAt: r.first_seen_at,
  };
}

// ---------------------------------------------------------------------------
// packages
// ---------------------------------------------------------------------------

/**
 * Start tracking a parcel (the M6 `/track` path): inserts the package with
 * its first snapshot. When the package is newly created, add-time events
 * from the snapshot are also persisted in the same transaction (idempotent
 * via the events dedupe index). If the AWB already exists, this is a no-op
 * and returns false (PRD §8). A subsequent `insertEvents` call with the same
 * payload returns 0 new events. `now` (UTC ISO) is the add time.
 */
export function addPackage(
  db: DB,
  pkg: CarrierPackage,
  sourceLink: string | null,
  now: string,
): boolean {
  if (getPackage(db, pkg.awb) !== null) return false;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO packages (
         awb, added_at, source_link, dest_city, reference_no, product_type,
         current_stage, status_text, status_at, delivery_eta,
         terminal, terminal_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      pkg.awb,
      now,
      sourceLink,
      pkg.destCity,
      pkg.referenceNo,
      pkg.productType,
      pkg.stage,
      pkg.statusText,
      pkg.statusAt,
      pkg.deliveryEta,
      pkg.terminal ? 1 : 0,
      pkg.terminal ? pkg.terminalReason : null,
    );

    insertEvents(db, pkg.awb, pkg.events, now);
  });
  tx();
  return true;
}

/** Fetch one tracked parcel, or null when not tracked. */
export function getPackage(db: DB, awb: string): PackageRow | null {
  const row = db
    .prepare("SELECT * FROM packages WHERE awb = ?")
    .get(awb) as PackageDbRow | undefined;
  return row === undefined ? null : mapPackageRow(row);
}

/**
 * Every tracked parcel, active first and terminal at the bottom
 * (PRD §5 `/list`), newest additions first within each group.
 */
export function listPackages(db: DB): PackageRow[] {
  const rows = db
    .prepare(
      "SELECT * FROM packages ORDER BY terminal ASC, added_at DESC, awb ASC",
    )
    .all() as PackageDbRow[];
  return rows.map(mapPackageRow);
}

/** Parcels the M4 poller should still poll (terminal ones excluded). */
export function activePackages(db: DB): PackageRow[] {
  const rows = db
    .prepare(
      "SELECT * FROM packages WHERE terminal = 0 ORDER BY added_at DESC, awb ASC",
    )
    .all() as PackageDbRow[];
  return rows.map(mapPackageRow);
}

/**
 * Failure kinds for poll outcomes, as consumed by M4 backoff/alerting.
 */
export type PollFailureKind = "notFound" | "auth" | "schema" | "network";

/** Outcome of one poll: the fresh snapshot (`ok`) or why it failed. */
export type PollOutcome =
  | { ok: true; pkg: CarrierPackage }
  | { ok: false; kind: PollFailureKind; message: string };

/**
 * Record one poll for a tracked parcel (`now` = UTC ISO):
 * - success: refresh the snapshot columns, increment `polls`, reset
 *   `error_streak`/`last_error`, and apply terminal state when the stage is
 *   terminal (PRD §8). Companion call: events are NOT inserted here — M4
 *   calls `insertEvents` with the fresh payload separately;
 * - failure:
 *   - notFound: set `last_error`, do NOT increment `error_streak` (PRD §8:
 *     possible feed glitch, tell once/mark and keep polling)
 *   - auth/schema: set `last_error`, increment `error_streak` (M4 consumes
 *     the streak for alerts/backoff)
 *   - network: poll accounting only — increment `polls`, set
 *     `last_polled_at`, leave `last_error` and `error_streak` untouched
 *     (PRD §8: silent — no alert, retried on the next scheduled poll)
 */
export function recordPoll(
  db: DB,
  awb: string,
  outcome: PollOutcome,
  now: string,
): void {
  if (outcome.ok) {
    const { pkg } = outcome;
    db.prepare(
      `UPDATE packages SET
         current_stage   = ?,
         status_text     = ?,
         status_at       = ?,
         delivery_eta    = ?,
         dest_city       = ?,
         reference_no    = ?,
         product_type    = ?,
         terminal        = ?,
         terminal_reason = ?,
         polls           = polls + 1,
         last_polled_at  = ?,
         last_error      = NULL,
         error_streak    = 0
       WHERE awb = ?`,
    ).run(
      pkg.stage,
      pkg.statusText,
      pkg.statusAt,
      pkg.deliveryEta,
      pkg.destCity,
      pkg.referenceNo,
      pkg.productType,
      pkg.terminal ? 1 : 0,
      pkg.terminal ? pkg.terminalReason : null,
      now,
      awb,
    );
    return;
  }

  if (outcome.kind === "network") {
    db.prepare(
      `UPDATE packages SET
         polls          = polls + 1,
         last_polled_at = ?
       WHERE awb = ?`,
    ).run(now, awb);
    return;
  }

  if (outcome.kind === "notFound") {
    db.prepare(
      `UPDATE packages SET
         polls          = polls + 1,
         last_polled_at = ?,
         last_error     = ?
       WHERE awb = ?`,
    ).run(now, outcome.message, awb);
    return;
  }

  // auth or schema
  db.prepare(
    `UPDATE packages SET
       polls          = polls + 1,
       last_polled_at = ?,
       last_error     = ?,
       error_streak   = error_streak + 1
     WHERE awb = ?`,
  ).run(now, outcome.message, awb);
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

/**
 * Store feed events for a parcel, skipping the ones already present.
 *
 * The cross-poll dedupe key is (awb, description, occurred_at, location,
 * leg) with NULLs coalesced — enforced by the `uq_events_dedupe` index in
 * schema.sql (plain UNIQUE treats NULLs as distinct, which would re-diff
 * every undated scan on each poll; M2 flagged this).
 *
 * Returns the events that were actually NEW, in input order. That is the
 * PRD §7 diff ("events present in the fresh parse but not yet in the
 * table") — M5 bundles the returned events into the one notification
 * message per parcel per poll. `now` (UTC ISO) is stamped into
 * `first_seen_at`.
 *
 * @throws {Error} when `awb` is not a tracked parcel (FK would otherwise
 *   be silently swallowed by INSERT OR IGNORE).
 */
export function insertEvents(
  db: DB,
  awb: string,
  events: readonly CarrierEvent[],
  now: string,
): CarrierEvent[] {
  if (getPackage(db, awb) === null) {
    throw new Error(`insertEvents: ${awb} is not a tracked parcel — add it first`);
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO events (
       awb, occurred_at, description, location, stage, leg, is_summary, first_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const fresh: CarrierEvent[] = [];
  const tx = db.transaction(() => {
    for (const ev of events) {
      const info = insert.run(
        awb,
        ev.occurredAt,
        ev.description,
        ev.location,
        ev.stage,
        ev.leg,
        ev.isSummary ? 1 : 0,
        now,
      );
      if (info.changes === 1) fresh.push(ev);
    }
  });
  tx();
  return fresh;
}

/**
 * Stored events for one parcel, in the order we first saw them
 * (`first_seen_at`, ties by insertion order). The anonymous feed is
 * shallow — dates appear and order can drift, so first-seen order is the
 * stable, notification-faithful timeline (PRD §4.3 pitfall 4).
 */
export function eventsForAwb(db: DB, awb: string): EventRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM events WHERE awb = ? ORDER BY first_seen_at ASC, id ASC`,
    )
    .all(awb) as EventDbRow[];
  return rows.map(mapEventRow);
}
