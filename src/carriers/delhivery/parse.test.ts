import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CarrierEvent, CarrierPackage } from "../types.js";
import { InvalidAwbError } from "./client.js";
import { feedTimeToUtc, milestoneTimeToUtc, parseDelhivery } from "./parse.js";

async function loadFixture(name: string): Promise<unknown> {
  const raw = await readFile(
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    "utf8",
  );
  return JSON.parse(raw) as unknown;
}

const AWB = "55540110035405";

function okOutcome(payload: unknown, awb = AWB): CarrierPackage {
  const outcome = parseDelhivery(payload, awb);
  if (outcome.kind !== "ok") {
    throw new Error(`expected ok, got ${outcome.kind}: ${outcome.message}`);
  }
  return outcome.pkg;
}

function eventsOf(pkg: CarrierPackage): CarrierEvent[] {
  return pkg.events;
}

describe("parseDelhivery — in-transit (PRD §4.2 live capture, extended)", () => {
  it("normalizes stage, times (IST→UTC), ETA and city", async () => {
    const pkg = okOutcome(await loadFixture("in-transit.json"));
    expect(pkg.awb).toBe(AWB);
    expect(pkg.stage).toBe("accepted"); // current token PICKUP
    expect(pkg.terminal).toBe(false);
    expect(pkg.terminalReason).toBeNull();
    expect(pkg.statusText).toBe("Shipment picked up");
    expect(pkg.statusAt).toBe("2026-10-19T10:07:44.000Z"); // 15:37:44 IST
    expect(pkg.deliveryEta).toBe("26 Oct 2026, Evening");
    expect(pkg.destCity).toBe("Bangalore");
    expect(pkg.referenceNo).toBe("GNPC17375");
    expect(pkg.productType).toBe("B2C");
    expect(pkg.leg).toBe("forward");
  });

  it("emits the status snapshot plus the flattened scans, in feed order", async () => {
    const pkg = okOutcome(await loadFixture("in-transit.json"));
    expect(eventsOf(pkg)).toEqual([
      {
        occurredAt: "2026-10-19T10:07:44.000Z",
        description: "PICKUP",
        location: null,
        stage: "accepted",
        leg: "forward",
        isSummary: true,
      },
      {
        occurredAt: "2026-10-19T10:07:44.000Z",
        description: "In Transit",
        location: "Delhi_Airport_GW (Delhi)",
        stage: "in_transit",
        leg: "forward",
        isSummary: false,
      },
      {
        occurredAt: "2026-10-19T15:42:08.000Z",
        description: "In Transit",
        location: "Mumbai_Hub (Maharashtra)",
        stage: "in_transit",
        leg: "forward",
        isSummary: false,
      },
    ]);
  });

  it("prefers scannedLocation over cityLocation", async () => {
    const pkg = okOutcome(await loadFixture("in-transit.json"));
    expect(pkg.events[1]?.location).toBe("Delhi_Airport_GW (Delhi)");
    expect(pkg.events.some((e) => e.location === "Delhi")).toBe(false);
  });
});

describe("parseDelhivery — delivered", () => {
  it("classifies terminal delivered and converts 6-digit fractional IST times", async () => {
    const pkg = okOutcome(await loadFixture("delivered.json"), "0000000000001");
    expect(pkg.stage).toBe("delivered");
    expect(pkg.terminal).toBe(true);
    expect(pkg.terminalReason).toBe("delivered");
    expect(pkg.statusAt).toBe("2026-01-03T08:30:00.000Z"); // 14:00:00 IST
    expect(pkg.leg).toBe("forward"); // statusType DL, no currentFlow
    expect(pkg.destCity).toBeNull(); // addressInfo has no city (name/address PII shape)
    expect(pkg.deliveryEta).toBeNull();
  });

  it("flattens undated scans and adds a dated summary; scanType DL stays forward", async () => {
    const pkg = okOutcome(await loadFixture("delivered.json"), "0000000000001");
    expect(eventsOf(pkg)).toHaveLength(3);
    expect(pkg.events[0]?.isSummary).toBe(true);
    expect(pkg.events[0]?.description).toBe("DELIVERED");
    expect(pkg.events[1]).toMatchObject({
      description: "Delivered",
      occurredAt: null,
      stage: "delivered",
      leg: "forward",
    });
  });
});

describe("parseDelhivery — lost (verbatim live capture)", () => {
  it("classifies terminal lost; currentFlow Closed is the forward leg", async () => {
    const pkg = okOutcome(await loadFixture("lost.json"), "39777010000022");
    expect(pkg.stage).toBe("exception");
    expect(pkg.terminal).toBe(true);
    expect(pkg.terminalReason).toBe("lost");
    expect(pkg.leg).toBe("forward");
    expect(pkg.statusAt).toBe("2026-07-14T10:22:45.307Z"); // 15:52:45.307000 IST
    expect(pkg.deliveryEta).toBeNull(); // deliveryDate ""
    expect(pkg.destCity).toBeNull();
  });

  it("keeps the undated LOST scan on the forward leg (scanType LT is not RT)", async () => {
    const pkg = okOutcome(await loadFixture("lost.json"), "39777010000022");
    expect(eventsOf(pkg)).toHaveLength(2);
    expect(pkg.events[1]).toEqual({
      occurredAt: null,
      description: "LOST",
      location: "Faridabad_MathuraRoad_GW (Haryana)",
      stage: "exception",
      leg: "forward",
      isSummary: false,
    });
  });
});

describe("parseDelhivery — freight (B2B, milestone-dated)", () => {
  it("turns reached undated milestones into dated events (year inferred)", async () => {
    const pkg = okOutcome(await loadFixture("freight.json"), "00000000000001");
    const milestones = eventsOf(pkg).filter((e) => !e.isSummary && e.location === null);
    expect(milestones.map((e) => [e.description, e.occurredAt, e.stage])).toEqual([
      ["Picked Up", "2026-02-24T03:45:00.000Z", "accepted"], // Tue 24 Feb, 9:15 AM IST
      ["On the Way", "2026-02-27T00:30:00.000Z", "in_transit"],
      ["Out for Delivery", "2026-03-02T05:00:00.000Z", "out_for_delivery"],
      ["Delivered", "2026-03-02T14:15:00.000Z", "delivered"],
    ]);
  });

  it("dedupes identical undated scans within one payload", async () => {
    const pkg = okOutcome(await loadFixture("freight.json"), "00000000000001");
    const transitScans = eventsOf(pkg).filter(
      (e) => e.description === "In Transit" && e.location === "Example Hub",
    );
    expect(transitScans).toHaveLength(1); // fixture repeats the row
  });

  it("skips the summary when a dated delivered event already records the delivery", async () => {
    const pkg = okOutcome(await loadFixture("freight.json"), "00000000000001");
    expect(pkg.events.some((e) => e.isSummary)).toBe(false);
    expect(pkg.stage).toBe("delivered");
    expect(pkg.terminal).toBe(true);
    expect(pkg.productType).toBe("B2B");
    expect(pkg.statusAt).toBe("2026-03-04T04:30:00.000Z");
  });
});

describe("parseDelhivery — return in transit (RETURNED flow token)", () => {
  it("falls back to hqStatus when the current status is the flow token", async () => {
    const pkg = okOutcome(await loadFixture("return-in-transit.json"), "0000000000001");
    expect(pkg.leg).toBe("return"); // statusType RT + currentFlow Returned
    expect(pkg.stage).toBe("in_transit"); // RETURNED → hqStatus "In Transit"
    expect(pkg.terminal).toBe(false);
    expect(pkg.statusText).toBe("In Transit"); // no instructions → the token
    expect(pkg.statusAt).toBe("2026-01-03T08:30:00.000Z");
  });

  it("keeps RT scans on the return leg and adds the dated summary", async () => {
    const pkg = okOutcome(await loadFixture("return-in-transit.json"), "0000000000001");
    expect(eventsOf(pkg)).toHaveLength(2);
    expect(pkg.events[0]).toMatchObject({ isSummary: true, leg: "return" });
    expect(pkg.events[1]).toMatchObject({
      description: "In Transit",
      leg: "return",
      occurredAt: null,
    });
  });
});

describe("parseDelhivery — RTO delivered (pitfall 5: delivered-to-seller)", () => {
  it("classifies a return-leg DELIVERED as returned/rto, not delivered", async () => {
    const pkg = okOutcome(await loadFixture("rto-delivered.json"), "0000000000002");
    expect(pkg.stage).toBe("returned");
    expect(pkg.terminal).toBe(true);
    expect(pkg.terminalReason).toBe("rto");
    expect(pkg.leg).toBe("return");
    expect(pkg.statusText).toBe("Delivered to sender");
    expect(pkg.statusAt).toBe("2026-02-10T06:00:00.000Z"); // 11:30:00 IST
  });

  it("reclassifies the return-leg Delivered scan and suppresses the redundant summary", async () => {
    const pkg = okOutcome(await loadFixture("rto-delivered.json"), "0000000000002");
    expect(eventsOf(pkg)).toHaveLength(2);
    expect(pkg.events[0]).toMatchObject({
      description: "In Transit",
      occurredAt: "2026-02-05T03:45:00.000Z",
      leg: "return",
      stage: "in_transit",
    });
    expect(pkg.events[1]).toMatchObject({
      description: "Delivered",
      occurredAt: "2026-02-10T06:00:00.000Z",
      leg: "return",
      stage: "returned",
    });
    expect(pkg.events.some((e) => e.isSummary)).toBe(false);
  });
});

describe("parseDelhivery — no timestamps (shallow anonymous feed)", () => {
  it("maps snake-case current tokens and keeps undated scans undated", async () => {
    const pkg = okOutcome(await loadFixture("no-timestamps.json"), "0000000000003");
    expect(pkg.stage).toBe("in_transit"); // IN_TRANSIT snake-case
    expect(pkg.statusAt).toBe("2026-10-20T01:15:00.000Z"); // 06:45:00 IST
    expect(pkg.deliveryEta).toBe("21 Oct 2026, Morning");
    expect(pkg.destCity).toBe("Chennai");
  });

  it("dedupes duplicate undated scan rows and still emits the dated summary", async () => {
    const pkg = okOutcome(await loadFixture("no-timestamps.json"), "0000000000003");
    expect(eventsOf(pkg)).toHaveLength(2);
    expect(pkg.events[0]).toMatchObject({ isSummary: true, occurredAt: "2026-10-20T01:15:00.000Z" });
    expect(pkg.events[1]).toMatchObject({ description: "In Transit", occurredAt: null });
  });
});

describe("parseDelhivery — the envelope lies (pitfalls 1 & 2)", () => {
  it("treats data [] as notFound even though the envelope says 200/200", async () => {
    const outcome = parseDelhivery(await loadFixture("invalid-awb.json"), AWB);
    expect(outcome).toEqual({
      kind: "notFound",
      message: "invalid AWB or very old package",
    });
  });

  it("identity-binds the result: feed AWB ≠ requested → schema", async () => {
    const outcome = parseDelhivery(await loadFixture("awb-mismatch.json"), AWB);
    expect(outcome.kind).toBe("schema");
    if (outcome.kind === "schema") {
      expect(outcome.message).toContain("identity mismatch");
      expect(outcome.message).toContain(AWB);
      expect(outcome.message).toContain("9999999999999");
    }
  });

  it("binds to the matching entry when data holds several shipments", async () => {
    const outcome = parseDelhivery(
      {
        statusCode: 200,
        data: [
          { awb: "9999999999999", status: { status: "LOST" }, trackingStates: [] },
          {
            awb: "55540110035405",
            status: { status: "IN_TRANSIT" },
            trackingStates: [],
          },
        ],
      },
      AWB,
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") expect(outcome.pkg.awb).toBe(AWB);
  });

  it("rejects envelopes without a data array as schema", () => {
    expect(parseDelhivery({}, AWB).kind).toBe("schema");
    expect(parseDelhivery({ data: "nope" }, AWB).kind).toBe("schema");
    expect(parseDelhivery(null, AWB).kind).toBe("schema");
  });

  it("accepts a numeric awb field (identity-bind still holds)", () => {
    const outcome = parseDelhivery(
      { statusCode: 200, data: [{ awb: 55540110035405, status: { status: "IN_TRANSIT" }, trackingStates: [] }] },
      "55540110035405",
    );
    expect(outcome.kind).toBe("ok");
  });

  it("throws InvalidAwbError for a malformed requested AWB", () => {
    expect(() => parseDelhivery({}, "12345")).toThrowError(InvalidAwbError);
  });

  it("degrades gracefully when optional blocks are missing or null", () => {
    const pkg = okOutcome(
      {
        statusCode: 200,
        data: [
          {
            awb: "55540110035405",
            hqStatus: "Reattempt Scheduled",
            trackingStates: null,
            PromiseDeliveryDate: null,
          },
        ],
      },
    );
    expect(pkg.stage).toBe("unknown"); // unmapped token → unknown, still tracked
    expect(pkg.terminal).toBe(false);
    expect(pkg.statusAt).toBeNull();
    // An undated status change is still a change: the undated summary is the
    // only signal of it (M3 must coalesce NULL occurred_at for dedupe).
    expect(pkg.events).toEqual([
      {
        occurredAt: null,
        description: "Reattempt Scheduled",
        location: null,
        stage: "unknown",
        leg: "forward",
        isSummary: true,
      },
    ]);
    expect(pkg.deliveryEta).toBeNull();
    expect(pkg.destCity).toBeNull();
    expect(pkg.leg).toBe("forward");
  });
});

describe("feedTimeToUtc", () => {
  it("treats offset-less times as Asia/Kolkata", () => {
    expect(feedTimeToUtc("2026-10-19T15:37:44")).toBe("2026-10-19T10:07:44.000Z");
  });

  it("takes explicit Z/offset times verbatim", () => {
    expect(feedTimeToUtc("2026-04-27T23:03:58Z")).toBe("2026-04-27T23:03:58.000Z");
    expect(feedTimeToUtc("2026-10-19T15:37:44+05:30")).toBe("2026-10-19T10:07:44.000Z");
    expect(feedTimeToUtc("2026-10-19T15:37:44-05:00")).toBe("2026-10-19T20:37:44.000Z");
  });

  it("keeps milliseconds, drops sub-millisecond digits", () => {
    expect(feedTimeToUtc("2026-07-14T15:52:45.307000")).toBe("2026-07-14T10:22:45.307Z");
  });

  it("returns null for empty, malformed, and impossible values", () => {
    for (const bad of [
      "",
      "   ",
      "2026-02-30T10:00:00", // impossible date (V8 would roll it to Mar 2)
      "2026-10-19T25:00:00", // impossible hour
      "2026-13-01T10:00:00", // impossible month
      "2026-10-19",
      "Sat, 29 Aug, 7:42 PM",
      "2026-10-19T15:37",
    ]) {
      expect(feedTimeToUtc(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(feedTimeToUtc(undefined)).toBeNull();
    expect(feedTimeToUtc(12345)).toBeNull();
  });
});

describe("milestoneTimeToUtc (freight, no-year dates)", () => {
  const statusAt = "2026-03-04T04:30:00.000Z";

  it("resolves the year from the status year", () => {
    expect(milestoneTimeToUtc("Tue, 24 Feb, 9:15 AM", statusAt)).toBe(
      "2026-02-24T03:45:00.000Z",
    );
  });

  it("resolves the year-1 when the status year does not match the weekday", () => {
    // 2026-02-27 is a Friday; 2025-02-27 is the Thursday the text says.
    expect(milestoneTimeToUtc("Thu, 27 Feb, 6:00 AM", statusAt)).toBe(
      "2025-02-27T00:30:00.000Z",
    );
  });

  it("handles PM times", () => {
    expect(milestoneTimeToUtc("Sat, 29 Aug, 7:42 PM", "2026-09-01T00:00:00.000Z")).toBe(
      "2026-08-29T14:12:00.000Z",
    );
  });

  it("returns null when no candidate year matches the weekday", () => {
    expect(milestoneTimeToUtc("Tue, 24 Feb, 9:15 AM", "2025-03-04T04:30:00.000Z")).toBeNull();
  });

  it("returns null when the resolved time would post-date the status", () => {
    expect(milestoneTimeToUtc("Tue, 24 Feb, 9:15 AM", "2026-02-20T04:30:00.000Z")).toBeNull();
  });

  it("returns null for impossible days and for missing pieces", () => {
    expect(milestoneTimeToUtc("Fri, 31 Feb, 6:00 AM", statusAt)).toBeNull();
    expect(milestoneTimeToUtc("not a date", statusAt)).toBeNull();
    expect(milestoneTimeToUtc("Tue, 24 Feb, 9:15 AM", null)).toBeNull();
    expect(milestoneTimeToUtc("", statusAt)).toBeNull();
  });
});
