# ParcelTongue — PRD & Implementation Plan

**A self-hosted Telegram bot that tracks Delhivery parcels and pushes every status change to your chat.**

Status: ready to build · Owner: single user · Date: 2026-10-19

---

## 1. Problem

You get Delhivery tracking links like `https://www.delhivery.com/track-v2/package/55540110035405` and you have to open them manually to check on parcels. There is no personal "notify me when it moves" channel.

## 2. Goals

- Paste a Delhivery tracking link (or raw AWB number) into a Telegram bot → it starts tracking.
- Every new status change (all scans, not just milestones) is pushed to your Telegram chat.
- On-demand: list tracked parcels, view full history for one, stop tracking one.
- Runs unattended, self-hosted, single process, single user.

## 3. Non-goals (v1)

- No web UI / dashboard (explicitly not wanted).
- No multi-user, no auth beyond an owner-chat whitelist.
- Other carriers (BlueDart, Shiprocket, EPX…) — **designed for** (one carrier = one adapter module) but not built.
- Official Delhivery One API integration (needs a shipper account; kept as a documented fallback only).
- No SMS/email/push notifications beyond Telegram.
- No B2B/freight LR-number resolution (waybill numbers only — see §9).

## 4. Data source — researched & verified 2026-10-19

### 4.1 The endpoint (private, keyless, live-verified today)

```
GET https://dlv-api.delhivery.com/v3/unified-tracking-new?wbn=<AWB>

Headers (ALL required — without Origin/Referer the endpoint answers 401):
  Origin:   https://www.delhivery.com
  Referer:  https://www.delhivery.com/
  Accept:   application/json
```

- No API key, no account. Keyed purely on the AWB (13–14 digit waybill number, e.g. `55540110035405`).
- The same endpoint powers the public `track-v2` web page (a React SPA at `www.delhivery.com/track-v2/...`).

### 4.2 Response shape (live capture, 2026-10-19)

```json
{
  "statusCode": 200,
  "request_id": "…",
  "message": "Success",
  "data": [{
    "awb": "55540110035405",
    "currentFlow": "Forward",            // Forward | Returned | Reverse
    "currentTrackIndex": 0,
    "hqStatus": "In Transit",
    "deliveryDate": "26 Oct 2026, Evening",
    "deliveryDate_v1": "26 Oct",
    "addressInfo": { "city": "Bangalore", "pincode": "560087", "state": "Karnataka" },
    "productType": "B2C",
    "referenceNo": "GNPC17375",
    "status": {
      "status": "PICKUP",                // current status token
      "instructions": "Shipment picked up",
      "statusDateTime": "2026-10-19T15:37:44",   // NO timezone → Asia/Kolkata
      "statusType": "UD"                 // UD=undelivered/forward, RT=return
    },
    "trackingStates": [{
      "label": "On the Way",
      "scans": [{
        "scan": "In Transit",
        "scanDateTime": "",              // anonymous feed often omits scan times!
        "cityLocation": "Delhi",
        "scannedLocation": "Delhi_Airport_GW (Delhi)",
        "scanNslRemark": "Package picked up successfully.",
        "scanType": "UD"
      }]
    }]
  }]
}
```

### 4.3 Critical pitfalls (from community code that control-tested this endpoint)

1. **The envelope lies.** Invalid or very old AWBs still return `HTTP 200` + `statusCode: 200` with `data: []` and `message: "invalid AWB or very old package"`. The *only* hit signal is whether `data` is non-empty. Never branch on HTTP status or `statusCode`.
2. **Identity-bind the result.** Confirm `data[0].awb === requested AWB` before using it.
3. **Times have no timezone** — interpret as `Asia/Kolkata`.
4. **Anonymous feed is shallow.** Older scan history (and some scan timestamps) is only shown to logged-in users on the website. Treat "history that wasn't there before" as genuinely new events; never assume you missed anything.
5. **Return flows.** `statusType: "RT"` / `currentFlow: Returned|Reverse` marks RTO/return parcels; a "Delivered" scan on the return leg means delivered-to-seller, not to you.
6. **401 = our headers are stale** (Delhivery changed the front door), not a per-parcel problem. Alert the owner, don't silently retry forever.

### 4.4 Known status tokens (observed live by prior integrations)

| Token | Meaning | Our stage |
|---|---|---|
| `MANIFESTED` | Registered with Delhivery, not picked up | registered |
| `PICKED UP` / `PICKUP` | Picked up from shipper | accepted |
| `IN TRANSIT`, `IN_TRANSIT`, `ON THE WAY`, `IN TRANSIT FOR RETURN` | Moving between hubs | in_transit |
| `DISPATCHED`, `OUT FOR DELIVERY` | With the delivery executive | out_for_delivery |
| `DELIVERED` | Delivered to recipient | delivered (terminal) |
| `RTO DELIVERED`, `DELIVERED SELLER`, `RTO`, `DTO` | Return reached the seller | returned (terminal) |
| `LOST`, `CANCELLED`, `CANCELED` | Dead end | exception (terminal) |

Tokens arrive both as words ("In Transit") and as snake-case ("IN_TRANSIT"); the classifier must normalize (`toUpperCase().replaceAll('_', ' ')`) and unknown tokens fall through to "unknown" (still stored & notified, flagged as unmapped).

### 4.5 Prior art (what we're standing on)

- [`plhery/universal-parcel-scraper`](https://github.com/plhery/universal-parcel-scraper) — TS adapter for this exact endpoint, incl. parser, status map, freight handling.
- [`ha-parcel-integrations/ha-delhivery`](https://github.com/ha-parcel-integrations/ha-delhivery) — Home Assistant integration; control-tested the endpoint 2026-08-06 (recent).
- We write our own slim client (no dependency on either project) but reuse their findings and test fixtures.

## 5. Product flows

**Add a parcel**
1. You send the bot a tracking link (or a raw 13–14 digit AWB). Multiple links in one message are allowed.
2. Bot immediately fetches, validates (`data` non-empty + AWB match), stores it, and replies with a snapshot:

   ```
   📦 55540110035405 — tracking
   In Transit → Bangalore
   Last: Shipment picked up · 19 Oct 3:37 PM
   ETA: 26 Oct, Evening
   ```

**Passive updates (every 15 min poll)**
- Any new scan/status appears → one Telegram message per parcel per poll, listing all new events bundled:

  ```
   55540110035405
   ✦ Out for Delivery
     Bangalore · 26 Oct 8:15 AM
   ✦ In Transit — new hub
     Bengaluru Hub · 25 Oct 9:02 PM
  ETA: 26 Oct, Evening
  ```

- Terminal status (delivered / returned / lost / cancelled) → celebratory or somber message, polling stops for that parcel.

**On-demand**
- `/list` — active parcels with current status + ETA; terminal ones at the bottom.
- `/status <awb>` — full timeline for that parcel.
- `/remove <awb>` — stop tracking (history retained).
- `/help` — usage.

## 6. Architecture

Single Node.js process, one SQLite file, one Telegram long-poll connection, one in-process poller loop. No queue, no external scheduler, no UI server.

```
                 ┌──────────────────────────── parceltongue process ───────────────────────────┐
 Telegram  ─────▶│ bot (grammY, long-poll)  ──▶  packages/events (better-sqlite3, single file) │
 your chat       │   commands: /track /list /status /remove                                    │
                 │        ▲                                                                    │
                 │        │ new events → formatted message                                     │
                 │        │                                                                    │
                 │ poller loop (every 15 min, jittered, staggered, concurrency ≤ 3)            │
                 │   └──▶ carrier adapter: carriers/delhivery (client + parse + status map)    │
                 └──────────────────────────────────────────────────────────────────────────────┘
                                              │ GET dlv-api.delhivery.com/v3/unified-tracking-new
                                              ▼
                                        Delhivery (unofficial endpoint)
```

### Tech choices (and why)

| Choice | Why |
|---|---|
| Node 22 + TypeScript (ESM) | One language for bot, poller, adapter; built-in `fetch` |
| [grammY](https://grammy.dev) | Modern, type-safe Telegram bot framework; long-poll mode = no public URL / webhook needed (self-host friendly) |
| better-sqlite3 | Synchronous, zero-config, single file; perfect for a single-process personal app. No Postgres to babysit |
| pino | Structured JSON logs to stdout (docker-friendly) |
| Docker + compose | One container, one volume for the SQLite file |

## 7. Data model (SQLite)

Authoritative DDL: **`src/db/schema.sql`** (versioned — v1 applied by
`db.ts`'s ordered migrations; don't hand-copy the SQL into this PRD, it
drifts). Shape in brief:

- `packages` — one row per tracked AWB: `current_stage`
  (registered|accepted|in_transit|out_for_delivery|delivered|returned|
  exception|unknown), `status_text`/`status_at`, `delivery_eta`, source
  link/city/ref/product, `terminal` + `terminal_reason`
  (delivered|rto|lost|cancelled), poll/error accounting (`polls`,
  `last_polled_at`, `last_error`, `error_streak`).
- `events` — append-only scans, `awb` FK → `packages.awb`: `occurred_at`
  (UTC ISO, else NULL), `description`, `location`, `stage`, `leg`
  (forward|return), `is_summary`, `first_seen_at`.

Dedupe across polls: a table-level `UNIQUE (awb, description,
occurred_at, location, leg)` cannot work in SQLite — NULLs compare
distinct, so undated scans would re-insert every poll — so v1 enforces
the key as the unique expression index `uq_events_dedupe` over
`COALESCE(occurred_at,'')` / `COALESCE(location,'')`.

Notes:
- All timestamps stored as UTC ISO; source times assumed `Asia/Kolkata`.
- `events` is append-only and is the source of truth for "what changed since last poll": diff = events present in fresh parse but not yet in the table.
- Raw last response JSON kept in memory/log only (debug), not in DB — the anonymous feed exposes PII-ish fields (remarks, locations) we don't want to persist beyond `events`.

## 8. Poller & notification rules

- **Interval:** every 15 minutes, per-parcel jitter ±20%, start staggered so a fleet of N parcels spreads across the window.
- **Concurrency:** ≤ 3 in-flight requests; timeout 15 s; max response 1 MB.
- **Terminal:** stage ∈ {delivered, returned, exception} → `terminal=1`, excluded from polling, final message sent.
- **Notify on:** *all* new status changes (your choice). One bundled message per parcel per poll. A brand-new parcel's *initial* snapshot is also the first (only) message at add time — subsequent polls only notify on genuinely new events, so a 5-scan backlog that appears at once is one message, not five.
- **Error handling:**
  - `data: []` + "invalid AWB…" on a parcel we already track → tell you once, mark `last_error`, keep polling (rare: could be a feed glitch).
  - HTTP 401 / schema break → increment `error_streak`; at streak 3 send you one "Delhivery endpoint looks broken — pausing" alert, then back off 1 h → 6 h → 24 h. No per-poll spam.
  - Network blip → silent retry next tick.
- **No dedupe across parcels:** each AWB is independent; a repeated AWB in `/track` is a no-op with a friendly "already tracking" reply.

## 9. Limitations (documented, accepted)

- Unofficial endpoint: it can change without notice. Containment = the adapter is one small module; a break is a 30-minute fix + one Telegram alert in the meantime. Fallback if it dies for good: official Delhivery One tracking API (shipper account + key) — same adapter interface.
- Anonymous feed hides old scan history and some timestamps; we track *forward deltas* only, which is all a notification bot needs.
- Freight/B2B **LR numbers** can't be resolved (website resolves them via a separate authenticated service); only waybill numbers work.
- ETA is prose ("26 Oct, Evening") — displayed verbatim, never parsed into a hard promise.
- ToS note: low-volume personal use (≤ 1 request per parcel per 15 min). No credentials, no PII stored beyond city-level locations.

## 10. Configuration

| Env var | Required | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | From @BotFather |
| `OWNER_CHAT_ID` | yes | Your numeric Telegram chat id; everyone else gets "unauthorized" |
| `POLL_INTERVAL_MIN` | no, default 15 | Poll cadence |
| `DB_PATH` | no, default `./data/parceltongue.db` | SQLite file location |
| `LOG_LEVEL` | no, default `info` | |

Setup steps (in README): create bot via @BotFather → find your chat id (e.g. @userinfobot) → `docker compose up -d`.

## 11. Implementation plan

```
parceltongue/
├── PRD.md  README.md  .env.example  package.json  tsconfig.json
├── Dockerfile  docker-compose.yml
└── src/
    ├── config.ts                 # env parsing + validation
    ├── main.ts                   # bootstrap: db → poller → bot
    ├── live.ts                   # smoke CLI (M2): pnpm live <awb> → normalized JSON
    ├── db/
    │   ├── schema.sql            # §7
    │   ├── db.ts                 # better-sqlite3 init, pragma, migrations
    │   └── repo.ts               # insert/find/update packages, upsert events, diff query
    ├── carriers/
    │   ├── types.ts              # CarrierAdapter interface: track(awb): CarrierResult
    │   └── delhivery/
    │       ├── client.ts         # GET with Origin/Referer/Accept, 15 s timeout, 1 MB cap; 401→auth, other non-2xx→transport
    │       ├── parse.ts          # response → {stage, events[], eta, city, …}; identity check
    │       ├── status.ts         # token → stage map (§4.4)
    │       ├── index.ts          # CarrierAdapter implementation (delhiveryAdapter)
    │       └── fixtures/*.json   # endpoint responses; provenance per file in fixtures/README.md
    ├── poller/
    │   ├── loop.ts               # 15-min tick, jitter, stagger, concurrency cap
    │   └── backoff.ts            # error_streak → pause durations
    ├── notify/
    │   ├── diff.ts               # fresh events − stored events = new events
    │   └── format.ts             # Telegram text (markdown), per §5 examples
    └── bot/
        ├── bot.ts                # grammY, long-poll, owner-whitelist middleware
        └── commands.ts           # /start /help /track /list /status /remove
```

### Milestones

| # | Item | Output | Est. |
|---|---|---|---|
| M1 | Scaffold: TS project, config, pino, lint, vitest | compiles, `pnpm dev` boots | 0.5 d |
| **M2** | **Delhivery adapter: client + parse + status map + fixtures + unit tests** | `pnpm live <awb>` prints normalized status from real endpoint — *highest risk, do first* | 1 d |
| M3 | DB: schema, repo, migrations | insert/diff queries tested against temp DB | 0.5 d |
| M4 | Poller: tick loop, jitter, backoff, terminal handling | pollable with fake adapter; streak alert path tested | 0.5 d |
| M5 | Notify: diff + message formatting | snapshot / update / terminal message fixtures | 0.5 d |
| M6 | Bot: grammY, whitelist, all 6 commands | add/list/status/remove via real Telegram | 0.5 d |
| M7 | Dockerfile + compose + README (BotFather walkthrough) | one-command deploy | 0.25 d |
| M8 | E2E soak: track 2–3 real parcels through delivery; tune message noise | PRD §5 flows verified in your chat | ongoing |

### Definition of done

- Send a Delhivery link → snapshot reply within ~3 s.
- Every new scan shows up in chat within one 15-min cycle, bundled, no dupes across restarts (dedupe in `events`).
- Delivered/RTO/lost/cancelled → final message + polling stops.
- Kill/restart the process mid-flight → no lost state, no duplicate notifications.
- Delhivery breaks the endpoint → one alert, then quiet backoff; no crash loop.

## 12. Test plan

1. **Unit — parser:** every fixture in §11 (in-transit, delivered, RTO flow, lost, cancelled, invalid-AWB, freight, missing-timestamp scans, snake-case tokens, AWB-mismatch identity check).
2. **Unit — status map:** all §4.4 tokens + unknown-token fallback.
3. **Unit — diff:** re-poll same payload → zero new events; add a scan → exactly one.
4. **Unit — backoff:** streak 1/2/3 → correct pauses and alert once.
5. **Live smoke:** `pnpm live` against the real endpoint with a real AWB (manual, CI-excluded).
6. **E2E (M8):** real bot, real parcels, full lifecycle to delivery; plus a fake AWB (expect the "invalid" message path).

## 13. Open questions (don't block M1–M3)

- Parcel names/labels: allow `/track <link> - "mom's gift"` so `/list` is human? (nice-to-have, trivial add later)
- Quiet hours: suppress messages at night, deliver at 9 AM? (defer; can add as one middleware)
- Keep a raw-response audit table for debugging endpoint changes? (defer; pino logging covers v1)
