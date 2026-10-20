# Notify fixtures — provenance

Expected Telegram text (MarkdownV2) for `src/notify/format.ts`, pinned by
`format.test.ts`. These are the M5 output: the snapshot / update /
terminal message fixtures (plus the two alert kinds of the
`PollNotification` union).

Inputs are the M2 carrier fixtures run through the real
`parseDelhivery` (no network — AGENTS.md), with the poller's
`PollNotification` rows assembled the way M4's loop assembles them.
`NOW` in the tests is fixed at `2026-10-20T12:00:00Z`, so all fixture
inputs (2026) render without a year.

| File | Input | Provenance |
|---|---|---|
| `snapshot-in-transit.txt` | `carriers/delhivery/fixtures/in-transit.json` → `formatSnapshot` | Add-time snapshot for the PRD §4.2 live-capture AWB `55540110035405`. Mirrors the PRD §5 snapshot example; the stage line is the *normalized* stage (`Picked Up` — the fixture's current token is `PICKUP`), where the PRD hand-drew the `hqStatus` prose. |
| `update-bundled.txt` | hand-built `update` notification (2 events) → `formatUpdateMessage` | **Synthesized** to mirror the PRD §5 passive-update example (same AWB, times, cities, ETA); the event descriptions are the feed's own scan labels, not the PRD's illustrative "— new hub" suffix. |
| `terminal-delivered.txt` | `delivered.json` → `formatTerminalMessage` (reason `delivered`) | New events = the parsed package's first two events (the dated status summary + the undated delivered scan). Pins: 6-digit fractional status time, undated scan, the raw-token summary description (`DELIVERED`). |
| `terminal-rto.txt` | `rto-delivered.json` → `formatTerminalMessage` (reason `rto`) | New events = both return-leg scans. Pins PRD §4.3 pitfall 5 (delivered-on-return = RTO) and MarkdownV2 escaping of `_` and `()` in locations. |
| `terminal-lost.txt` | `lost.json` (verbatim 2026-08-24 live capture) → `formatTerminalMessage` (reason `lost`) | New events = the status summary + the undated `LOST` scan. Pins `currentFlow: "Closed"` handling and escaping of the GW location. |
| `endpoint-broken.txt` | `endpointBroken` notification (streak 3, pause 1 h) → `formatEndpointBrokenMessage` | The once-per-episode "endpoint looks broken — pausing" alert (PRD §8, pitfall 6). |
| `not-found.txt` | `notFound` notification → `formatNotFoundMessage` | The once-per-episode "invalid AWB or very old package" tell (PRD §8). |
