/**
 * Notification formatting (PRD §5, §11): turns the poller's structured
 * `PollNotification` (src/poller/loop.ts — the M4→M5 contract) and the
 * add-time `CarrierPackage` into Telegram text.
 *
 * The text is Telegram **MarkdownV2**: the only markup is the bold AWB,
 * and the AWB is pure digits (13–14, the adapter's contract), so every
 * carrier-controlled string (descriptions, locations, status text, ETA,
 * error messages) goes through `mdv2Escape`. Hostile feed content can
 * therefore never break the parse mode or inject markup, and the
 * template literals themselves contain no MarkdownV2 specials. M6 sends
 * the result with `parse_mode: "MarkdownV2"`.
 *
 * Times render in Asia/Kolkata (fixed UTC+05:30, no DST, no Intl) — the
 * source feed's zone (PRD §4.3 pitfall 3) and the owner's; the PRD §5
 * examples show IST wall-clock times. The year is appended only when the
 * instant falls in a different year than now (a freight backlog can span
 * New Year's).
 *
 * Bundling (PRD §8): one message per parcel per poll — the `events` array
 * (the fresh parse minus what the DB already has, computed by
 * `insertEvents` in M3) is rendered as a block, capped at
 * `MAX_EVENTS_PER_MESSAGE` lines so a huge backlog cannot hit Telegram's
 * 4096-character message limit.
 */
import type {
  CarrierEvent,
  CarrierPackage,
  Stage,
  TerminalReason,
} from "../carriers/types.js";
import type { PollNotification } from "../poller/loop.js";

/** A bundled message shows at most this many new events, then a tail line. */
export const MAX_EVENTS_PER_MESSAGE = 20;

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

// ---------------------------------------------------------------------------
// MarkdownV2
// ---------------------------------------------------------------------------

/** Every character Telegram's MarkdownV2 treats as markup (backslash included: an unescaped '\' in feed text defeats the escaping of every other special and can break the parse). */
const MDV2_SPECIALS = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/**
 * Escape a string for safe interpolation into a MarkdownV2 message
 * (Telegram parse mode M6 will send with). Structural text in this module
 * avoids specials entirely; only carrier-controlled text needs this.
 */
export function mdv2Escape(value: string): string {
  return value.replace(MDV2_SPECIALS, "\\$&");
}

// ---------------------------------------------------------------------------
// Time & duration rendering
// ---------------------------------------------------------------------------

/**
 * Render a stored UTC ISO instant as the owner's wall-clock time
 * (Asia/Kolkata, fixed +05:30): `26 Oct 8:15 AM`. The year is appended
 * when the instant's (IST) year differs from `now`'s: `1 Jun 2025 5:30 AM`.
 *
 * Returns null when the input is null or unparseable (an undated scan —
 * PRD §4.3 pitfall 4 — or corrupted stored data).
 */
export function formatWhen(isoUtc: string | null, now: Date = new Date()): string | null {
  if (isoUtc === null) return null;
  const ms = Date.parse(isoUtc);
  if (Number.isNaN(ms)) return null;
  const t = new Date(ms + IST_OFFSET_MS);
  const h24 = t.getUTCHours();
  const hour12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ampm = h24 < 12 ? "AM" : "PM";
  const datePart = `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`;
  const yearPart =
    t.getUTCFullYear() === now.getUTCFullYear() ? "" : ` ${t.getUTCFullYear()}`;
  return `${datePart}${yearPart} ${hour12}:${String(t.getUTCMinutes()).padStart(2, "0")} ${ampm}`;
}

/** Human duration for the backoff tiers (1 h / 6 h / 24 h), and friends. */
export function formatDurationMs(ms: number): string {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  if (ms >= DAY && ms % DAY === 0) return `${ms / DAY} d`;
  if (ms % HOUR === 0) return `${ms / HOUR} h`;
  if (ms % MINUTE === 0) return `${ms / MINUTE} min`;
  return `${Math.round(ms / 1000)} s`;
}

// ---------------------------------------------------------------------------
// Display names
// ---------------------------------------------------------------------------

/** `Stage` → chat-friendly wording (PRD §4.4 meanings). */
const STAGE_DISPLAY: Record<Stage, string> = {
  registered: "Registered",
  accepted: "Picked Up",
  in_transit: "In Transit",
  out_for_delivery: "Out for Delivery",
  delivered: "Delivered",
  returned: "Returned To Sender",
  exception: "Exception",
  unknown: "Unknown",
};

/** Terminal reason → celebratory/somber header (PRD §5). */
const TERMINAL_DISPLAY: Record<TerminalReason, { emoji: string; verdict: string }> = {
  delivered: { emoji: "🎉", verdict: "delivered" },
  rto: { emoji: "😞", verdict: "returned to sender — RTO" },
  lost: { emoji: "😬", verdict: "lost" },
  cancelled: { emoji: "🚫", verdict: "cancelled" },
};

const TERMINAL_FALLBACK = { emoji: "⚠️", verdict: "stopped — terminal state" };

// ---------------------------------------------------------------------------
// Shared blocks
// ---------------------------------------------------------------------------

/**
 * The ✦ block for a batch of new events: `✦ <description>` per event,
 * followed by an indented `<location> · <when>` line (either part alone
 * is fine; neither → no detail line). Input order is kept — the feed
 * order the diff (M3 `insertEvents`) returns, newest-first in practice.
 */
function eventLines(events: readonly CarrierEvent[], now: Date): string[] {
  const lines: string[] = [];
  for (const ev of events.slice(0, MAX_EVENTS_PER_MESSAGE)) {
    lines.push(`✦ ${mdv2Escape(ev.description)}`);
    const when = formatWhen(ev.occurredAt, now);
    const where = ev.location !== null ? mdv2Escape(ev.location) : null;
    if (where !== null && when !== null) lines.push(`  ${where} · ${when}`);
    else if (where !== null) lines.push(`  ${where}`);
    else if (when !== null) lines.push(`  ${when}`);
  }
  const extra = events.length - MAX_EVENTS_PER_MESSAGE;
  if (extra > 0) lines.push(`… and ${extra} more`);
  return lines;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Add-time snapshot (the M6 `/track` reply, PRD §5):
 *
 * ```
 * 📦 *<awb>* — tracking
 * In Transit → Bangalore
 * Last: Shipment picked up · 19 Oct 3:37 PM
 * ETA: 26 Oct 2026, Evening
 * ```
 *
 * The stage line carries the normalized stage (and city when known);
 * the `Last:` line carries the feed's own status wording and time. Each
 * line degrades gracefully when its data is missing.
 */
export function formatSnapshot(pkg: CarrierPackage, now: Date = new Date()): string {
  const lines: string[] = [`📦 *${pkg.awb}* — tracking`];
  const stage = STAGE_DISPLAY[pkg.stage];
  lines.push(
    pkg.destCity !== null ? `${stage} → ${mdv2Escape(pkg.destCity)}` : stage,
  );
  if (pkg.statusText !== null) {
    const when = formatWhen(pkg.statusAt, now);
    lines.push(
      when !== null
        ? `Last: ${mdv2Escape(pkg.statusText)} · ${when}`
        : `Last: ${mdv2Escape(pkg.statusText)}`,
    );
  }
  if (pkg.deliveryEta !== null) {
    lines.push(`ETA: ${mdv2Escape(pkg.deliveryEta)}`);
  }
  return lines.join("\n");
}

/**
 * Bundled update — one message per parcel per poll (PRD §5, §8):
 *
 * ```
 * *<awb>*
 * ✦ Out for Delivery
 *   Bangalore · 26 Oct 8:15 AM
 * ✦ In Transit
 *   Bengaluru Hub · 25 Oct 9:02 PM
 * ETA: 26 Oct 2026, Evening
 * ```
 */
export function formatUpdateMessage(
  n: Extract<PollNotification, { kind: "update" }>,
  now: Date = new Date(),
): string {
  const lines: string[] = [`*${n.pkg.awb}*`, ...eventLines(n.events, now)];
  if (n.pkg.deliveryEta !== null) {
    lines.push(`ETA: ${mdv2Escape(n.pkg.deliveryEta)}`);
  }
  return lines.join("\n");
}

/**
 * Terminal message (PRD §5): celebratory or somber, then the new events
 * of the poll that got the parcel there — or, when the poll added no new
 * events, the current status line — and the "tracking stopped" footer.
 */
export function formatTerminalMessage(
  n: Extract<PollNotification, { kind: "terminal" }>,
  now: Date = new Date(),
): string {
  const display =
    n.reason !== null ? TERMINAL_DISPLAY[n.reason] : TERMINAL_FALLBACK;
  const lines: string[] = [`${display.emoji} *${n.pkg.awb}* — ${display.verdict}`];
  if (n.events.length > 0) {
    lines.push(...eventLines(n.events, now));
  } else if (n.pkg.statusText !== null) {
    const parts = [
      mdv2Escape(n.pkg.statusText),
      n.pkg.destCity !== null ? mdv2Escape(n.pkg.destCity) : null,
      formatWhen(n.pkg.statusAt, now),
    ].filter((p): p is string => p !== null);
    if (parts.length > 0) lines.push(parts.join(" · "));
  }
  lines.push("👋 tracking stopped");
  return lines.join("\n");
}

/**
 * "Delhivery endpoint looks broken — pausing" — exactly one of these per
 * break episode (the streak-3 gate in M4), then quiet backoff (PRD §8,
 * pitfall 6).
 */
export function formatEndpointBrokenMessage(
  n: Extract<PollNotification, { kind: "endpointBroken" }>,
): string {
  const lines: string[] = [
    `🚨 *${n.awb}* — Delhivery endpoint looks broken`,
    `${n.streak} polls in a row failed`,
  ];
  if (n.lastError !== null) {
    lines.push(`Last error: ${mdv2Escape(n.lastError)}`);
  }
  lines.push(`Pausing this parcel for ${formatDurationMs(n.pauseMs)}`);
  return lines.join("\n");
}

/**
 * A tracked parcel the feed now says is "invalid AWB or very old package"
 * — told once per episode, polling continues in case it is a feed glitch
 * (PRD §8).
 */
export function formatNotFoundMessage(
  n: Extract<PollNotification, { kind: "notFound" }>,
): string {
  return [
    `🔎 *${n.awb}* — feed says ${mdv2Escape(n.message)}`,
    "Probably a feed glitch — keeping up polls",
  ].join("\n");
}

/**
 * The M4→M5→M6 dispatcher: any poller notification → one sendable
 * MarkdownV2 message. M6's emit sink is `sendMessage(chatId,
 * formatPollNotification(n), { parse_mode: "MarkdownV2" })`.
 */
export function formatPollNotification(
  n: PollNotification,
  now: Date = new Date(),
): string {
  switch (n.kind) {
    case "update":
      return formatUpdateMessage(n, now);
    case "terminal":
      return formatTerminalMessage(n, now);
    case "endpointBroken":
      return formatEndpointBrokenMessage(n);
    case "notFound":
      return formatNotFoundMessage(n);
  }
}
