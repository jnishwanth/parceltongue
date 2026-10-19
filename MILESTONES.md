# MILESTONES — ParcelTongue

Single source of truth for "what's next". One milestone at a time, top to
bottom. Definitions come from PRD §11; this file tracks execution.

Status legend: ✅ done · 🔜 in progress · ⬜ pending

## Status

| #  | Milestone                                                                        | Status       | Done       | Evidence / notes |
|----|----------------------------------------------------------------------------------|--------------|------------|------------------|
| M1 | Scaffold: TS project, config, pino, lint, vitest                                 | ✅ done        | 2026-10-19 | Fresh `pnpm install` clean; typecheck+lint+9/9 tests green; `pnpm dev` boots (exits after boot log — keep-alive comes with M6); config error path exits 1 with all problems listed |
| M2 | **Delhivery adapter: client + parse + status map + fixtures + unit tests**       | ⬜ pending   | —          | Highest risk per PRD. Output: `npm run live <awb>` prints normalized status from the real endpoint |
| M3 | DB: schema, repo, migrations                                                      | ⬜ pending   | —          | Output: insert/diff queries tested against temp DB |
| M4 | Poller: tick loop, jitter, backoff, terminal handling                             | ⬜ pending   | —          | Output: pollable with fake adapter; streak-alert path tested |
| M5 | Notify: diff + message formatting                                                 | ⬜ pending   | —          | Output: snapshot / update / terminal message fixtures |
| M6 | Bot: grammY, whitelist, all 6 commands                                            | ⬜ pending   | —          | Output: add/list/status/remove via real Telegram |
| M7 | Dockerfile + compose + README (BotFather walkthrough)                             | ⬜ pending   | —          | Output: one-command deploy |
| M8 | E2E soak: track 2–3 real parcels through delivery; tune message noise            | ⬜ pending   | —          | Ongoing. PRD §5 flows verified in the owner's chat |

## Log

<!-- Newest entry first. Each entry: date, milestone, what shipped, evidence
     (test/typecheck/lint results, key commands), anything deferred. -->

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
