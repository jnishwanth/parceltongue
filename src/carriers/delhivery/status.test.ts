import { describe, expect, it } from "vitest";
import type { Stage, TerminalReason } from "../types.js";
import {
  classifyStatus,
  FLOW_TOKEN,
  isTerminalStage,
  normalizeStatusToken,
  withReturnLegOverride,
} from "./status.js";

/** Every PRD §4.4 token, in the word and snake-case forms it is observed in. */
const MAPPED: Array<[token: string, stage: Stage]> = [
  ["MANIFESTED", "registered"],
  ["Picked Up", "accepted"],
  ["PICKUP", "accepted"],
  ["IN TRANSIT", "in_transit"],
  ["IN_TRANSIT", "in_transit"],
  ["ON THE WAY", "in_transit"],
  ["ON_THE_WAY", "in_transit"],
  ["IN TRANSIT FOR RETURN", "in_transit"],
  ["IN_TRANSIT_FOR_RETURN", "in_transit"],
  ["DISPATCHED", "out_for_delivery"],
  ["OUT FOR DELIVERY", "out_for_delivery"],
  ["OUT_FOR_DELIVERY", "out_for_delivery"],
  ["DELIVERED", "delivered"],
  ["RTO DELIVERED", "returned"],
  ["RTO_DELIVERED", "returned"],
  ["DELIVERED SELLER", "returned"],
  ["DELIVERED_SELLER", "returned"],
  ["RTO", "returned"],
  ["DTO", "returned"],
  ["LOST", "exception"],
  ["CANCELLED", "exception"],
  ["CANCELED", "exception"],
];

const REASONS: Record<string, TerminalReason> = {
  DELIVERED: "delivered",
  "RTO DELIVERED": "rto",
  "DELIVERED SELLER": "rto",
  RTO: "rto",
  DTO: "rto",
  LOST: "lost",
  CANCELLED: "cancelled",
  CANCELED: "cancelled",
};

describe("classifyStatus", () => {
  it.each(MAPPED)("maps %s → %s", (token, stage) => {
    expect(classifyStatus(token).stage).toBe(stage);
  });

  it("is case-insensitive and trims", () => {
    expect(classifyStatus("  in transit  ").stage).toBe("in_transit");
    expect(classifyStatus("delivered").stage).toBe("delivered");
  });

  it("marks terminal tokens with the right reason", () => {
    for (const [token] of MAPPED) {
      const c = classifyStatus(token);
      const reason = REASONS[token.toUpperCase().replaceAll("_", " ")];
      if (reason !== undefined) {
        expect(c.terminal, token).toBe(true);
        expect(c.terminalReason, token).toBe(reason);
      } else {
        expect(c.terminal, token).toBe(false);
        expect(c.terminalReason, token).toBeNull();
      }
    }
  });

  it("falls through unknown tokens to unknown (still stored & notified)", () => {
    for (const token of ["Reattempt Scheduled", "ATTEMPT FAILED", "OUT FOR PICKUP", ""]) {
      const c = classifyStatus(token);
      expect(c.stage).toBe("unknown");
      expect(c.terminal).toBe(false);
      expect(c.terminalReason).toBeNull();
    }
  });
});

describe("normalizeStatusToken", () => {
  it("uppercases, underscores → spaces, trims", () => {
    expect(normalizeStatusToken("in_transit")).toBe("IN TRANSIT");
    expect(normalizeStatusToken("  DELIVERED_SELLER ")).toBe("DELIVERED SELLER");
  });

  it("exposes the flow token used by the parser fallback", () => {
    expect(normalizeStatusToken(FLOW_TOKEN)).toBe("RETURNED");
  });
});

describe("withReturnLegOverride", () => {
  it("turns a return-leg DELIVERED into delivered-to-seller (pitfall 5)", () => {
    const c = withReturnLegOverride(classifyStatus("DELIVERED"), "return");
    expect(c).toEqual({ stage: "returned", terminal: true, terminalReason: "rto" });
  });

  it("leaves forward-leg DELIVERED alone", () => {
    expect(withReturnLegOverride(classifyStatus("DELIVERED"), "forward").stage).toBe(
      "delivered",
    );
  });

  it("leaves non-delivered stages alone on either leg", () => {
    expect(withReturnLegOverride(classifyStatus("IN TRANSIT"), "return").stage).toBe(
      "in_transit",
    );
    expect(withReturnLegOverride(classifyStatus("LOST"), "return").stage).toBe("exception");
  });
});

describe("isTerminalStage", () => {
  it("covers exactly delivered/returned/exception", () => {
    expect(isTerminalStage("delivered")).toBe(true);
    expect(isTerminalStage("returned")).toBe(true);
    expect(isTerminalStage("exception")).toBe(true);
    for (const stage of [
      "registered",
      "accepted",
      "in_transit",
      "out_for_delivery",
      "unknown",
    ] satisfies Stage[]) {
      expect(isTerminalStage(stage)).toBe(false);
    }
  });
});
