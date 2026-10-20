/**
 * Delhivery adapter — the only face the rest of the app sees
 * (AGENTS.md carrier boundary). Composes the HTTP client with the parser
 * and reports feed/transport failures as `CarrierResult` kinds instead of
 * thrown errors. The only throw is `InvalidAwbError` for a malformed
 * waybill — a caller contract violation.
 */
import type { CarrierAdapter, CarrierResult } from "../types.js";
import {
  createDelhiveryClient,
  DelhiveryAuthError,
  DelhiveryTransportError,
  type DelhiveryClientOptions,
} from "./client.js";
import { parseDelhivery } from "./parse.js";

export function createDelhiveryAdapter(
  options: DelhiveryClientOptions = {},
): CarrierAdapter {
  const client = createDelhiveryClient(options);
  return {
    name: "delhivery",
    async track(awb: string): Promise<CarrierResult> {
      let payload: unknown;
      try {
        payload = await client.get(awb);
      } catch (err) {
        if (err instanceof DelhiveryAuthError) {
          return { kind: "auth", message: err.message };
        }
        if (err instanceof DelhiveryTransportError) {
          return { kind: "network", message: err.message };
        }
        throw err; // InvalidAwbError or a bug — surface it
      }

      const outcome = parseDelhivery(payload, awb);
      switch (outcome.kind) {
        case "ok":
          return { kind: "ok", pkg: outcome.pkg };
        case "notFound":
          return { kind: "notFound", message: outcome.message };
        case "schema":
          return { kind: "schema", message: outcome.message };
      }
    },
  };
}

/** Default adapter wired to the real endpoint (Node's built-in fetch). */
export const delhiveryAdapter: CarrierAdapter = createDelhiveryAdapter();
