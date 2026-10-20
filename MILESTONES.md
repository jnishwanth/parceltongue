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
| M4 | Poller: tick loop, jitter, backoff, terminal handling                             | ✅ done        | 2026-10-20 | `src/poller/` shipped (loop.ts: boot stagger across the window, per-poll jitter floored at one interval (effective 15–18 min, PRD §9), concurrency ≤ 3, PRD §9 cadence floor, terminal exclusion; backoff.ts: alert once at streak 3, then 1 h → 6 h → 24 h); pollable with fake adapter — 20 new tests incl. streak-alert path, pause-across-restart, concurrency cap, emit/throw resilience; typecheck+lint+144/144 green; `pnpm build` emits `dist/poller/` |
| M5 | Notify: diff + message formatting                                                | ✅ done        | 2026-10-21 | `src/notify/format.ts` — all 4 `PollNotification` kinds + add-time snapshot → MarkdownV2 text; 7 pinned message fixtures (snapshot/update/terminal×3/two alerts, PRD §5 shapes); typecheck+lint+167/167 tests green (23 new, incl. 1 backslash-escape hardening from review); diff stays `repo.insertEvents` (M3) — no separate `notify/diff.ts`, see decisions; `pnpm build` emits `dist/notify/` |
| M6 | Bot: grammY, whitelist, all 6 commands                                            | ⬜ pending   | —          | Output: add/list/status/remove via real Telegram |
| M7 | Dockerfile + compose + README (BotFather walkthrough)                             | ⬜ pending   | —          | Output: one-command deploy |
| M8 | E2E soak: track 2–3 real parcels through delivery; tune message noise            | ⬜ pending   | —          | Ongoing. PRD §5 flows verified in the owner's chat |

## Log

<!-- Newest entry first. Each entry: date, milestone, what shipped, evidence
     (test/typecheck/lint results, key commands), anything deferred. -->

### 2026-10-21 — M5 done: Notify (diff + message formatting)

- **Shipped:** `src/notify/format.ts` — MarkdownV2 formatters for the whole
  `PollNotification` union (the M4→M5 contract in `src/poller/loop.ts`):
  `formatUpdateMessage` (one bundled message per parcel per poll, PRD §5/§8),
  `formatTerminalMessage` (celebratory/somber header + new events or status
  line + "tracking stopped" footer), `formatEndpointBrokenMessage` (the
  once-per-episode "endpoint looks broken — pausing" alert, PRD §8/pitfall 6),
  `formatNotFoundMessage` (the once-per-episode "invalid AWB" tell), and
  `formatSnapshot` (the add-time message — M6's `/track` reply, PRD §5).
  `formatPollNotification` is the single dispatcher M6's emit sink calls.
  Utilities: `formatWhen` (Asia/Kolkata wall-clock from stored UTC ISO),
  `formatDurationMs` (the backoff tiers), `mdv2Escape` (Telegram MarkdownV2).
  7 pinned message fixtures in `src/notify/fixtures/` (+ provenance
  `README.md`) and 23 tests in `format.test.ts` — inputs are the M2 carrier
  fixtures run through the real `parseDelhivery` (no network) with
  notifications assembled the way the M4 loop assembles them; `NOW` fixed at
  `2026-10-20T12:00:00Z` in the tests.
- **Evidence:** `pnpm typecheck` / `pnpm lint` clean; `pnpm test` 167/167
  (23 new — incl. a review-round hardening: `mdv2Escape` now escapes
  backslash too, so a `\` in feed text cannot defeat the escaping of the
  other specials or break the parse). All seven fixtures pinned: snapshot
  from `in-transit.json` (PRD §4.2 live-capture AWB, mirrors the PRD §5
  snapshot example), bundled
  update mirroring the PRD §5 passive-update example (same times/cities/ETA;
  event descriptions are the feed's own scan labels), terminal
  delivered/RTO/lost from `delivered.json` / `rto-delivered.json` /
  `lost.json` (the last a verbatim live capture — together they pin the
  6-digit fractional status time, undated scans, `currentFlow: "Closed"`,
  pitfall-5 RTO, and MarkdownV2 escaping of `_`/`()` in locations), plus the
  endpointBroken and notFound alerts. Degenerate paths tested: snapshot
  without city/ETA/status, time-only / location-only / bare events, terminal
  with no new events (status-line fallback) and with a null reason, 25-event
  backlog → 20 events + "… and 5 more" tail, escaping of every MarkdownV2
  special in carrier-controlled text. `pnpm build` → `dist/notify/format.js`
  (tests excluded); `pnpm dev` behavior unchanged (main.ts not wired yet —
  the emit sink is M6).
- **Decisions:**
  - **No separate `notify/diff.ts`** (PRD §11 tree deviation, like M2's
    `index.ts`): the PRD's diff — "events present in the fresh parse but not
    yet in the table" (PRD §7) — is already implemented and shipped: it is
    the return value of `repo.insertEvents` (M3), computed atomically with
    the insert in one transaction, and M4's loop already bundles that return
    value into the `events` array of the notification. A second in-memory
    diff would be non-atomic, dead code, and a second source of truth for
    the NULL-coalesced dedupe semantics; PRD §12.3's diff tests were
    exercised against the DB in M3 (re-poll same payload → 0 new; +1 scan →
    1 new).
  - **MarkdownV2 with escaping** (PRD §11 originally said "Telegram text
    (markdown)"; its tree now records MarkdownV2):
    the only markup is the bold AWB — pure digits, the adapter's contract —
    every carrier-controlled string (descriptions, locations, status text,
    ETA, error messages) goes through `mdv2Escape`, and the template
    literals themselves contain no MarkdownV2 specials. A feed that injects
    `*`, `_`, `[`… can no longer break the parse mode (grammY would reject
    the message and M4's `safeEmit` would drop the notification).
  - **Times render in Asia/Kolkata** (fixed UTC+05:30, no DST, no `Intl`):
    the PRD §5 examples show IST wall-clock times and the owner is in
    India; deterministic regardless of the host TZ. Shape `26 Oct 8:15 AM`
    (12-hour, no leading zero, seconds dropped); the year is appended after
    the month only when the IST year differs from now (`1 Jun 2025 5:30 AM`)
    — a freight backlog can span New Year.
  - **Bundling + cap (PRD §8):** one message per parcel per poll; events
    render in diff order (feed order, newest-first in practice); capped at
    20 events + a `… and N more` tail so a huge backlog (the parse accepts
    up to 500 events) cannot hit Telegram's 4096-character message limit.
    Noise tuning stays with M8.
  - **Summary events show the raw status token** (`✦ DELIVERED`, `✦ LOST`) —
    that is the M2 contract (the snapshot's `description` is the token, the
    human wording lives in `statusText`, which the snapshot message uses).
    Rendered as-is; M8 may prefer the wording if it reads badly in practice.
- **Deferred to M6:** sending the formatted text through the bot
  (`sendMessage(chatId, formatPollNotification(n), { parse_mode: "MarkdownV2" })`
  as the poller's `emit` sink); the `/track` reply using `formatSnapshot`;
  `/list` and `/status` command text (reuse `formatWhen`/`mdv2Escape`); the
  "already tracking" reply; add-time terminal wording (a parcel that is
  already delivered/RTO/lost when tracked).

### 2026-10-20 — M4 done: Poller (tick loop, jitter, backoff, terminal handling)

- **Shipped:** `src/poller/backoff.ts` (`ALERT_STREAK = 3`; `backoffMs(streak)`:
  < 3 → 0, 3 → 1 h, 4 → 6 h, ≥ 5 → 24 h plateau); `src/poller/loop.ts`
  (`createPoller`: per-parcel next-due schedule, boot stagger across one
  window, per-poll jitter floored at one interval (effective 15–18 min,
  PRD §9), concurrency ≤ 3, `PollNotification` union
  `update | terminal | endpointBroken | notFound` as the M4→M5 contract,
  idempotent `start`/`stop`, exported `tick`); 20 tests (18 in
  `loop.test.ts`, 2 in `backoff.test.ts`) — fake adapter, fake clock +
  fake timers, in-memory DB, no network.
- **Evidence:** `pnpm typecheck` / `pnpm lint` clean; `pnpm test` 144/144
  (20 new). Test plan §12.4 verified: auth failures → no alert at streak
  1–2, exactly one `endpointBroken` at streak 3 (carrying `pauseMs = 1 h`),
  no re-alert at streak 4/5; pause boundaries observed on the clock (no 4th
  poll before 45 min + 1 h, no 5th before + 6 h); a success resets the
  streak and a later break re-arms a fresh alert. Terminal: one
  `terminal` notification carrying the new events, parcel drops out of
  `activePackages` and is never polled again. notFound: "tell once" per
  episode (repeat notFounds stay quiet, a clean poll re-arms the tell),
  `error_streak` untouched. network: silent, poll accounting proceeds.
  Concurrency: 5 parcels due at once → max in-flight exactly 3 (and 2 with
  `maxConcurrent: 2`). Stagger: a 3-parcel fleet polls at boot / boot + 7.5
  min / boot + 15 min; a restart never re-polls within 15 min of the last
  poll (PRD §9); a backoff parcel stays paused across a restart (derived
  from `last_polled_at` + `error_streak`) and restart mid-pause does not
  re-alert. Resilience: an emit failure is swallowed and the cadence
  continues; an adapter contract-violation throw is logged, the poll is not
  recorded, the cadence continues; `start` idempotent, `stop` clears the
  timer. `pnpm dev` with env → pino boot line, exit 0 (poller not started —
  see decisions); `pnpm build` → `dist/poller/{loop.js,backoff.js}`,
  `node dist/main.js` behaves as before.
- **Decisions:**
  - **Alert-once with no extra state:** the streak only moves +1 per
    failure and resets to 0 on success, so "post-poll streak === 3" is true
    exactly once per break episode — that is the "tell once" gate (and the
    re-arm for a new episode). A restart at streak ≥ 3 does not re-alert:
    the alert belongs to the episode that reached 3.
  - **Pause is derived, never stored:** next-eligible-poll =
    `last_polled_at + backoffMs(streak)`; both inputs are persisted, so a
    restart mid-pause resumes the pause exactly (tested). Tiers: 3 → 1 h,
    4 → 6 h, ≥ 5 → 24 h plateau — a paused parcel retries exactly once per
    pause and steps up a tier per continued failure (the streak grows only
    while polls actually fail).
  - **Cadence floor (PRD §9 ToS note):** a parcel is never polled within
    one interval of its last poll, including across restarts. A fresh
    parcel's first poll is ≈ one interval after add (jittered) — the
    add-time snapshot is its first message (PRD §8).
  - **Poll time is anchored to start:** `recordPoll` and the reschedule use
    the tick instant that found the parcel due, not when the (≤ 15 s)
    adapter call resolves — the cadence is poll-start to poll-start.
  - **notFound "tell once"** = first notFound after a clean
    `last_error`; consecutive notFounds stay quiet; a success ends the
    episode.
  - **Loop skeleton:** the timer sleeps until the earliest due parcel,
    capped at a 60 s heartbeat (`maxCheckDelayMs`) so parcels added after
    start (M6 `/track`) are noticed within a minute; with no active parcels
    it is a 60 s idle check (one cheap query).
  - **`PollNotification` is the M4→M5 boundary** (exported from
    `loop.ts`): `update` (the bundled new events + package row), `terminal`
    (reason + new events), `endpointBroken` (streak + `pauseMs`),
    `notFound`. M5's `format.ts` consumes it; M6's bot sends it. The
    carrier's `CarrierResult` is mapped onto the repo's `PollOutcome`
    (`toPollOutcome`) — the M3 contract is unchanged.
  - **main.ts deliberately not wired** (besides fixing the stale
    milestone pointer in the boot log): the poller's `emit` has no sink
    until the bot exists, so main.ts assembles db → poller → bot and the
    keep-alive lands with M6, as AGENTS.md promises. `pnpm dev` therefore
    still exits after the boot log.
- **Deferred to M6:** wire `createPoller` into `main.ts` (db → poller →
  bot) with the Telegram bot as the `emit` sink; process keep-alive and
  graceful `stop()` on SIGINT. The loop already seeds parcels added after
  start, so `/track` needs no poller-side change.

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
    consumes it), `network` updates poll accounting only (silent — retried
    on the next scheduled poll). The M4 poller maps `CarrierResult` kinds
    onto this union; the backoff policy itself stays in M4.
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
