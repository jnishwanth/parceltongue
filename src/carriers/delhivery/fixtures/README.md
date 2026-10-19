# Delhivery fixtures — provenance

Recorded/shaped responses of
`GET https://dlv-api.delhivery.com/v3/unified-tracking-new?wbn=<AWB>`.
Tests load these files; they are the offline stand-in for the endpoint
(AGENTS.md: tests never touch the network).

No real PII is stored: names, addresses, references and remarks are
placeholders. AWBs marked `synthetic values` are fake; the others were
observed live.

| File | Provenance |
|---|---|
| `in-transit.json` | Field names & values from the live capture of 2026-10-19 in PRD §4.2 (AWB `55540110035405`), extended with a second dated scan for multi-state coverage. |
| `delivered.json` | Real field shape (confirmed live by prior art, plhery/universal-parcel-scraper), synthetic values. Exercises: `statusType: "DL"`, `scanType: "DL"`, empty scan times, `addressInfo` without `city`, a state with no `scans` key. |
| `freight.json` | Real field shape (prior art), synthetic values. B2B freight: milestone `label`+`date` (no year), `scans: null` pickup, all scan times empty, `currentTrackIndex`. |
| `return-in-transit.json` | Real field shape (prior art), synthetic values. Exercises the `RETURNED` flow token (current status is a flow, not a state) + `statusType: "RT"` scans while still in transit. |
| `lost.json` | Verbatim live capture (2026-08-24) via ha-parcel-integrations/ha-delhivery tests, redactions preserved. Exercises: `currentFlow: "Closed"`, `scanType: "LT"`, 6-digit fractional status time, all scan times empty, `deliveryDate: ""`. |
| `rto-delivered.json` | **Synthesized** — no public fixture for the delivered-to-seller case exists. Modeled on the observed return-leg shapes (`statusType: "RT"`, `scanType: "RT"`, `currentFlow: "Returned"`). Exercises PRD §4.3 pitfall 5: `DELIVERED` on the return leg must classify as `returned`/`rto`, not `delivered`. |
| `invalid-awb.json` | Verbatim control-tested envelope (bogus AWB): HTTP 200 + `statusCode: 200` with `data: []`. Exercises pitfall 1 — the envelope lies. |
| `no-timestamps.json` | **Synthesized**, modeled on the lost capture's empty scan times. Exercises: snake-case current token `IN_TRANSIT`, all-empty scan times, duplicate undated scan rows (in-payload dedupe). |
| `awb-mismatch.json` | **Synthesized**, minimal. Exercises pitfall 2 — identity-bind before use. |
