import { describe, expect, it } from "vitest";
import {
  createDelhiveryClient,
  DELHIVERY_ENDPOINT,
  DelhiveryAuthError,
  DelhiveryTransportError,
  InvalidAwbError,
  MAX_BODY_BYTES,
  normalizeAwb,
} from "./client.js";

interface FakeFetch {
  impl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response): FakeFetch {
  const calls: FakeFetch["calls"] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init: init ?? undefined });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const OK_BODY = { statusCode: 200, message: "Success", data: [] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("normalizeAwb", () => {
  it("accepts 13- and 14-digit waybills, stripping separators", () => {
    expect(normalizeAwb("55540110035405")).toBe("55540110035405");
    expect(normalizeAwb("5554 0110 0354 05")).toBe("55540110035405");
    expect(normalizeAwb("5554-0110-0354-05")).toBe("55540110035405");
    expect(normalizeAwb("  5554.0110.0354.05  ")).toBe("55540110035405");
    expect(normalizeAwb("1623110010010")).toBe("1623110010010");
  });

  it("rejects 12/15-digit and non-digit numbers", () => {
    for (const bad of ["123456789012", "123456789012345", "5554011003540a", "abc", ""]) {
      expect(() => normalizeAwb(bad), JSON.stringify(bad)).toThrowError(InvalidAwbError);
    }
  });
});

describe("createDelhiveryClient", () => {
  it("requests the unified-tracking endpoint with the waybill as wbn", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(OK_BODY));
    await createDelhiveryClient({ fetchImpl: impl }).get("55540110035405");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${DELHIVERY_ENDPOINT}?wbn=55540110035405`);
  });

  it("sends ALL required front-door headers (401 without Origin/Referer)", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(OK_BODY));
    await createDelhiveryClient({ fetchImpl: impl }).get("55540110035405");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Origin).toBe("https://www.delhivery.com");
    expect(headers.Referer).toBe("https://www.delhivery.com/");
    expect(headers.Accept).toBe("application/json");
  });

  it("passes an AbortSignal so the request cannot hang past the timeout", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(OK_BODY));
    const client = createDelhiveryClient({ fetchImpl: impl, timeoutMs: 20 });
    await client.get("55540110035405");
    const signal = calls[0]?.init?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    const aborted = await Promise.race([
      new Promise<boolean>((resolve) =>
        signal!.addEventListener("abort", () => resolve(true), { once: true }),
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(!signal!.aborted), 200)),
    ]);
    expect(aborted).toBe(true);
  });

  it("returns the parsed JSON envelope untouched (no hit/miss branching here)", async () => {
    const { impl } = fakeFetch(() => jsonResponse(OK_BODY));
    const payload = await createDelhiveryClient({ fetchImpl: impl }).get("55540110035405");
    expect(payload).toEqual(OK_BODY);
  });

  it("normalizes the waybill before building the URL", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(OK_BODY));
    await createDelhiveryClient({ fetchImpl: impl }).get("5554-0110-0354-05");
    expect(calls[0]?.url).toBe(`${DELHIVERY_ENDPOINT}?wbn=55540110035405`);
  });

  it("maps HTTP 401 to DelhiveryAuthError (stale front door, not per-parcel)", async () => {
    const { impl } = fakeFetch(() => new Response("unauthorized", { status: 401 }));
    const client = createDelhiveryClient({ fetchImpl: impl });
    await expect(client.get("55540110035405")).rejects.toThrowError(DelhiveryAuthError);
  });

  it("maps other HTTP error statuses to DelhiveryTransportError", async () => {
    for (const status of [500, 502, 404]) {
      const { impl } = fakeFetch(() => new Response("boom", { status }));
      const client = createDelhiveryClient({ fetchImpl: impl });
      await expect(client.get("55540110035405"), `status ${status}`).rejects.toThrowError(
        new RegExp(`HTTP ${status}`),
      );
    }
  });

  it("maps a fetch-level failure (DNS/connection/timeout) to DelhiveryTransportError", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const client = createDelhiveryClient({ fetchImpl: impl });
    await expect(client.get("55540110035405")).rejects.toThrowError(DelhiveryTransportError);
  });

  it("rejects bodies larger than 1 MB", async () => {
    const { impl } = fakeFetch(
      () => new Response("x".repeat(MAX_BODY_BYTES + 1), { status: 200 }),
    );
    const client = createDelhiveryClient({ fetchImpl: impl });
    await expect(client.get("55540110035405")).rejects.toThrowError(/too large/);
  });

  it("accepts a JSON body of exactly 1 MB", async () => {
    const prefix = '{"message":"';
    const suffix = '","statusCode":200,"data":[]}';
    const body = prefix + "x".repeat(MAX_BODY_BYTES - prefix.length - suffix.length) + suffix;
    expect(body.length).toBe(MAX_BODY_BYTES);
    const { impl } = fakeFetch(() => new Response(body, { status: 200 }));
    const client = createDelhiveryClient({ fetchImpl: impl });
    await expect(client.get("55540110035405")).resolves.toMatchObject({ data: [] });
  });

  it("rejects non-JSON bodies", async () => {
    const { impl } = fakeFetch(() => new Response("<html>not json</html>", { status: 200 }));
    const client = createDelhiveryClient({ fetchImpl: impl });
    await expect(client.get("55540110035405")).rejects.toThrowError(/not JSON/);
  });

  it("rejects an invalid AWB before making any request", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(OK_BODY));
    const client = createDelhiveryClient({ fetchImpl: impl });
    await expect(client.get("12345")).rejects.toThrowError(InvalidAwbError);
    expect(calls).toHaveLength(0);
  });
});
