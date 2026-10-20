# AGENTS.md — ParcelTongue

Orientation and working rules for AI agents (and humans) in this repo.

## What this is

A self-hosted Telegram bot that tracks Delhivery parcels and pushes every
status change to one owner's chat. Single Node process, one SQLite file,
grammY long-poll, an in-process 15-min poller, and a small carrier-adapter
module. **No web UI, no multi-user, no queues.**

- **Source of truth: `PRD.md`** — read it first. If this file and the PRD
  disagree on *what to build*, the PRD wins; this file is about *how to work here*.
- Progress tracking: **`MILESTONES.md`** — always check it before starting work.

## Commands

Package manager is **pnpm** (see `packageManager` in package.json).

```sh
pnpm install           # install deps
pnpm dev               # boot the app via tsx (validates config, opens+migrates the DB, logs, exits until M6; keep-alive comes with M6)
pnpm test              # vitest run (unit tests, no network)
pnpm typecheck         # tsc --noEmit
pnpm lint              # eslint (flat config)
pnpm build             # emit dist/ (used by Docker, M7)
```

pnpm notes: dependency build scripts are allow-listed in
`pnpm-workspace.yaml` (`allowBuilds`) — if a new dep needs a postinstall,
add it there (`pnpm approve-builds` does this for you).

## Repo layout

Follow the tree in PRD §11. Only create directories/files for the milestone
you are actually working on — don't pre-scaffold future milestones.

```
src/
  config.ts            env parsing + validation (M1)
  main.ts              bootstrap; keep it thin
  db/                  schema.sql, db.ts, repo.ts          (M3)
  carriers/types.ts    CarrierAdapter interface            (M2)
  carriers/delhivery/  client, parse, status, fixtures/    (M2)
  poller/              loop, backoff                       (M4)
  notify/              format, fixtures/                   (M5)
  bot/                 bot.ts (grammY), commands.ts        (M6)
```

## Conventions

- **Node 22+**, ESM TypeScript, `moduleResolution: NodeNext` → relative imports
  **must end in `.js`** (e.g. `import { loadConfig } from "./config.js"`).
- Prefer `node:` builtins; Node 22 has `fetch`, `AbortSignal.timeout`, and
  `process.loadEnvFile` — no need for axios/dotenv.
- **No new runtime dependencies** without recording them in the PRD tech table
  and in this file. Personal single-process tool: fewer deps is better.
  Current runtime deps: `pino` (M1), `better-sqlite3` (M3, native — allow-listed
  in `pnpm-workspace.yaml`, needs a build step in Docker, M7). Planned:
  `grammY` (M6).
- **Logging:** pino JSON to stdout only. No console.log in non-test code
  (main.ts may console.error once for fatal config failures, before the
  logger exists; the `live` smoke CLI `src/live.ts` is stdout-by-design).
- **Tests:** vitest, colocated `*.test.ts`. Tests must never touch the network;
  Delhivery responses are covered by recorded fixtures in
  `src/carriers/delhivery/fixtures/` (M2).
- **Timestamps:** source times are `Asia/Kolkata` with no tz → convert to UTC
  ISO before storing. Store UTC everywhere in the DB.
- **Carrier boundary:** everything Delhivery-specific lives under
  `src/carriers/delhivery/` and is consumed only through the `CarrierAdapter`
  interface in `src/carriers/types.ts`. A future carrier = a new folder, nothing else changes.

## Domain pitfalls (PRD §4.3 — memorize, these are failure-prone)

1. **The envelope lies.** HTTP 200 + `statusCode: 200` still happens for
   invalid/very-old AWBs (with `data: []`). The *only* hit signal is
   `data` being non-empty. Never branch on HTTP status or `statusCode`.
2. **Identity-bind the result:** `data[0].awb === requested AWB` before use.
3. **Times have no timezone** — interpret as `Asia/Kolkata`.
4. **Anonymous feed is shallow.** Older history (and some scan timestamps) is
   hidden from anonymous calls. Treat "not in our DB" as genuinely new;
   never assume we missed anything.
5. **Return flows:** `statusType: "RT"` / `currentFlow: Returned|Reverse`
   means RTO — a "Delivered" scan on the return leg is delivered-to-seller.
6. **HTTP 401 = our headers went stale** (Delhivery changed the front door),
   not a per-parcel problem. Alert the owner once, then back off. Never retry-forever.

## Working rules

1. **One milestone at a time**, in the order in `MILESTONES.md` (M2 is the
   highest-risk item — the PRD says do it first after M1).
2. Before finishing a milestone: typecheck + lint + tests all green, and
   `MILESTONES.md` updated (status table row + dated log entry with evidence).
3. Do not implement PRD §13 open questions (labels, quiet hours, audit table)
   unless the user decides on them.
4. Keep the PRD's definition of done (§11) in mind when wiring things together.
