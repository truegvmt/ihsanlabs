## discrepancies.md — v9.1 Cleanup Scan
> Repo: truegvmt/ihsanlabs | Scanned: 2026-03-09

---

### DELETE

- `docker-compose.yml` — Docker infra, removed from Vercel target architecture
- `infra/docker-compose.yml` — duplicate, same reason
- `ingest-pdfs.sh` (root) — PDF-RAG primary pipeline, superseded by IATI ETL
- `scripts/ingest-pdfs.sh` — same
- `index.html` — Phase 0 prototype, superseded by Next.js app at `apps/web/`
- `index.ts` (root) — legacy entry, real edge fn now at `supabase/functions/allocation-optimizer/index.ts`
- `rag-pipeline.md` — describes PDF-first RAG pipeline no longer primary
- `graphql.md` — Charity Navigator GraphQL as primary data source, superseded by IATI

---

### MIGRATE

- `index.html` donor flow → `apps/web/app/page.tsx` (Next.js App Router)
- `supabase/functions/allocation-optimizer/` → keep as Supabase edge fn (called from `apps/web/app/api/allocate/route.ts`)
- `supabase/functions/due-diligence/` → keep as Supabase edge fn (called from `apps/web/app/api/due-diligence/route.ts`)
- `scripts/seed-projects.sh` → keep (runs against Supabase DB)
- `scripts/ingest-iati.sh` + `scripts/parse_iati.py` → keep (IATI ETL, runs independently)
- `001_initial_schema.sql` (root) → already at `supabase/migrations/001_initial_schema.sql` ✅

---

### UPDATE

- `README.md` — remove Docker quickstart; replace with `pnpm install && pnpm dev && vercel deploy`
- `technical.md` — remove Docker stack section; update stack to Next.js App Router
- `architecture.md` — remove Docker/Redis from architecture diagram
- `edge-functions.md` — add note: edge fns are called from Next.js API routes, not directly
- `scoring-model.md` — remove "PDF RAG primary source" framing
- `.env.example` — simplify to `NEXT_PUBLIC_*`, `SUPABASE_*`, `IATI_*`, `ANTHROPIC_API_KEY`
- `tsconfig.json` — update `include` to cover `apps/**/*` once `apps/web/` is created
