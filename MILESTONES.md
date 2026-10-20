# MILESTONES — ParcelTongue

Single source of truth for "what's next". One milestone at a time, top to
bottom. Definitions come from PRD §11; this file tracks execution.

Status legend: ✅ done · 🔜 in progress · ⬜ pending

## Status

| #  | Milestone                                                                        | Status       | Done       | Evidence / notes |
|----|----------------------------------------------------------------------------------|--------------|------------|------------------|
| M1 | Scaffold: TS project, config, pino, lint, vitest                                 | ✅ done        | 2026-10-19 | Fresh `pnpm install` clean; typecheck+lint+9/9 tests green; `pnpm dev` boots (exits after boot log — keep-alive comes with M6); config error path exits 1 with all problems listed |
| M2 | **Delhivery adapter: client + parse + status map + fixtures + unit tests**       | ✅ done        | 2026-10-20 | `pnpm live 55540110035405` → real endpoint returned `kind: ok` (stage in_transit, IST→UTC with ms, shallow feed as documented); bogus AWB → `notFound`/exit 1; typecheck+lint+97/97 tests green; 10 fixtures w/ provenance README |
| M3 | DB: schema, repo, migrations                                                      | ⬜ pending   | —          | Output: insert/diff queries tested against temp DB |
| M4 | Poller: tick loop, jitter, backoff, terminal handling                             | ⬜ pending   | —          | Output: pollable with fake adapter; streak-alert path tested |
| M5 | Notify: diff + message formatting                                                 | ⬜ pending   | —          | Output: snapshot / update / terminal message fixtures |
| M6 | Bot: grammY, whitelist, all 6 commands                                            | ⬜ pending   | —          | Output: add/list/status/remove via real Telegram |
| M7 | Dockerfile + compose + README (BotFather walkthrough)                             | ⬜ pending   | —          | Output: one-command deploy |
| M8 | E2E soak: track 2–3 real parcels through delivery; tune message noise            | ⬜ pending   | —          | Ongoing. PRD §5 flows verified in the owner's chat |

## Log

<!-- Newest entry first. Each entry: date, milestone, what shipped, evidence
     (test/typecheck/lint results, key commands), anything deferred. -->

### 2026-10-20 — M2 done: Delhivery adapter

- **Shipped:** `src/carriers/types.ts` (carrier-agnostic contract:
  `Stage`/`Leg`/`TerminalReason`, `CarrierEvent`, `CarrierPackage`,
  `CarrierResult` union `ok|notFound|auth|network|schema`, `CarrierAdapter`);
  `src/carriers/delhivery/` — `status.ts` (§4.4 token→stage map, normalize
  `toUpperCase().replaceAll("_"," ")`, unknown fallback, terminal reasons,
  return-leg override), `client.ts` (GET with the 3 required front-door
  headers, 15 s `AbortSignal.timeout`, 1 MB cap, injectable fetch, typed
  `DelhiveryAuthError`/`DelhiveryTransportError`/`InvalidAwbError`,
  `normalizeAwb` 13–14 digits), `parse.ts` (envelope→package: hit signal =
  `data` non-empty only, identity-bind, IST→UTC with 6-digit fractionals,
  per-scan + per-package leg, `RETURNED`→`hqStatus` fallback, freight
  milestone year inference, in-payload dedupe, summary-event rule),
  `index.ts` (`delhiveryAdapter`); 10 fixtures + provenance `README.md`
  (in-transit from the PRD §4.2 live capture; lost = verbatim 2026-08-24
  live capture; delivered/freight/return-in-transit real shapes from prior
  art; invalid-awb verbatim; rto-delivered/no-timestamps/awb-mismatch/
  customer-return synthesized); `src/live.ts` + `live` script (the M2
  output); 4 test files (88 new tests).
- **Evidence:** `pnpm typecheck` / `pnpm lint` / `pnpm test` all green
  (97/97). Live smoke on the real endpoint, 2026-10-20:
  `pnpm live 55540110035405` → `kind: ok`, stage `in_transit` (live token
  `IN_TRANSIT` snake-case), `statusAt 2026-10-19T16:25:52.989Z` (IST→UTC
  with real milliseconds), ETA `26 Oct 2026, Evening`, destCity Bangalore,
  1 undated scan (`Delhi_Airport_GW`) + dated summary — anonymous feed
  shallow exactly as PRD §4.3 pitfall 4 warns; exit 0.
  `pnpm live 1234567890123` → `kind: notFound`, message
  `invalid AWB or very old package`; exit 1. No 401 → front-door headers
  current.
- **Decisions:**
  - `index.ts` added beyond the PRD tree: the `CarrierAdapter`
    implementation has to live somewhere; client/parse stay transport and
    parsing respectively.
  - `events.location` prefers `scannedLocation` over `cityLocation`
    (PRD §7 lists them without priority; the specific scan point is the
    more useful one).
  - Never branch on HTTP status or `statusCode` (pitfall 1); a non-2xx
    HTTP response is a *transport* error, and `statusCode` in the body is
    ignored entirely.
  - Times: offset-less → Asia/Kolkata (fixed +05:30, no DST); explicit
    `Z`/offset taken verbatim; 6-digit fractions truncated to ms. V8
    `Date.parse` ROLLS OVER impossible values (`2026-02-30T10:00:00` →
    Mar 2), so `feedTimeToUtc` validates date components explicitly.
  - Return leg: package-level iff `statusType RT` / `currentFlow
    Returned|Reverse` (observed `Closed` treated as forward); per-scan
    iff `scanType RT` or flow `Reverse` (observed `UD/DL/RT/LT`). A
    `DELIVERED` current status or scan on the return leg →
    `returned`/`rto` (pitfall 5; `rto-delivered.json` fixture).
  - `status.status === "RETURNED"` is a flow token, not a state → fall
    back to `hqStatus` (real case: return still in transit).
  - Summary event (`isSummary: 1`) emitted for the current status unless a
    dated event already reports the same description+time+stage+leg, and
    never when a dated delivered event already records the delivery
    (freight POA-date case). An *undated* status change still emits an
    undated summary — it is the only signal of the change.
  - **M3 caveat (flagged, not fixed here):** SQLite `UNIQUE` treats NULLs
    as distinct, so the `events` dedupe key cannot cover
    `occurred_at IS NULL` rows. M3's schema/repo must coalesce (e.g.
    expression index over `COALESCE(occurred_at,'')`), else undated
    events re-diff every poll.
  - PII: `scanNslRemark`, `consignee`, `clientName`, names/addresses in
    `addressInfo` are never propagated into the normalized result (PRD
    §7/§9); `destCity` = `addressInfo.city` only (null when the shape is
    the name/address variant).
  - `deliveryEta` = raw `deliveryDate` prose, else raw
    `PromiseDeliveryDate`; never parsed (PRD §9).
  - Freight milestones (`label` + no-year `date`, states ≤
    `currentTrackIndex`, no dated scans) become events; year inferred by
    weekday match in [status year, status year−1], must not post-date the
    status; unresolvable → `occurredAt: null`.
  - `src/live.ts` uses `console.*` by design: it is a CLI whose stdout is
    the interface (PRD M2 output), not the app's pino log path.
  - Fixtures carry a provenance table (real capture vs prior-art shape vs
    synthesized) in `fixtures/README.md`.
- **Deferred to M3:** DB schema/repo (incl. the NULL-occurred_at dedupe
  caveat above). **Deferred to M4:** polling cadence/backoff consuming
  the `CarrierResult` kinds. **Deferred to M5/M6:** message formatting,
  bot wiring, keep-alive in `main.ts`.

### 2026-10-19 — M1 done: scaffold

- **Shipped:** pnpm TS/ESM project (Node ≥22, NodeNext), `src/config.ts`
  (env parsing + validation, all problems reported at once), `src/main.ts`
  bootstrap (Node 22 built-in `.env` loading, pino logger, boot log, clean
  exit), eslint 10 flat config + typescript-eslint, vitest, 9 config unit
  tests, `.env.example`, `pnpm-workspace.yaml` (esbuild build allow-list).
- **Evidence:** `rm -rf node_modules && pnpm install --frozen-lockfile`
  clean; `pnpm typecheck` / `pnpm lint` / `pnpm test` all green (9/9);
  `pnpm dev` with env → pino JSON boot line, exit 0; without env → full
  problem list, exit 1. `pnpm build` emits `dist/` (tests excluded).
- **Decisions:** package manager is pnpm (user request, 2026-10-19);
  TypeScript pinned to 5.x (`typescript@5.9.3`) because
  typescript-eslint 8.71 requires `<6.1.0` (pnpm refused the TS 7 native
  release as an unmet peer). `main.ts` deliberately exits after the boot
  log until the bot (M6) needs keep-alive.
- **Deferred to M7:** Docker/README.
