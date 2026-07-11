# HotelOS

Enterprise hotel management platform (PMS-first). Phase 1: core PMS — rooms, rates,
reservations, check-in/out, folio, night audit, reports.

See [`hotel-pms-tech-design.md`](./hotel-pms-tech-design.md) for the full technical design.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 15 (App Router), React 19, Tailwind 4, Apollo Client |
| Backend | NestJS 11 + Apollo Server 5 (code-first GraphQL) |
| ORM | Drizzle + drizzle-kit |
| DB | PostgreSQL 16 (RLS, `btree_gist` exclusion constraints) |
| Cache/PubSub | Valkey 8 (BSD-licensed Redis drop-in) |
| Tests | Vitest (unit + Testcontainers integration), Playwright (E2E) |
| Monorepo | Turborepo + pnpm |
| CI | GitHub Actions |

Everything is open source and free to self-host.

## Prerequisites

- **Node 22+** and **pnpm 9** (`npm i -g pnpm@9.15.4`)
- **Podman Desktop** (or Docker) for Postgres + Valkey

## Getting started

```bash
pnpm install
cp .env.example .env          # then edit the secrets
pnpm db:up                    # start Postgres + Valkey
pnpm --filter @hotelos/api db:migrate
pnpm dev                      # api :4000, web :3000
```

| Command | Does |
|---|---|
| `pnpm dev` | Run api + web in watch mode |
| `pnpm test` | Unit tests (fast, no I/O) |
| `pnpm test:integration` | Integration tests against real Postgres + Valkey |
| `pnpm lint` / `pnpm typecheck` | Static gates |
| `pnpm db:up` / `pnpm db:down` / `pnpm db:reset` | Local infra |

## Troubleshooting

**Web app 500s with `Could not find the module ... segment-explorer-node.js#SegmentViewNode
in the React Client Manifest`, then `Cannot read properties of undefined (reading 'call')`.**

`.next` holds a *production* build and you are now running `next dev` (or vice versa).
Dev mode reuses the production client manifest, which has no dev-tools modules in it,
and RSC hydration dies. Nothing is wrong with your code.

```bash
rm -rf apps/web/.next && pnpm --filter @hotelos/web dev
```

Don't run `next build`/`next start` and `next dev` against the same `.next` directory.

## Layout

```
apps/
  api/    NestJS — modules/{identity,property,inventory,reservations,guests,folio,night-audit,reporting}
  web/    Next.js — front-desk, reservations, guests, cashiering, night-audit, reports
packages/
  domain/   money · business-date · reservation state machine · zod validators  (shared by both apps)
  config/   eslint + tsconfig presets
  graphql/  generated SDL + codegen output
infra/
  postgres/init/   extensions run at container init (btree_gist, pgcrypto, citext)
```

## Non-negotiables

These are enforced by the build, not by convention:

- **Module boundaries.** Cross-module imports must go through `modules/<name>/index.ts`.
  ESLint `no-restricted-imports` fails the build otherwise. (TDD §2.1)
- **Tenancy.** Every domain row carries `property_id`; every tenant query runs inside
  `TenantTransaction.run()`, which sets the RLS GUC. (TDD §2.2)
- **Money is integer minor units.** Floats never touch a folio. (TDD §4)
- **Business date ≠ calendar date.** It advances only at night audit. (TDD §6)
- **Folio lines are immutable.** Corrections are reversing entries, never updates. (TDD §6)

## Build progress (TDD §12)

- [x] 1 — Scaffold: Turborepo, Next.js, NestJS, Postgres+Valkey, CI
- [x] 2 — Shared kernel: money, business-date, state machine _(outbox + audit interceptor pending)_
- [ ] 3 — Identity + property: auth, RBAC guards, property context, seed
- [ ] 4 — Inventory: room types, rooms, rate plans
- [ ] 5 — Reservations core: availability engine + create/modify/cancel
- [ ] 6 — Tape chart UI + subscriptions
- [ ] 7 — Guests module
- [ ] 8 — Check-in/out + room assignment
- [ ] 9 — Folio: postings, payments, voids, invoice
- [ ] 10 — Night audit
- [ ] 11 — Reports: occupancy, ADR, RevPAR
- [ ] 12 — E2E hardening + pilot
