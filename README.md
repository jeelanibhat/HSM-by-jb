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

A dev server is reading a *production* build output (or vice versa). Next's error blames
the RSC bundler, which is misleading — your code is fine, the build directory is not.

This should no longer be reachable: `next.config.ts` gives dev and prod separate output
directories (`.next-dev` vs `.next`) precisely because `pnpm build` while `pnpm dev` is
running used to clobber one with the other. If you somehow hit it anyway:

```bash
rm -rf apps/web/.next apps/web/.next-dev && pnpm --filter @hotelos/web dev
```

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

## Expand → migrate → contract, worked through

Guest ID numbers moved from a plaintext `guests.id_number` column to AES-256-GCM
ciphertext + an HMAC blind index. That was shipped in three releases, never one —
TDD §10: *"never destructive in one release"*.

| | migration | what it did |
|---|---|---|
| **expand**   | `0010` | added `id_number_{encrypted,hash,masked}`; both columns live |
| **migrate**  | —      | writes go through `PiiCipher`; nothing reads the old column |
| **contract** | `0017` | drops `id_number` |

`0017` is guarded: it counts the rows still holding plaintext and **raises** rather
than dropping them. A contract migration that destroys un-migrated data is not a
migration, it is an incident. If that guard ever fires, backfill through `PiiCipher`
(application-side — it cannot be encrypted in SQL, which is the whole point; see
`pii-cipher.ts`) and re-run.

## Back up `PII_ENCRYPTION_KEY` somewhere that is not the database backup

The ciphertext is worthless without the key, which is the entire security property —
a stolen dump yields nothing. It also means **losing the key loses every guest ID
number**, permanently, with the database perfectly intact. Store it in a secret
manager, not in the same bucket as the dumps.

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
