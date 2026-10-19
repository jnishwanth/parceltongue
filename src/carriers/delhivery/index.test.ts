import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CarrierResult } from "../types.js";
import { InvalidAwbError } from "./client.js";
import { createDelhiveryAdapter } from "./index.js";

function fakeFetch(body: unknown, status = 200) {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

async function loadFixture(name: string): Promise<unknown> {
  const raw = await readFile(
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    "utf8",
  );
  return JSON.parse(raw) as unknown;
}

describe("createDelhiveryAdapter", () => {
  it("is named delhivery and returns ok with an identity-bound package", async () => {
    const adapter = createDelhiveryAdapter({ fetchImpl: fakeFetch(await loadFixture("in-transit.json")) });
    expect(adapter.name).toBe("delhivery");
    const result = await adapter.track("55540110035405");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.pkg.awb).toBe("55540110035405");
      expect(result.pkg.stage).toBe("accepted");
    }
  });

  it("maps an empty-data envelope to notFound (the envelope lies)", async () => {
    const adapter = createDelhiveryAdapter({ fetchImpl: fakeFetch(await loadFixture("invalid-awb.json")) });
    const result: CarrierResult = await adapter.track("55540110035405");
    expect(result).toEqual({ kind: "notFound", message: "invalid AWB or very old package" });
  });

  it("maps HTTP 401 to auth (stale front door, not per-parcel)", async () => {
    const adapter = createDelhiveryAdapter({ fetchImpl: fakeFetch({}, 401) });
    const result = await adapter.track("55540110035405");
    expect(result.kind).toBe("auth");
    if (result.kind === "auth") expect(result.message).toContain("401");
  });

  it("maps transport failures to network", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const adapter = createDelhiveryAdapter({ fetchImpl: impl });
    const result = await adapter.track("55540110035405");
    expect(result.kind).toBe("network");
    if (result.kind === "network") expect(result.message).toContain("fetch failed");
  });

  it("maps a malformed envelope to schema", async () => {
    const adapter = createDelhiveryAdapter({ fetchImpl: fakeFetch({ statusCode: 200, data: "nope" }) });
    const result = await adapter.track("55540110035405");
    expect(result.kind).toBe("schema");
  });

  it("maps an identity mismatch to schema", async () => {
    const adapter = createDelhiveryAdapter({ fetchImpl: fakeFetch(await loadFixture("awb-mismatch.json")) });
    const result = await adapter.track("55540110035405");
    expect(result.kind).toBe("schema");
  });

  it("rejects a malformed AWB without touching the network", async () => {
    let called = false;
    const impl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const adapter = createDelhiveryAdapter({ fetchImpl: impl });
    await expect(adapter.track("12345")).rejects.toThrowError(InvalidAwbError);
    expect(called).toBe(false);
  });
});
