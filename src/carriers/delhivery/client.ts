/**
 * Minimal HTTP client for Delhivery's public consumer tracking feed
 * (PRD §4.1). Keyless; the website's Origin/Referer headers are what make
 * the endpoint answer at all — without them it replies 401, which means our
 * front door went stale, not a per-parcel problem (PRD §4.3 pitfall 6).
 *
 * The client is transport-only: it returns the parsed JSON envelope as
 * `unknown` (shape-checked by `parse.ts`) and raises typed errors for
 * conditions that are not about a specific parcel. It never branches on
 * HTTP status or `statusCode` as a hit signal (pitfall 1) — that is the
 * parser's job on the envelope's `data` field.
 */

export const DELHIVERY_ENDPOINT = "https://dlv-api.delhivery.com/v3/unified-tracking-new";

/** ALL three headers are required — 401 without Origin/Referer (PRD §4.1). */
export const DELHIVERY_HEADERS: Record<string, string> = {
  Origin: "https://www.delhivery.com",
  Referer: "https://www.delhivery.com/",
  Accept: "application/json",
};

export const DEFAULT_TIMEOUT_MS = 15_000; // PRD §8
export const MAX_BODY_BYTES = 1_048_576; // PRD §8

/** Delhivery answered 401: our front-door headers are stale (pitfall 6). */
export class DelhiveryAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelhiveryAuthError";
  }
}

/** Transport-level failure: timeout, DNS, HTTP >= 400 (non-401), oversize or non-JSON body. */
export class DelhiveryTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelhiveryTransportError";
  }
}

/** A waybill number that is not 13–14 digits (PRD §4.1). */
export class InvalidAwbError extends Error {
  constructor(value: string) {
    super(
      `invalid Delhivery waybill: ${JSON.stringify(value)} (expected 13-14 digits)`,
    );
    this.name = "InvalidAwbError";
  }
}

/** Strip spaces/dashes/dots; a waybill is 13–14 digits. Throws InvalidAwbError otherwise. */
export function normalizeAwb(raw: string): string {
  const number = raw.replace(/[\s.-]/g, "");
  if (!/^\d{13,14}$/.test(number)) throw new InvalidAwbError(raw);
  return number;
}

export interface DelhiveryClientOptions {
  /** Injectable for tests — tests must never touch the network. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
}

export interface DelhiveryClient {
  /**
   * Fetch the tracking envelope for an AWB.
   * @throws {InvalidAwbError} malformed waybill (checked before any request)
   * @throws {DelhiveryAuthError} HTTP 401 — front door stale
   * @throws {DelhiveryTransportError} timeout / HTTP >= 400 / oversize / non-JSON
   */
  get(awb: string): Promise<unknown>;
}

export function createDelhiveryClient(
  options: DelhiveryClientOptions = {},
): DelhiveryClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = options.baseUrl ?? DELHIVERY_ENDPOINT;

  return {
    async get(awb: string): Promise<unknown> {
      const number = normalizeAwb(awb);
      const url = `${baseUrl}?wbn=${number}`;

      let res: Response;
      try {
        res = await fetchImpl(url, {
          headers: DELHIVERY_HEADERS,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new DelhiveryTransportError(`request failed: ${describeError(err)}`);
      }

      if (res.status === 401) {
        throw new DelhiveryAuthError(
          "HTTP 401: tracking front door is stale (Origin/Referer changed?)",
        );
      }
      if (!res.ok) {
        throw new DelhiveryTransportError(`HTTP ${res.status}`);
      }

      const contentLength = Number(res.headers.get("content-length"));
      if (Number.isInteger(contentLength) && contentLength > MAX_BODY_BYTES) {
        throw new DelhiveryTransportError(
          `response too large (${contentLength} bytes > ${MAX_BODY_BYTES})`,
        );
      }

      let text: string;
      try {
        text = await readTextWithByteCap(res, MAX_BODY_BYTES);
      } catch (err) {
        if (err instanceof DelhiveryTransportError) throw err;
        throw new DelhiveryTransportError(`body read failed: ${describeError(err)}`);
      }
      if (text.length > MAX_BODY_BYTES) {
        throw new DelhiveryTransportError(
          `response too large (${text.length} bytes > ${MAX_BODY_BYTES})`,
        );
      }

      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new DelhiveryTransportError("response body is not JSON");
      }
    },
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * Read the body as text, aborting the download the moment the accumulated
 * UTF-8 byte count exceeds `maxBytes` — the cap must bound the download
 * itself, not just the assembled string (whose length is UTF-16 code units,
 * not bytes).
 */
async function readTextWithByteCap(res: Response, maxBytes: number): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new DelhiveryTransportError(
        `response too large (${total} bytes > ${maxBytes})`,
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
