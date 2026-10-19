/**
 * Delhivery response envelope → normalized `CarrierPackage` (PRD §4.2–4.4, §7).
 *
 * The envelope lies: HTTP 200 + `statusCode: 200` still happens for
 * invalid/very-old AWBs with `data: []`. The ONLY hit signal is `data`
 * being non-empty, and the result must be identity-bound (`awb` field ===
 * requested AWB) before use (PRD §4.3 pitfalls 1–2). We never branch on
 * HTTP status or `statusCode`.
 *
 * Times in the feed carry no timezone — they are Asia/Kolkata (UTC+05:30,
 * no DST) and are converted to UTC ISO before storage. Values that already
 * carry a `Z`/offset are taken verbatim.
 */
import type { CarrierEvent, CarrierPackage, Leg } from "../types.js";
import { normalizeAwb } from "./client.js";
import {
  classifyStatus,
  FLOW_TOKEN,
  normalizeStatusToken,
  withReturnLegOverride,
  type Classification,
} from "./status.js";

const MAX_STATES = 100;
const MAX_SCANS_PER_STATE = 100;
const MAX_EVENTS = 500;

export type ParseOutcome =
  | { kind: "ok"; pkg: CarrierPackage }
  | { kind: "notFound"; message: string }
  | { kind: "schema"; message: string };

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

/**
 * Parse a feed timestamp to UTC ISO, or null when it is unusable.
 *
 * Accepts `2026-10-19T15:37:44` (no zone → Asia/Kolkata), optional
 * fractional seconds (observed up to 6 digits; milliseconds kept), and
 * explicit `Z`/`±HH:MM` offsets (taken verbatim). Empty strings and prose
 * return null — the anonymous feed omits scan times (PRD §4.3 pitfall 4).
 */
export function feedTimeToUtc(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})?$/.exec(
      value.trim(),
    );
  if (m === null) return null;
  const [, date, clock, frac, zone] = m;
  if (date === undefined || clock === undefined) return null;
  // V8's Date.parse ROLLS OVER out-of-range values ("2026-02-30T10:00:00"
  // becomes Mar 2, "25:00:00" becomes next-day 01:00) — validate components
  // explicitly before parsing.
  const [yearStr, monthStr, dayStr] = date.split("-");
  const [hh, mm, ss] = clock.split(":");
  if (
    Number(monthStr) < 1 ||
    Number(monthStr) > 12 ||
    Number(hh) > 23 ||
    Number(mm) > 59 ||
    Number(ss) > 59
  ) {
    return null;
  }
  const probe = new Date(Date.UTC(Number(yearStr), Number(monthStr) - 1, Number(dayStr)));
  if (
    probe.getUTCFullYear() !== Number(yearStr) ||
    probe.getUTCMonth() !== Number(monthStr) - 1 ||
    probe.getUTCDate() !== Number(dayStr)
  ) {
    return null; // e.g. Feb 30 does not exist
  }
  // Keep milliseconds, drop the sub-millisecond digits JS would ignore anyway.
  const fraction = frac !== undefined ? frac.slice(0, 4) : "";
  const candidate = `${date}T${clock}${fraction}${zone ?? "+05:30"}`;
  const ms = Date.parse(candidate);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Freight (B2B) milestones are dated `Sat, 29 Aug, 7:42 PM` — India time
 * with NO year. Resolve the year as the status year (or the year before)
 * in which the day falls on the stated weekday and does not post-date the
 * status; null when neither fits. Prior art: plhery/universal-parcel-scraper.
 */
export function milestoneTimeToUtc(value: unknown, statusAt: string | null): string | null {
  if (typeof value !== "string" || statusAt === null) return null;
  const m =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec), (\d{1,2}):(\d{2}) ([AP]M)$/.exec(
      value.trim(),
    );
  if (m === null) return null;
  const weekdayName = m[1]!;
  const day = Number(m[2]!);
  const month = MONTHS.indexOf(m[3]!);
  const hour12 = Number(m[4]!);
  const minute = Number(m[5]!);
  if (hour12 < 1 || hour12 > 12 || minute > 59 || day < 1 || day > 31) return null;
  const hour = (hour12 % 12) + (m[6] === "PM" ? 12 : 0);
  const statusYear = Number(statusAt.slice(0, 4));
  for (const year of [statusYear, statusYear - 1]) {
    const probe = new Date(Date.UTC(year, month, day));
    if (probe.getUTCMonth() !== month) continue; // e.g. Feb 30 does not exist
    if (WEEKDAYS[probe.getUTCDay()] !== weekdayName) continue;
    const time = feedTimeToUtc(
      `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}` +
        `T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`,
    );
    if (time !== null && Date.parse(time) <= Date.parse(statusAt)) return time;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Non-empty trimmed string, truncated to `maxLen`, or null. */
function cleanString(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s === "") return null;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/** The `awb` field, normalized to digits. May arrive as string or number. */
function itemAwb(item: Record<string, unknown>): string {
  const awb = item.awb;
  if (typeof awb === "string") return awb.replace(/[\s.-]/g, "");
  if (typeof awb === "number" && Number.isSafeInteger(awb)) return String(awb);
  return "";
}

function pushEvent(
  events: CarrierEvent[],
  seen: Set<string>,
  event: CarrierEvent,
): void {
  if (events.length >= MAX_EVENTS) return;
  const key = [
    event.occurredAt ?? "",
    event.description,
    event.location ?? "",
    event.leg,
    event.isSummary ? "summary" : "scan",
  ].join("\u0000");
  if (seen.has(key)) return;
  seen.add(key);
  events.push(event);
}

function legOfCurrentStatus(statusType: string, currentFlow: string): Leg {
  // Pitfall 5: RT statusType or a Returned/Reverse flow marks the return
  // leg. Observed flows also include "Closed" (e.g. lost shipments) —
  // everything not listed is the forward leg.
  return statusType === "RT" || currentFlow === "Returned" || currentFlow === "Reverse"
    ? "return"
    : "forward";
}

/**
 * Parse a Delhivery tracking envelope for one requested AWB.
 *
 * @throws {InvalidAwbError} when the requested AWB is not 13–14 digits
 */
export function parseDelhivery(payload: unknown, requestedAwb: string): ParseOutcome {
  const requested = normalizeAwb(requestedAwb);

  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return { kind: "schema", message: "envelope is missing the data array" };
  }
  if (payload.data.length === 0) {
    // The envelope still says HTTP 200 / statusCode 200 (pitfall 1) —
    // data [] IS the miss.
    const message = cleanString(payload.message, 200) ?? "feed returned no data";
    return { kind: "notFound", message };
  }

  // Identity-bind (pitfall 2): exactly one data entry with our AWB.
  const matches = payload.data.filter(
    (item): item is Record<string, unknown> =>
      isRecord(item) && itemAwb(item) === requested,
  );
  if (matches.length !== 1) {
    const got = payload.data
      .filter(isRecord)
      .map((item) => itemAwb(item))
      .filter((awb) => awb !== "")
      .join(", ");
    return {
      kind: "schema",
      message: `identity mismatch: requested ${requested}, feed gave [${got}]`,
    };
  }
  const item = matches[0]!;

  // --- current status -----------------------------------------------------
  const status = isRecord(item.status) ? item.status : {};
  const rawToken = cleanString(status.status, 200) ?? "";
  const hqStatus = cleanString(item.hqStatus, 200) ?? "";
  const statusType = cleanString(status.statusType, 16) ?? "";
  const currentFlow = cleanString(item.currentFlow, 32) ?? "";
  const leg = legOfCurrentStatus(statusType, currentFlow);

  // The current status can arrive as the flow token RETURNED (parcels still
  // travelling back to the sender) — that names a flow, not a state, so
  // fall back to hqStatus.
  let token = rawToken;
  if (token === "" || normalizeStatusToken(token) === FLOW_TOKEN) {
    token = hqStatus;
  }
  const current: Classification = withReturnLegOverride(classifyStatus(token), leg);
  const statusAt = feedTimeToUtc(status.statusDateTime);
  const statusText = cleanString(status.instructions, 200) ?? (token !== "" ? token : null);

  // --- events ---------------------------------------------------------------
  const states = Array.isArray(item.trackingStates) ? item.trackingStates : [];
  const reached =
    typeof item.currentTrackIndex === "number" && Number.isInteger(item.currentTrackIndex)
      ? item.currentTrackIndex
      : -1;

  const events: CarrierEvent[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < Math.min(states.length, MAX_STATES); index++) {
    const state = states[index];
    if (!isRecord(state)) continue; // garbage row: skip, don't break the parcel
    const scans = Array.isArray(state.scans) ? state.scans : [];

    // Freight (B2B) replies date the milestone rather than its scans; a
    // pickup milestone can have no scans at all. A reached state without
    // dated scans contributes the milestone itself as an event. States past
    // currentTrackIndex are the website's future progress rail and never
    // claim movement.
    if (index <= reached) {
      const label = cleanString(state.label, 200);
      const date = cleanString(state.date, 64);
      const hasDatedScan = scans.some(
        (scan) => isRecord(scan) && feedTimeToUtc(scan.scanDateTime) !== null,
      );
      if (label !== null && date !== null && !hasDatedScan) {
        const milestoneLeg: Leg = currentFlow === "Reverse" ? "return" : "forward";
        const milestone = withReturnLegOverride(classifyStatus(label), milestoneLeg);
        pushEvent(events, seen, {
          occurredAt: milestoneTimeToUtc(date, statusAt),
          description: label,
          location: null,
          stage: milestone.stage,
          leg: milestoneLeg,
          isSummary: false,
        });
      }
    }

    for (
      let i = 0;
      i < Math.min(scans.length, MAX_SCANS_PER_STATE) && events.length < MAX_EVENTS;
      i++
    ) {
      const scan = scans[i];
      if (!isRecord(scan)) continue;
      const label = cleanString(scan.scan, 200);
      if (label === null) continue; // unlabelled row: noise, not signal
      const scanType = cleanString(scan.scanType, 16) ?? "";
      // Per-scan leg: the scan's own type wins (observed: UD/DL/RT/LT); a
      // fully-Reverse flow implies return for any scan it carries.
      const scanLeg: Leg = scanType === "RT" || currentFlow === "Reverse" ? "return" : "forward";
      const scanStage = withReturnLegOverride(classifyStatus(label), scanLeg);
      pushEvent(events, seen, {
        occurredAt: feedTimeToUtc(scan.scanDateTime),
        description: label,
        // scannedLocation is the specific scan point ("Delhi_Airport_GW (Delhi)");
        // cityLocation is the coarser fallback.
        location: cleanString(scan.scannedLocation, 160) ?? cleanString(scan.cityLocation, 160),
        stage: scanStage.stage,
        leg: scanLeg,
        isSummary: false,
      });
    }
  }

  // The current status is a snapshot, not a scan (PRD §7 is_summary). Emit
  // it only when the feed doesn't already report the same thing at the same
  // instant — otherwise every poll re-diffs a phantom event. A dated
  // delivered event already records the delivery the status repeats, so no
  // summary in that case either (a freight status can date a later
  // proof-of-delivery audit; the delivered milestone dates the delivery).
  const deliveryAlreadyDated =
    current.stage === "delivered" &&
    events.some((e) => e.occurredAt !== null && e.stage === "delivered");
  if (token !== "" && !deliveryAlreadyDated) {
    const alreadyReported = events.some((e) => {
      if (normalizeStatusToken(e.description) !== normalizeStatusToken(token)) return false;
      if (e.stage !== current.stage || e.leg !== leg) return false;
      return statusAt === null || e.occurredAt === statusAt;
    });
    if (!alreadyReported) {
      events.unshift({
        occurredAt: statusAt,
        description: token,
        location: null,
        stage: current.stage,
        leg,
        isSummary: true,
      });
    }
  }

  const pkg: CarrierPackage = {
    awb: requested,
    stage: current.stage,
    statusText,
    statusAt,
    deliveryEta:
      cleanString(item.deliveryDate, 64) ?? cleanString(item.PromiseDeliveryDate, 64),
    destCity: isRecord(item.addressInfo) ? cleanString(item.addressInfo.city, 64) : null,
    referenceNo: cleanString(item.referenceNo, 64),
    productType: cleanString(item.productType, 32),
    leg,
    terminal: current.terminal,
    terminalReason: current.terminalReason,
    events,
  };
  return { kind: "ok", pkg };
}
