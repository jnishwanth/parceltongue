/**
 * Delhivery status token → stage classification (PRD §4.4).
 *
 * Tokens arrive both as words ("In Transit") and as snake-case
 * ("IN_TRANSIT"); the classifier normalizes with
 * `toUpperCase().replaceAll("_", " ")`. Unknown tokens fall through to
 * `unknown` — they are still stored & notified, flagged as unmapped
 * (PRD §4.4).
 */
import type { Stage, TerminalReason } from "../types.js";

interface StatusDef {
  stage: Stage;
  /** Set only when the stage is terminal; the value recorded as `terminal_reason`. */
  terminalReason?: TerminalReason;
}

const STATUSES: Record<string, StatusDef> = {
  MANIFESTED: { stage: "registered" },
  "PICKED UP": { stage: "accepted" },
  PICKUP: { stage: "accepted" },
  "IN TRANSIT": { stage: "in_transit" },
  "ON THE WAY": { stage: "in_transit" },
  "IN TRANSIT FOR RETURN": { stage: "in_transit" },
  DISPATCHED: { stage: "out_for_delivery" },
  "OUT FOR DELIVERY": { stage: "out_for_delivery" },
  DELIVERED: { stage: "delivered", terminalReason: "delivered" },
  "RTO DELIVERED": { stage: "returned", terminalReason: "rto" },
  "DELIVERED SELLER": { stage: "returned", terminalReason: "rto" },
  RTO: { stage: "returned", terminalReason: "rto" },
  DTO: { stage: "returned", terminalReason: "rto" },
  LOST: { stage: "exception", terminalReason: "lost" },
  CANCELLED: { stage: "exception", terminalReason: "cancelled" },
  CANCELED: { stage: "exception", terminalReason: "cancelled" },
};

/**
 * A status token that names a flow (the parcel is on its way back to the
 * sender) rather than a movement state. The parser falls back to `hqStatus`
 * when the current status is this.
 */
export const FLOW_TOKEN = "RETURNED";

export function normalizeStatusToken(value: string): string {
  return value.toUpperCase().replaceAll("_", " ").trim();
}

export interface Classification {
  stage: Stage;
  terminal: boolean;
  terminalReason: TerminalReason | null;
}

/** Classify a raw status token. Unknown tokens → `unknown` (PRD §4.4). */
export function classifyStatus(value: string): Classification {
  const def = STATUSES[normalizeStatusToken(value)];
  if (def === undefined) {
    return { stage: "unknown", terminal: false, terminalReason: null };
  }
  return {
    stage: def.stage,
    terminal: def.terminalReason !== undefined,
    terminalReason: def.terminalReason ?? null,
  };
}

/** A "Delivered" scan on the return leg means delivered-to-seller (PRD §4.3 pitfall 5). */
export function withReturnLegOverride(
  classification: Classification,
  leg: "forward" | "return",
): Classification {
  if (leg === "return" && classification.stage === "delivered") {
    return { stage: "returned", terminal: true, terminalReason: "rto" };
  }
  return classification;
}
