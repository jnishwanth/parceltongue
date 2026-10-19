/**
 * M2 smoke tool — `pnpm live <awb>`.
 *
 * Hits the real Delhivery endpoint through the real adapter and prints the
 * normalized result as JSON. No config or Telegram involvement.
 *
 * Exit codes: 0 = ok, 1 = track failed (notFound/auth/network/schema),
 * 2 = bad usage / invalid AWB. This file is a CLI, not the app's log path,
 * so plain stdout/stderr is the interface (AGENTS.md logging rules apply to
 * the app, not to this tool).
 */
import { InvalidAwbError } from "./carriers/delhivery/client.js";
import { delhiveryAdapter } from "./carriers/delhivery/index.js";

const arg = process.argv[2];
if (arg === undefined || arg.trim() === "") {
  console.error("usage: pnpm live <awb>");
  process.exit(2);
}

try {
  const result = await delhiveryAdapter.track(arg);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.kind === "ok" ? 0 : 1);
} catch (err) {
  if (err instanceof InvalidAwbError) {
    console.error(err.message);
    process.exit(2);
  }
  throw err;
}
