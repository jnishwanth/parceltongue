/**
 * Carrier-agnostic contracts (PRD §6, §11).
 *
 * Everything carrier-specific lives under `carriers/<name>/` and is consumed
 * only through `CarrierAdapter`. A future carrier = a new folder
 * implementing this interface, nothing else changes (AGENTS.md).
 */

/** Normalized lifecycle stage (PRD §4.4, §7 `current_stage`). */
export type Stage =
  | "registered"
  | "accepted"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "returned"
  | "exception"
  | "unknown";

/** Leg of the journey an event belongs to (PRD §7 `events.leg`). */
export type Leg = "forward" | "return";

/** Why a terminal parcel stopped moving (PRD §7 `terminal_reason`). */
export type TerminalReason = "delivered" | "rto" | "lost" | "cancelled";

/** One normalized tracking event (a scan, a freight milestone, or the status snapshot). */
export interface CarrierEvent {
  /** UTC ISO timestamp, or null when the feed gave no parseable time (PRD §4.3 pitfall 4). */
  occurredAt: string | null;
  /** Scan label / status token. */
  description: string;
  /** Scanned location (scannedLocation, else cityLocation), or null. */
  location: string | null;
  /** Classified stage; `unknown` when the token is unmapped (still stored & notified). */
  stage: Stage;
  leg: Leg;
  /** True for the current-status snapshot, false for scans/milestones (PRD §7 `is_summary`). */
  isSummary: boolean;
}

/** Normalized state of one tracked parcel at one poll (PRD §7 `packages` columns). */
export interface CarrierPackage {
  /** Identity-bound waybill number, 13–14 digits (PRD §4.3 pitfall 2). */
  awb: string;
  stage: Stage;
  /** Human text of the current status (instructions, else the raw token), or null. */
  statusText: string | null;
  /** Current status time (UTC ISO), or null. */
  statusAt: string | null;
  /** Raw ETA prose, e.g. "26 Oct 2026, Evening". Never parsed into a promise (PRD §9). */
  deliveryEta: string | null;
  destCity: string | null;
  referenceNo: string | null;
  productType: string | null;
  /** Leg of the current status. */
  leg: Leg;
  terminal: boolean;
  terminalReason: TerminalReason | null;
  /** Feed events in feed order, with the status snapshot first when present. */
  events: CarrierEvent[];
}

/**
 * Outcome of one track attempt.
 *
 * - `ok`: `data` was non-empty and identity-bound — the only hit signal
 *   (PRD §4.3 pitfall 1).
 * - `notFound`: the feed has no data for this AWB (invalid or very old),
 *   even though the envelope still said HTTP 200 / statusCode 200.
 * - `auth`: the endpoint rejected us (e.g. HTTP 401) — our front-door
 *   headers are stale, not a per-parcel problem (pitfall 6).
 * - `network`: transport failure (timeout, DNS, 5xx, oversize, non-JSON).
 * - `schema`: the response was JSON but not the shape we understand.
 */
export type CarrierResult =
  | { kind: "ok"; pkg: CarrierPackage }
  | { kind: "notFound"; message: string }
  | { kind: "auth"; message: string }
  | { kind: "network"; message: string }
  | { kind: "schema"; message: string };

export interface CarrierAdapter {
  readonly name: string;
  /**
   * Track one waybill number.
   * @throws {Error} when `awb` is not a 13–14 digit waybill number — a
   *   caller contract violation, not a feed problem.
   */
  track(awb: string): Promise<CarrierResult>;
}
