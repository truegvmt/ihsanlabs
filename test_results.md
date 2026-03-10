# test_results.md — v9.1 Validation
> Stage 3 | 2026-03-09

## Static Analysis (pre-install)

| Check | Status | Evidence |
|-------|--------|---------|
| `apps/web/package.json` is valid JSON | PASS | Created, 29 lines |
| `apps/web/tsconfig.json` extends root | PASS | `"extends": "../../tsconfig.json"` |
| `apps/web/next.config.js` parses | PASS | No syntax errors |
| `apps/web/app/layout.tsx` is valid TSX | PASS | metadata + viewport exports present |
| `apps/web/app/page.tsx` is valid TSX | PASS | `"use client"`, all hooks typed |
| `apps/web/app/api/allocate/route.ts` | PASS | Exports `POST`, typed request body |
| `apps/web/app/api/donations/route.ts` | PASS | Exports `POST` + `GET` |
| `apps/web/app/api/metrics/route.ts` | PASS | Exports `GET` + `POST` |
| `supabase/migrations/002_iati_etl.sql` | PASS | 4 tables + 3 views + RLS |
| `docker-compose.yml` deleted | PASS | Not found in repo |
| `infra/` deleted | PASS | Not found in repo |
| `ingest-pdfs.sh` deleted | PASS | Not found in scripts/ |
| `.env.example` has `NEXT_PUBLIC_*` only | PASS | Simplified to 8 vars |
| `discrepancies.md` present | PASS | DELETE/MIGRATE/UPDATE format |
| `architecture-decision.md` present | PASS | Single-paragraph ADR |
| PWA `manifest.json` present | PASS | `apps/web/public/manifest.json` |

## Runtime Checks (must run locally after `pnpm install`)

| Check | Status | Command |
|-------|--------|---------|
| `pnpm install` succeeds | PENDING | Run from repo root |
| `pnpm --filter web dev` starts | PENDING | Port 3000 |
| `pnpm --filter web build` succeeds | PENDING | |
| `POST /api/allocate` → 200 | PENDING | Requires Supabase running |
| `GET /api/metrics?intent=water` → 200 | PENDING | Requires nl-sql-handler deployed |
| `POST /api/donations` → 201 | PENDING | Requires Stripe key |
| `supabase db push` → migration applied | PENDING | Both 001 + 002 |
| No 404s from legacy routes | PASS (static) | No legacy route files exist |
| PWA install prompt visible | PENDING | `pnpm build` + load in Chrome |
| `vercel build` succeeds | PENDING | `npx vercel build` |

## SLO Check (target post-deploy)

| SLO | Target | Status |
|-----|--------|--------|
| `/api/allocate` P95 latency | < 2000ms | PENDING — needs Anthropic live |
| `/api/metrics` SQL queries | < 50ms | PENDING — needs DB seeded |
| NL-SQL full round-trip | < 1500ms | PENDING |
| First Contentful Paint (index) | < 1.5s | PENDING |
| PWA offline form cache | Works offline | PENDING |
