# MILESTONES — ParcelTongue

Single source of truth for "what's next". One milestone at a time, top to
bottom. Definitions come from PRD §11; this file tracks execution.

Status legend: ✅ done · 🔜 in progress · ⬜ pending

## Status

| #  | Milestone                                                                        | Status       | Done       | Evidence / notes |
|----|----------------------------------------------------------------------------------|--------------|------------|------------------|
| M1 | Scaffold: TS project, config, pino, lint, vitest                                 | ✅ done        | 2026-10-19 | Fresh `pnpm install` clean; typecheck+lint+9/9 tests green; `pnpm dev` boots (exits after boot log — keep-alive comes with M6); config error path exits 1 with all problems listed |
| M2 | **Delhivery adapter: client + parse + status map + fixtures + unit tests**       | ✅ done        | 2026-10-20 | `pnpm live 55540110035405` → real endpoint returned `kind: ok` (stage in_transit, IST→UTC with ms, shallow feed as documented); bogus AWB → `notFound`/exit 1; typecheck+lint+97/97 tests green; 10 fixtures w/ provenance README |
| M3 | DB: schema, repo, migrations                                                      | ✅ done        | 2026-10-20 | `src/db/` shipped (schema.sql v1, db.ts WAL+FK+migrations, carrier-agnostic repo.ts); typecheck+lint+124/124 tests green (23 new at M3, +4 net from review round 1; incl. PRD §12.3 diff + NULL-dedupe caveat); `pnpm dev` creates+migrates `./data/parceltongue.db` (v1) and reopens idempotently; `pnpm build` copies schema.sql into dist and compiled `main.js` boots |
| M4 | Poller: tick loop, jitter, backoff, terminal handling                             | ⬜ pending   | —          | Output: pollable with fake adapter; streak-alert path tested |
| M5 | Notify: diff + message formatting                                                 | ⬜ pending   | —          | Output: snapshot / update / terminal message fixtures |
| M6 | Bot: grammY, whitelist, all 6 commands                                            | ⬜ pending   | —          | Output: add/list/status/remove via real Telegram |
| M7 | Dockerfile + compose + README (BotFather walkthrough)                             | ⬜ pending   | —          | Output: one-command deploy |
| M8 | E2E soak: track 2–3 real parcels through delivery; tune message noise            | ⬜ pending   | —          | Ongoing. PRD §5 flows verified in the owner's chat |

## Log

<!-- Newest entry first. Each entry: date, milestone, what shipped, evidence
     (test/typecheck/lint results, key commands), anything deferred. -->

### 2026-10-20 — M3 done: DB (schema, repo, migrations)

- **Shipped:** `src/db/schema.sql` (PRD §7 v1: `packages`, `events`,
  `idx_events_awb`, plus `uq_events_dedupe` — see caveat decision below);
  `src/db/db.ts` (`openDb`: creates parent dirs, `journal_mode=WAL` +
  `synchronous=NORMAL` + `foreign_keys=ON` + `busy_timeout=5000` for file
  DBs, ordered-migrations runner over `schema_migrations(version,
  applied_at)`, `schemaVersion()`); `src/db/repo.ts` (carrier-agnostic:
  `addPackage`, `getPackage`, `listPackages`, `activePackages`,
  `recordPoll` over a `PollOutcome` union, `insertEvents` (the cross-poll
  diff), `eventsForAwb`); `src/main.ts` wires db into the bootstrap
  (PRD §11 db → poller → bot) and still exits after the boot log
  (keep-alive is M6); `pnpm build` now copies `schema.sql` into
  `dist/db/` (tsc doesn't carry non-TS assets). Deps: `better-sqlite3`
  (PRD §6 tech table) + `@types/better-sqlite3`; `allowBuilds` entry in
  `pnpm-workspace.yaml`.
- **Evidence:** `pnpm typecheck` / `pnpm lint` clean; `pnpm test` 124/124
  (M3 added 23: 5 in `db.test.ts`, 18 in `repo.test.ts`; review round 1
  grew `repo.test.ts` to 22 — add-time event persistence + per-kind
  `recordPoll` failure coverage). PRD §12 test-plan
  #3 verified against a temp (`:memory:`) DB: first poll → every event new;
  re-poll same payload → 0 new; feed grows by one scan → exactly 1 new.
  M2 NULL-dedupe caveat verified both ways (undated `occurred_at` and
  null `location` re-inserts return 0 new). FK enforced (event for unknown
  AWB throws; repo throws loudly rather than letting `INSERT OR IGNORE`
  swallow it). Migrations idempotent across reopen; pragmas asserted on a
  temp file DB. `pnpm dev` with env → pino boot line,
  `./data/parceltongue.db` created+migrated (tables
  `events,packages,schema_migrations`, v1), exit 0; second run reopens the
  WAL file cleanly. `pnpm build` → `dist/db/{db.js,repo.js,schema.sql}`;
  `node dist/main.js` boots (schema.sql resolved from dist).
- **Decisions:**
  - **M2 caveat (flagged, now fixed):** the PRD §7 table-level
    `UNIQUE (awb, description, occurred_at, location, leg)` cannot work as
    written — SQLite treats NULLs as distinct in UNIQUE constraints, so
    every undated scan (the anonymous feed is full of them, PRD §4.3
    pitfall 4) would re-diff on each poll. Implemented instead as the
    unique expression index `uq_events_dedupe` over
    `COALESCE(occurred_at,'')` / `COALESCE(location,'')`. Coalescing
    strictly reduces duplicates vs the plain constraint (NULL-vs-NULL
    rows), never increases them.
  - `insertEvents` returns the events actually inserted, in input order —
    that is the PRD §7 diff ("fresh parse but not yet in the table"); M5
    bundles the return value into the one message per parcel per poll.
    One transaction, `INSERT OR IGNORE` + `changes()` per row.
  - `eventsForAwb` orders by `first_seen_at ASC, id ASC` (the order we
    first saw events = the notification-faithful timeline; feed order can
    drift as the shallow feed later reveals dates, PRD §4.3 pitfall 4).
  - Migrations: append-only list in `db.ts`, each applied in one
    transaction, applied versions recorded with a UTC ISO stamp. New
    migrations are appended, never edited. `schema.sql` is loaded eagerly
    via `new URL("./schema.sql", import.meta.url)` — a missing file fails
    at import, not mid-poll.
  - `recordPoll(awb, outcome, now)` takes `{ ok: true, pkg } | { ok:
    false, kind, message }` where the exported `kind: notFound | auth |
    schema | network` selects per PRD §8 failure semantics (review round
    1): success refreshes the snapshot columns, increments `polls`,
    resets `error_streak`/`last_error`, and applies terminal state;
    `notFound` sets `last_error` without bumping the streak (possible
    feed glitch — tell once, keep polling), `auth`/`schema` set
    `last_error` and increment `error_streak` (M4's alert-at-3/backoff
    consumes it), `network` updates poll accounting only (silent retry
    next tick). The M4 poller maps `CarrierResult` kinds onto this union;
    the backoff policy itself stays in M4.
  - `addPackage` returns false for an already-tracked AWB (PRD §8
    no-op, events untouched) and stores terminal state at add time
    (tracking an already-delivered parcel starts out of polling). When
    it creates the row it also persists the add-time `pkg.events` in the
    same transaction (review round 1), so the add-time snapshot is the
    first (only) message at add time and a later `insertEvents` with the
    same payload returns 0 new events (PRD §8); `recordPoll`'s success
    path keeps its companion-call contract (M4 calls `insertEvents`
    separately).
  - `listPackages` = PRD §5 `/list` ordering: active first (newest
    additions first), terminal at the bottom. `activePackages` mirrors
    that ordering (what M4's stagger consumes).
  - `better-sqlite3@13` compiled from source here (node-gyp, no prebuild
    for this Node build) — the `allowBuilds` entry is load-bearing.
- **Deferred to M4:** poll tick/jitter/stagger/concurrency, `CarrierResult`
  → `PollOutcome` mapping, backoff consuming `error_streak` (1 h → 6 h →
  24 h, alert at streak 3), terminal exclusion in the loop (repo already
  exposes `activePackages`).
- **Deferred to M6 (needs a decision):** `/remove` semantics — PRD §5 says
  "stop tracking (history retained)" but the §7 schema has no removed
  flag. Options: (a) set `terminal = 1` (excluded from polling, shows at
  `/list` bottom — but `terminal_reason` is typed delivered|rto|lost|
  cancelled, and a removed parcel is none of those); (b) add a `removed`
  column via migration v2. Leaning (b): one small migration, no semantic
  overload.
- **Deferred to M7:** Docker build must rebuild the native module (or use
  the same Node image build stage) — `better-sqlite3` is compiled per
  platform/Node version.

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
    (`schema.sql` lists them without priority; the specific scan point is the
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
