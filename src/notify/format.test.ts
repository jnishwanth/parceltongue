import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  CarrierEvent,
  CarrierPackage,
  TerminalReason,
} from "../carriers/types.js";
import { parseDelhivery } from "../carriers/delhivery/parse.js";
import type { PackageRow } from "../db/repo.js";
import type { PollNotification } from "../poller/loop.js";
import {
  MAX_EVENTS_PER_MESSAGE,
  formatDurationMs,
  formatEndpointBrokenMessage,
  formatNotFoundMessage,
  formatPollNotification,
  formatSnapshot,
  formatTerminalMessage,
  formatUpdateMessage,
  formatWhen,
  mdv2Escape,
} from "./format.js";

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

/** Fixed "now" (UTC) — every fixture input is from 2026, so no year shows. */
const NOW = new Date(Date.parse("2026-10-20T12:00:00.000Z"));
const NOW_ISO = NOW.toISOString();
const AWB = "55540110035405";

/** A pinned expected message (src/notify/fixtures/*.txt). */
function fixtureText(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    "utf8",
  ).trim();
}

/** A M2 carrier fixture run through the real parser (no network). */
async function parseCarrierFixture(name: string, awb: string): Promise<CarrierPackage> {
  const raw = readFileSync(
    fileURLToPath(
      new URL(`../carriers/delhivery/fixtures/${name}`, import.meta.url),
    ),
    "utf8",
  );
  const outcome = parseDelhivery(JSON.parse(raw) as unknown, awb);
  if (outcome.kind !== "ok") {
    throw new Error(`expected ok, got ${outcome.kind}: ${outcome.message}`);
  }
  return outcome.pkg;
}

function ev(overrides: Partial<CarrierEvent> = {}): CarrierEvent {
  return {
    occurredAt: null,
    description: "In Transit",
    location: null,
    stage: "in_transit",
    leg: "forward",
    isSummary: false,
    ...overrides,
  };
}

function row(overrides: Partial<PackageRow> = {}): PackageRow {
  return {
    awb: AWB,
    addedAt: NOW_ISO,
    sourceLink: null,
    destCity: "Bangalore",
    referenceNo: null,
    productType: null,
    currentStage: "in_transit",
    statusText: "In Transit",
    statusAt: "2026-10-19T10:07:44.000Z",
    deliveryEta: "26 Oct 2026, Evening",
    terminal: false,
    terminalReason: null,
    polls: 3,
    lastPolledAt: NOW_ISO,
    lastError: null,
    errorStreak: 0,
    ...overrides,
  };
}

/** The `packages` row the M4 loop would hand to the terminal notification. */
function rowFromPkg(pkg: CarrierPackage): PackageRow {
  return row({
    awb: pkg.awb,
    destCity: pkg.destCity,
    referenceNo: pkg.referenceNo,
    productType: pkg.productType,
    currentStage: pkg.stage,
    statusText: pkg.statusText,
    statusAt: pkg.statusAt,
    deliveryEta: pkg.deliveryEta,
    terminal: pkg.terminal,
    terminalReason: pkg.terminalReason,
  });
}

function terminal(
  pkg: CarrierPackage,
  reason: TerminalReason | null,
  events: readonly CarrierEvent[],
): Extract<PollNotification, { kind: "terminal" }> {
  return { kind: "terminal", pkg: rowFromPkg(pkg), reason, events: [...events] };
}

// ---------------------------------------------------------------------------
// Pinned message fixtures (the M5 output)
// ---------------------------------------------------------------------------

describe("pinned message fixtures", () => {
  it("snapshot — add-time message for the in-transit fixture (PRD §5)", async () => {
    const pkg = await parseCarrierFixture("in-transit.json", AWB);
    expect(formatSnapshot(pkg, NOW)).toBe(fixtureText("snapshot-in-transit.txt"));
  });

  it("update — one bundled message for all new events of a poll (PRD §5/§8)", () => {
    const n: Extract<PollNotification, { kind: "update" }> = {
      kind: "update",
      pkg: row(),
      events: [
        ev({
          description: "Out for Delivery",
          location: "Bangalore",
          stage: "out_for_delivery",
          occurredAt: "2026-10-26T02:45:00.000Z", // 8:15 AM IST
        }),
        ev({
          location: "Bengaluru Hub",
          occurredAt: "2026-10-25T15:32:00.000Z", // 9:02 PM IST
        }),
      ],
    };
    expect(formatUpdateMessage(n, NOW)).toBe(fixtureText("update-bundled.txt"));
  });

  it("terminal — delivered (delivered.json: fractional time, undated scan)", async () => {
    const pkg = await parseCarrierFixture("delivered.json", "0000000000001");
    expect(
      formatTerminalMessage(terminal(pkg, "delivered", pkg.events.slice(0, 2)), NOW),
    ).toBe(fixtureText("terminal-delivered.txt"));
  });

  it("terminal — RTO (pitfall 5: delivered on the return leg)", async () => {
    const pkg = await parseCarrierFixture("rto-delivered.json", "0000000000002");
    expect(pkg.terminalReason).toBe("rto"); // sanity: the parser did its part
    expect(formatTerminalMessage(terminal(pkg, "rto", pkg.events), NOW)).toBe(
      fixtureText("terminal-rto.txt"),
    );
  });

  it("terminal — lost (lost.json: verbatim live capture, Closed flow)", async () => {
    const pkg = await parseCarrierFixture("lost.json", "39777010000022");
    expect(
      formatTerminalMessage(terminal(pkg, "lost", pkg.events.slice(0, 2)), NOW),
    ).toBe(fixtureText("terminal-lost.txt"));
  });

  it("endpointBroken — the once-per-episode 'pausing' alert (PRD §8, pitfall 6)", () => {
    const n: Extract<PollNotification, { kind: "endpointBroken" }> = {
      kind: "endpointBroken",
      awb: AWB,
      streak: 3,
      pauseMs: 60 * 60 * 1000,
      lastError: "HTTP 401 Unauthorized",
    };
    expect(formatEndpointBrokenMessage(n)).toBe(fixtureText("endpoint-broken.txt"));
  });

  it("notFound — the once-per-episode 'invalid AWB' tell (PRD §8)", () => {
    const n: Extract<PollNotification, { kind: "notFound" }> = {
      kind: "notFound",
      awb: AWB,
      message: "invalid AWB or very old package",
    };
    expect(formatNotFoundMessage(n)).toBe(fixtureText("not-found.txt"));
  });
});

// ---------------------------------------------------------------------------
// formatPollNotification (the M4→M6 dispatcher)
// ---------------------------------------------------------------------------

describe("formatPollNotification", () => {
  it("routes every kind to its formatter", () => {
    const update: Extract<PollNotification, { kind: "update" }> = {
      kind: "update",
      pkg: row(),
      events: [ev({ description: "Out for Delivery" })],
    };
    const notFound: Extract<PollNotification, { kind: "notFound" }> = {
      kind: "notFound",
      awb: AWB,
      message: "invalid AWB or very old package",
    };
    const broken: Extract<PollNotification, { kind: "endpointBroken" }> = {
      kind: "endpointBroken",
      awb: AWB,
      streak: 3,
      pauseMs: 6 * 60 * 60 * 1000,
      lastError: null,
    };
    expect(formatPollNotification(update, NOW)).toBe(formatUpdateMessage(update, NOW));
    expect(formatPollNotification(notFound)).toBe(fixtureText("not-found.txt"));
    expect(formatPollNotification(broken)).toBe(formatEndpointBrokenMessage(broken));
  });
});

// ---------------------------------------------------------------------------
// Degenerate inputs
// ---------------------------------------------------------------------------

describe("degenerate inputs", () => {
  it("snapshot degrades when city, ETA and status are missing", () => {
    const pkg: CarrierPackage = {
      awb: AWB,
      stage: "in_transit",
      statusText: null,
      statusAt: null,
      deliveryEta: null,
      destCity: null,
      referenceNo: null,
      productType: null,
      leg: "forward",
      terminal: false,
      terminalReason: null,
      events: [],
    };
    expect(formatSnapshot(pkg, NOW)).toBe(
      `📦 *${AWB}* — tracking\nIn Transit`,
    );
  });

  it("snapshot keeps the Last line without a time when the status is undated", () => {
    const pkg = {
      stage: "accepted" as const,
      statusText: "Shipment picked up",
      statusAt: null as string | null,
      deliveryEta: null as string | null,
      destCity: null as string | null,
      referenceNo: null as string | null,
      productType: null as string | null,
      leg: "forward" as const,
      terminal: false,
      terminalReason: null as TerminalReason | null,
      events: [],
    };
    expect(
      formatSnapshot({ awb: AWB, ...pkg } satisfies CarrierPackage, NOW),
    ).toBe(`📦 *${AWB}* — tracking\nPicked Up\nLast: Shipment picked up`);
  });

  it("update renders time-only, location-only and bare events; no ETA line without an ETA", () => {
    const n: Extract<PollNotification, { kind: "update" }> = {
      kind: "update",
      pkg: row({ deliveryEta: null }),
      events: [
        ev({
          description: "Out for Delivery",
          stage: "out_for_delivery",
          occurredAt: "2026-10-26T00:00:00.000Z", // 5:30 AM IST
        }),
        ev({ description: "Arrived at hub", location: "Delhi" }),
        ev({ description: "Weird scan", stage: "unknown" }),
      ],
    };
    expect(formatUpdateMessage(n, NOW)).toBe(
      [
        `*${AWB}*`,
        "✦ Out for Delivery",
        "  26 Oct 5:30 AM",
        "✦ Arrived at hub",
        "  Delhi",
        "✦ Weird scan",
      ].join("\n"),
    );
  });

  it("terminal with no new events falls back to the current status line", () => {
    const n: Extract<PollNotification, { kind: "terminal" }> = {
      kind: "terminal",
      pkg: row({
        statusText: "Delivered",
        currentStage: "delivered",
        statusAt: "2026-10-26T04:42:00.000Z", // 10:12 AM IST
      }),
      reason: "delivered",
      events: [],
    };
    expect(formatTerminalMessage(n, NOW)).toBe(
      [
        `🎉 *${AWB}* — delivered`,
        "Delivered · Bangalore · 26 Oct 10:12 AM",
        "👋 tracking stopped",
      ].join("\n"),
    );
  });

  it("terminal with a null reason uses the generic header", () => {
    const n: Extract<PollNotification, { kind: "terminal" }> = {
      kind: "terminal",
      pkg: row({ statusText: "Closed", destCity: null, statusAt: null, currentStage: "exception" }),
      reason: null,
      events: [],
    };
    expect(formatTerminalMessage(n, NOW)).toBe(
      [
        `⚠️ *${AWB}* — stopped — terminal state`,
        "Closed",
        "👋 tracking stopped",
      ].join("\n"),
    );
  });

  it("terminal — cancelled", () => {
    const n: Extract<PollNotification, { kind: "terminal" }> = {
      kind: "terminal",
      pkg: row({ currentStage: "exception" }),
      reason: "cancelled",
      events: [ev({ description: "Cancelled", stage: "exception", occurredAt: "2026-10-20T10:00:00.000Z" })],
    };
    expect(formatTerminalMessage(n, NOW)).toBe(
      [
        `🚫 *${AWB}* — cancelled`,
        "✦ Cancelled",
        "  20 Oct 3:30 PM",
        "👋 tracking stopped",
      ].join("\n"),
    );
  });

  it("a huge backlog is capped, with a tail line instead of a 4096-char message", () => {
    const n: Extract<PollNotification, { kind: "update" }> = {
      kind: "update",
      pkg: row({ deliveryEta: null }),
      events: Array.from({ length: 25 }, (_, i) => ev({ description: `Scan ${i + 1}` })),
    };
    const lines = formatUpdateMessage(n, NOW).split("\n");
    expect(lines).toHaveLength(MAX_EVENTS_PER_MESSAGE + 2); // awb + 20 + tail
    expect(lines[MAX_EVENTS_PER_MESSAGE + 1]).toBe("… and 5 more");
  });

  it("a worst-case parse-legal backlog (200-char labels, 160-char locations) stays under Telegram's 4096 limit", () => {
    // The parser's own caps: descriptions 200 chars, locations 160 — the
    // count cap alone would render a 7709-char message here.
    const label = "L".repeat(200);
    const location = "M".repeat(160);
    const n: Extract<PollNotification, { kind: "update" }> = {
      kind: "update",
      pkg: row({ deliveryEta: null }),
      events: Array.from({ length: 25 }, () => ev({ description: label, location })),
    };
    const out = formatUpdateMessage(n, NOW);
    const lines = out.split("\n");
    const shown = lines.filter((l) => l.startsWith("✦")).length;
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(MAX_EVENTS_PER_MESSAGE);
    expect(lines.at(-1)).toBe(`… and ${25 - shown} more`);
  });

  it("a worst-case terminal message stays under the limit (header + footer included)", () => {
    const label = "L".repeat(200);
    const location = "M".repeat(160);
    const n: Extract<PollNotification, { kind: "terminal" }> = {
      kind: "terminal",
      pkg: row(),
      reason: "rto",
      events: Array.from({ length: 25 }, () => ev({ description: label, location })),
    };
    expect(formatTerminalMessage(n, NOW).length).toBeLessThanOrEqual(4096);
  });

  it("endpointBroken omits the detail line without a last error", () => {
    const n: Extract<PollNotification, { kind: "endpointBroken" }> = {
      kind: "endpointBroken",
      awb: AWB,
      streak: 3,
      pauseMs: 24 * 60 * 60 * 1000,
      lastError: null,
    };
    expect(formatEndpointBrokenMessage(n)).toBe(
      [
        `🚨 *${AWB}* — Delhivery endpoint looks broken`,
        "3 polls in a row failed",
        "Pausing this parcel for 1 d",
      ].join("\n"),
    );
  });
});

// ---------------------------------------------------------------------------
// Time, duration and escaping
// ---------------------------------------------------------------------------

describe("formatWhen (Asia/Kolkata, fixed +05:30)", () => {
  it("renders IST wall-clock, 12-hour, no leading zeros, seconds dropped", () => {
    expect(formatWhen("2026-10-19T10:07:44.989Z", NOW)).toBe("19 Oct 3:37 PM");
    expect(formatWhen("2026-10-25T18:30:00.000Z", NOW)).toBe("26 Oct 12:00 AM"); // midnight rolls the date
    expect(formatWhen("2026-10-26T06:30:00.000Z", NOW)).toBe("26 Oct 12:00 PM");
  });

  it("appends the year only when the IST year differs from now", () => {
    expect(formatWhen("2025-06-01T00:00:00.000Z", NOW)).toBe("1 Jun 2025 5:30 AM");
    // UTC says 2025, IST already says 2026 — the IST year wins.
    expect(
      formatWhen("2025-12-31T23:00:00.000Z", new Date(Date.parse("2026-01-01T01:00:00.000Z"))),
    ).toBe("1 Jan 4:30 AM");
  });

  it("null and unparseable input render as 'no time' (undated scans, PRD §4.3 pitfall 4)", () => {
    expect(formatWhen(null, NOW)).toBeNull();
    expect(formatWhen("not-a-time", NOW)).toBeNull();
  });
});

describe("formatDurationMs", () => {
  it("covers the backoff tiers and smaller scales", () => {
    expect(formatDurationMs(60 * 60 * 1000)).toBe("1 h");
    expect(formatDurationMs(6 * 60 * 60 * 1000)).toBe("6 h");
    expect(formatDurationMs(24 * 60 * 60 * 1000)).toBe("1 d");
    expect(formatDurationMs(48 * 60 * 60 * 1000)).toBe("2 d");
    expect(formatDurationMs(2 * 60 * 1000)).toBe("2 min");
    expect(formatDurationMs(90_000)).toBe("90 s");
  });
});

describe("mdv2Escape", () => {
  it("escapes every MarkdownV2 special, leaves everything else", () => {
    expect(
      mdv2Escape("a_b (c) d*e [f] g~h >i #j +k -l =m |n {o} p.q !r"),
    ).toBe("a\\_b \\(c\\) d\\*e \\[f\\] g\\~h \\>i \\#j \\+k \\-l \\=m \\|n \\{o\\} p\\.q \\!r");
    expect(mdv2Escape("55540110035405 · 26 Oct 8:15 AM → 📦")).toBe(
      "55540110035405 · 26 Oct 8:15 AM → 📦",
    );
  });

  it("carrier-controlled text is always escaped in the output", () => {
    const hostile = "Out for delivery (attempt #1) *failed* _twice_ `now` [really] ~done~";
    const n: Extract<PollNotification, { kind: "update" }> = {
      kind: "update",
      pkg: row(),
      events: [ev({ description: hostile })],
    };
    const out = formatUpdateMessage(n, NOW);
    expect(out).toContain(`✦ ${mdv2Escape(hostile)}`);
    expect(out).not.toContain(hostile); // the raw form must never appear
  });

  it("escapes backslash too, so feed backslashes cannot break parse mode or inject markup", () => {
    // Each backslash must itself become an escaped literal backslash;
    // otherwise '\*HACKED*\*' renders '\\' + bare '*' (injected bold),
    // 'before\📦after' is backslash-before-non-special (parse error),
    // and a trailing '\' leaves the message unparseable (send dropped).
    expect(mdv2Escape("\\*HACKED*\\*")).toBe("\\\\\\*HACKED\\*\\\\\\*");
    expect(mdv2Escape("before\\📦after")).toBe("before\\\\📦after");
    expect(mdv2Escape("ETA ends \\")).toBe("ETA ends \\\\");

    const hostile = "\\*HACKED*\\*";
    const n: Extract<PollNotification, { kind: "update" }> = {
      kind: "update",
      pkg: row(),
      events: [ev({ description: hostile })],
    };
    const out = formatUpdateMessage(n, NOW);
    expect(out).toContain(`✦ \\\\\\*HACKED\\*\\\\\\*`);
    expect(out).not.toContain(hostile); // the raw form must never appear
  });
});
