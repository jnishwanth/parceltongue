import { describe, expect, it } from "vitest";
import type { CarrierEvent, CarrierPackage } from "../carriers/types.js";
import { openDb, type DB } from "./db.js";
import {
  activePackages,
  addPackage,
  eventsForAwb,
  getPackage,
  insertEvents,
  listPackages,
  recordPoll,
} from "./repo.js";

const AWB = "55540110035405";
const OTHER_AWB = "55540110035406";

/** Fixed UTC ISO clock values (tests never call Date.now). */
const T = {
  add: "2026-10-19T10:00:00.000Z",
  poll1: "2026-10-19T10:15:00.000Z",
  poll2: "2026-10-19T10:30:00.000Z",
  poll3: "2026-10-19T10:45:00.000Z",
};

function freshDb(): DB {
  return openDb(":memory:");
}

function pkg(over: Partial<CarrierPackage> = {}): CarrierPackage {
  return {
    awb: AWB,
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

function track(db: DB, over: Partial<CarrierPackage> = {}, now = T.add): void {
  const created = addPackage(db, pkg(over), null, now);
  if (!created) throw new Error("test setup: package should have been created");
}

describe("addPackage", () => {
  it("stores the first snapshot and returns true", () => {
    const db = freshDb();
    try {
      expect(addPackage(db, pkg(), "https://www.delhivery.com/track-v2/package/55540110035405", T.add)).toBe(true);

      const row = getPackage(db, AWB);
      expect(row).not.toBeNull();
      expect(row).toMatchObject({
        awb: AWB,
        addedAt: T.add,
        sourceLink: "https://www.delhivery.com/track-v2/package/55540110035405",
        destCity: "Bangalore",
        referenceNo: "GNPC17375",
        productType: "B2C",
        currentStage: "in_transit",
        statusText: "Shipment picked up",
        statusAt: "2026-10-19T15:37:44.000Z",
        deliveryEta: "26 Oct 2026, Evening",
        terminal: false,
        terminalReason: null,
        polls: 0,
        lastPolledAt: null,
        lastError: null,
        errorStreak: 0,
      });
    } finally {
      db.close();
    }
  });

  it("persists add-time events and a follow-up insertEvents returns 0 new", () => {
    const db = freshDb();
    try {
      const e1 = ev({ description: "Picked up" });
      const e2 = ev({ description: "In Transit", occurredAt: "2026-10-19T16:00:00.000Z" });
      const created = addPackage(db, pkg({ events: [e1, e2] }), null, T.add);
      expect(created).toBe(true);

      const rows = eventsForAwb(db, AWB);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.description).toBe("Picked up");
      expect(rows[1]!.description).toBe("In Transit");
      expect(rows[0]!.firstSeenAt).toBe(T.add);
      expect(rows[1]!.firstSeenAt).toBe(T.add);

      const fresh = insertEvents(db, AWB, [e1, e2], T.poll1);
      expect(fresh).toEqual([]);
      expect(eventsForAwb(db, AWB)).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("no-op re-add does not change event count", () => {
    const db = freshDb();
    try {
      addPackage(db, pkg({ events: [ev()] }), null, T.add);
      expect(eventsForAwb(db, AWB)).toHaveLength(1);
      const again = addPackage(db, pkg({ events: [ev({ description: "Different" })] }), null, T.poll1);
      expect(again).toBe(false);
      expect(eventsForAwb(db, AWB)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("is a no-op for an already-tracked AWB (PRD §8)", () => {
    const db = freshDb();
    try {
      track(db);
      const again = addPackage(db, pkg({ destCity: "Mumbai" }), "https://new.example", T.poll1);
      expect(again).toBe(false);
      // Original row untouched.
      expect(getPackage(db, AWB)!.destCity).toBe("Bangalore");
    } finally {
      db.close();
    }
  });

  it("honours a terminal snapshot at add time (tracking an already-delivered parcel)", () => {
    const db = freshDb();
    try {
      track(db, { stage: "delivered", terminal: true, terminalReason: "delivered" });
      expect(getPackage(db, AWB)!.terminal).toBe(true);
      expect(getPackage(db, AWB)!.terminalReason).toBe("delivered");
      expect(activePackages(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe("getPackage", () => {
  it("returns null for an untracked AWB", () => {
    const db = freshDb();
    try {
      expect(getPackage(db, "1111111111111")).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("recordPoll", () => {
  it("refreshes the snapshot on success and resets the error streak", () => {
    const db = freshDb();
    try {
      track(db);
      recordPoll(
        db,
        AWB,
        { ok: true, pkg: pkg({ stage: "out_for_delivery", statusText: "Out for delivery", statusAt: T.poll1 }) },
        T.poll1,
      );

      const row = getPackage(db, AWB)!;
      expect(row.currentStage).toBe("out_for_delivery");
      expect(row.statusText).toBe("Out for delivery");
      expect(row.statusAt).toBe(T.poll1);
      expect(row.polls).toBe(1);
      expect(row.lastPolledAt).toBe(T.poll1);
      expect(row.lastError).toBeNull();
      expect(row.errorStreak).toBe(0);
      // add-time fields survive polling.
      expect(row.addedAt).toBe(T.add);
      expect(row.destCity).toBe("Bangalore");
    } finally {
      db.close();
    }
  });

  it("notFound marks last_error but does not increment error_streak", () => {
    const db = freshDb();
    try {
      track(db);
      recordPoll(db, AWB, { ok: true, pkg: pkg() }, T.poll1);
      recordPoll(db, AWB, { ok: false, kind: "notFound", message: "invalid AWB or very old package" }, T.poll2);

      const row = getPackage(db, AWB)!;
      expect(row.currentStage).toBe("in_transit"); // unchanged
      expect(row.lastError).toBe("invalid AWB or very old package");
      expect(row.errorStreak).toBe(0);
      expect(row.polls).toBe(2);
      expect(row.lastPolledAt).toBe(T.poll2);
    } finally {
      db.close();
    }
  });

  it("auth increments error_streak and sets last_error", () => {
    const db = freshDb();
    try {
      track(db);
      recordPoll(db, AWB, { ok: false, kind: "auth", message: "401" }, T.poll1);
      recordPoll(db, AWB, { ok: false, kind: "auth", message: "401 again" }, T.poll2);
      const row = getPackage(db, AWB)!;
      expect(row.errorStreak).toBe(2);
      expect(row.lastError).toBe("401 again");
      expect(row.polls).toBe(2);
    } finally {
      db.close();
    }
  });

  it("network updates poll accounting only (leaves last_error and streak untouched)", () => {
    const db = freshDb();
    try {
      track(db);
      recordPoll(db, AWB, { ok: false, kind: "auth", message: "401" }, T.poll1);
      const afterAuth = getPackage(db, AWB)!;
      expect(afterAuth.errorStreak).toBe(1);
      expect(afterAuth.lastError).toBe("401");
      expect(afterAuth.polls).toBe(1);

      recordPoll(db, AWB, { ok: false, kind: "network", message: "timeout" }, T.poll2);
      const afterNet = getPackage(db, AWB)!;
      expect(afterNet.errorStreak).toBe(1);
      expect(afterNet.lastError).toBe("401");
      expect(afterNet.polls).toBe(2);
      expect(afterNet.lastPolledAt).toBe(T.poll2);
    } finally {
      db.close();
    }
  });

  it("accumulates the streak across auth/schema failures and resets it on success", () => {
    const db = freshDb();
    try {
      track(db);
      recordPoll(db, AWB, { ok: false, kind: "auth", message: "boom 1" }, T.poll1);
      recordPoll(db, AWB, { ok: false, kind: "schema", message: "boom 2" }, T.poll2);
      expect(getPackage(db, AWB)!.errorStreak).toBe(2);
      expect(getPackage(db, AWB)!.lastError).toBe("boom 2");

      recordPoll(db, AWB, { ok: true, pkg: pkg() }, T.poll3);
      const row = getPackage(db, AWB)!;
      expect(row.errorStreak).toBe(0);
      expect(row.lastError).toBeNull();
      expect(row.polls).toBe(3);
    } finally {
      db.close();
    }
  });

  it("applies terminal state (PRD §8: excluded from polling thereafter)", () => {
    const db = freshDb();
    try {
      track(db);
      recordPoll(
        db,
        AWB,
        {
          ok: true,
          pkg: pkg({ stage: "delivered", statusText: "Delivered", terminal: true, terminalReason: "delivered" }),
        },
        T.poll1,
      );

      const row = getPackage(db, AWB)!;
      expect(row.terminal).toBe(true);
      expect(row.terminalReason).toBe("delivered");
      expect(activePackages(db)).toHaveLength(0);
      // History is untouched by terminality.
      expect(listPackages(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe("listPackages / activePackages", () => {
  it("lists active parcels first (newest first) and terminal ones at the bottom (PRD §5 /list)", () => {
    const db = freshDb();
    try {
      track(db, { awb: "55540110000001" }, "2026-10-18T00:00:00.000Z");
      track(db, { awb: "55540110000002" }, "2026-10-19T00:00:00.000Z");
      track(
        db,
        { awb: "55540110000003", stage: "delivered", terminal: true, terminalReason: "delivered" },
        "2026-10-20T00:00:00.000Z",
      );

      expect(listPackages(db).map((r) => r.awb)).toEqual([
        "55540110000002",
        "55540110000001",
        "55540110000003",
      ]);
      expect(activePackages(db).map((r) => r.awb)).toEqual([
        "55540110000002",
        "55540110000001",
      ]);
    } finally {
      db.close();
    }
  });
});

describe("insertEvents (the cross-poll diff, PRD §7 + test plan §12.3)", () => {
  it("returns every event as new on the first poll", () => {
    const db = freshDb();
    try {
      track(db);
      const events = [
        ev(),
        ev({ occurredAt: "2026-10-19T21:12:08.000Z", location: "Mumbai_Hub (Maharashtra)" }),
      ];
      const fresh = insertEvents(db, AWB, events, T.poll1);
      expect(fresh).toEqual(events);
      expect(eventsForAwb(db, AWB)).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("re-polling the same payload yields zero new events; one added scan yields exactly one", () => {
    const db = freshDb();
    try {
      track(db);
      const payload = [ev()];
      expect(insertEvents(db, AWB, payload, T.poll1)).toHaveLength(1);

      // Same payload on the next poll (identical feed) → nothing new.
      expect(insertEvents(db, AWB, payload, T.poll2)).toEqual([]);
      expect(eventsForAwb(db, AWB)).toHaveLength(1);

      // Feed grows by one scan → exactly that one is new.
      const grown = [ev(), ev({ occurredAt: "2026-10-20T02:45:11.000Z", description: "Out for Delivery", stage: "out_for_delivery", location: "Bangalore Hub" })];
      const fresh = insertEvents(db, AWB, grown, T.poll3);
      expect(fresh).toHaveLength(1);
      expect(fresh[0]!.description).toBe("Out for Delivery");
      expect(eventsForAwb(db, AWB)).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("dedupes undated (occurred_at NULL) events — the M2-flagged UNIQUE/NULL caveat", () => {
    const db = freshDb();
    try {
      track(db);
      const undated = ev({ occurredAt: null });
      expect(insertEvents(db, AWB, [undated], T.poll1)).toHaveLength(1);
      // The anonymous feed re-sends the same undated scan every poll;
      // a plain UNIQUE would have inserted it again (NULLs are distinct).
      expect(insertEvents(db, AWB, [undated], T.poll2)).toEqual([]);
      expect(eventsForAwb(db, AWB)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("dedupes location-less events (location NULL) the same way", () => {
    const db = freshDb();
    try {
      track(db);
      const noLocation = ev({ location: null, occurredAt: "2026-10-19T21:12:08.000Z" });
      expect(insertEvents(db, AWB, [noLocation], T.poll1)).toHaveLength(1);
      expect(insertEvents(db, AWB, [noLocation], T.poll2)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("treats each dedupe-key component as significant", () => {
    const db = freshDb();
    try {
      track(db);
      const base = ev();
      expect(insertEvents(db, AWB, [base], T.poll1)).toHaveLength(1);

      // Same description+time, different location / time / description / leg → new.
      expect(insertEvents(db, AWB, [ev({ location: "Mumbai_Hub (Maharashtra)" })], T.poll2)).toHaveLength(1);
      expect(insertEvents(db, AWB, [ev({ occurredAt: "2026-10-20T00:00:00.000Z" })], T.poll2)).toHaveLength(1);
      expect(insertEvents(db, AWB, [ev({ description: "Out for Delivery" })], T.poll2)).toHaveLength(1);
      expect(insertEvents(db, AWB, [ev({ leg: "return" })], T.poll2)).toHaveLength(1);
      // …but the exact same one again → not new.
      expect(insertEvents(db, AWB, [base], T.poll3)).toHaveLength(0);
      expect(eventsForAwb(db, AWB)).toHaveLength(5);
    } finally {
      db.close();
    }
  });

  it("stamps first_seen_at per poll and rounds trip the flags", () => {
    const db = freshDb();
    try {
      track(db);
      const summary = ev({ isSummary: true, description: "Shipment picked up", stage: "accepted" });
      insertEvents(db, AWB, [summary], T.poll1);
      insertEvents(db, AWB, [ev()], T.poll2);

      const rows = eventsForAwb(db, AWB);
      expect(rows[0]!.firstSeenAt).toBe(T.poll1);
      expect(rows[0]!.isSummary).toBe(true);
      expect(rows[0]!.stage).toBe("accepted");
      expect(rows[1]!.firstSeenAt).toBe(T.poll2);
      expect(rows[1]!.isSummary).toBe(false);
      expect(rows[1]!.leg).toBe("forward");
    } finally {
      db.close();
    }
  });

  it("rejects events for an untracked AWB (loud, not silently ignored)", () => {
    const db = freshDb();
    try {
      expect(() => insertEvents(db, "9999999999999", [ev()], T.poll1)).toThrow(/not a tracked parcel/);
    } finally {
      db.close();
    }
  });
});

describe("eventsForAwb", () => {
  it("orders by first-seen time, then insertion order, and filters by AWB", () => {
    const db = freshDb();
    try {
      track(db);
      track(db, { awb: OTHER_AWB }, T.add);

      // First poll for AWB: two scans + one summary, in this input order.
      insertEvents(
        db,
        AWB,
        [
          ev({ description: "In Transit", occurredAt: "2026-10-19T21:12:08.000Z" }),
          ev({ description: "Shipment picked up", stage: "accepted", isSummary: true, occurredAt: "2026-10-19T15:37:44.000Z" }),
          ev({ description: "Manifested", stage: "registered", occurredAt: null }),
        ],
        T.poll1,
      );
      // Next poll adds one more (later first_seen_at → sorts last).
      insertEvents(db, AWB, [ev({ description: "Out for Delivery", stage: "out_for_delivery", occurredAt: "2026-10-20T02:45:11.000Z" })], T.poll2);
      // A different parcel's events must not leak in.
      insertEvents(db, OTHER_AWB, [ev({ description: "Somewhere else" })], T.poll1);

      const rows = eventsForAwb(db, AWB);
      expect(rows).toHaveLength(4);
      expect(rows.map((r) => r.description)).toEqual([
        "In Transit",
        "Shipment picked up",
        "Manifested",
        "Out for Delivery",
      ]);
      expect(rows.map((r) => r.awb)).toEqual([AWB, AWB, AWB, AWB]);
    } finally {
      db.close();
    }
  });

  it("returns an empty list for a tracked parcel with no events yet", () => {
    const db = freshDb();
    try {
      track(db);
      expect(eventsForAwb(db, AWB)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
