# Ihsan Labs — Technical Reference
## docs/technical.md
<!-- VIBE-CODER: This is the canonical engineering reference. Update [TECH_VERSION] on any stack change, dependency upgrade, or infrastructure decision. Sections marked [UPDATE ON CHANGE] must be kept current with the codebase — stale technical docs are worse than none. -->
<!-- [TECH_VERSION]: 1.0.0 -->
<!-- [LAST_REVIEWED]: 2025 -->
<!-- [NODE_VERSION]: 20 LTS -->
<!-- [DENO_VERSION]: 1.x (Supabase Edge runtime) -->
<!-- [PNPM_VERSION]: 8.x -->

---

## Stack Overview

Ihsan Labs is a TypeScript monorepo. The frontend is a Next.js 14 application. The intelligence API runs as Deno edge functions on Supabase. The data layer is Supabase Postgres with pgvector for RAG embeddings. Background processing (PDF ingestion, nightly syncs) runs as Node.js workers. There is no custom auth service — Supabase Auth handles all authentication.

```
ihsan-labs/
├── apps/
│   ├── web/                  # Next.js 14 + Tailwind — donor experience
│   └── api/                  # Node/Express — background workers, admin API
├── packages/
│   ├── ai-engine/            # LLM chain orchestration, prompt runners
│   ├── rag-pipeline/         # PDF ingestion, chunking, embedding, retrieval
│   └── scoring/              # Deterministic impact + barakah scorer (pure TS)
├── supabase/
│   ├── migrations/           # 001_initial_schema.sql + incremental migrations
│   └── functions/            # Four Deno edge functions
│       ├── allocation-optimizer/
│       ├── due-diligence/
│       ├── micro-update-composer/
│       └── waqf-agent/
├── docs/                     # Product and technical documentation
├── scripts/                  # deploy.sh, seed-projects.sh, ingest-pdfs.sh
└── infra/
    └── docker-compose.yml    # Local dev stack (Supabase, Redis optional)
```

---

## Prerequisites

Before starting development, ensure the following are installed and configured.

Node.js 20 LTS and pnpm 8.x are required. Install pnpm globally with `npm install -g pnpm`. The Supabase CLI is required for local development and migrations; install it with `brew install supabase/tap/supabase` on macOS or via the [official install guide](https://supabase.com/docs/guides/cli). Docker Desktop must be running for the local Supabase stack. The Deno runtime is not required locally because edge functions are tested via `supabase functions serve`, which manages the Deno runtime internally.

---

## Local Development Setup

```bash
# Clone and install
git clone https://github.com/ihsan-labs/ihsan-labs.git
cd ihsan-labs
pnpm install

# Configure environment
cp .env.example .env
# Edit .env — minimum required for local dev:
#   SUPABASE_URL=http://localhost:54321
#   SUPABASE_ANON_KEY=<from supabase start output>
#   SUPABASE_SERVICE_ROLE_KEY=<from supabase start output>
#   ANTHROPIC_API_KEY=sk-ant-...
#   CHARITY_NAVIGATOR_APP_ID=...
#   CHARITY_NAVIGATOR_APP_KEY=...

# Start local Supabase (Postgres + Auth + Storage + Edge runtime)
supabase start

# Apply schema migrations
supabase db push

# Seed initial projects and organizations
bash scripts/seed-projects.sh

# Start edge functions locally (port 54321)
supabase functions serve

# Start frontend dev server (port 3000)
pnpm --filter web dev
```

The local Supabase dashboard is available at `http://localhost:54323`. The edge functions are available at `http://localhost:54321/functions/v1/<function-name>`.

---

## Database

The full schema is defined in `supabase/migrations/001_initial_schema.sql`. The following section describes the tables that matter most during development. For full column definitions, constraints, and RLS policies, read the migration file directly — it is the authoritative source of truth.

**`organizations`** stores nonprofit data sourced from Charity Navigator and GlobalGiving. It is a read-heavy, write-rarely table. The `raw_data jsonb` column stores the full API response for auditing. The `last_synced_at` timestamp is used by the caching layer to determine whether a fresh API fetch is needed.

**`projects`** stores individual charitable and waqf projects. The `final_score` column is computed by a Postgres trigger (`trg_project_score`) whenever `impact_score` or `llm_score` changes, so callers should never write `final_score` directly. The `barakah_weight` column is set by the scoring package on ingestion using the expert-encoded taxonomy in `packages/scoring/src/baraka.ts`.

**`document_chunks`** stores the RAG corpus. Each row contains a 512-token text fragment, its 1536-dimensional embedding vector, and provenance metadata (source URL, PDF hash, scrape date). The `embedding` column uses pgvector's `vector(1536)` type and is indexed with IVFFlat (`lists = 100`) for sub-50ms similarity search at 100k+ rows.

**`allocation_plans`** and **`donations`** are linked by a nullable foreign key. An allocation plan is created before payment is processed; a donation row is created and linked to the plan when payment confirms.

**`audit_log`** is append-only. The RLS policy allows INSERT but not UPDATE or DELETE for any role, including `service_role`. It records every consequential system action: plan generation, due-diligence runs, agent actions, and payment confirmations. Never truncate or delete from this table.

### Running migrations

```bash
# Push all pending migrations to local or linked project
supabase db push

# Create a new incremental migration
supabase migration new <migration_name>
# Edit the generated file in supabase/migrations/
# Then: supabase db push
```

### Similarity search function

The `match_chunks` Postgres function is defined in the schema and is the only way the edge functions retrieve RAG context. Call it with a 1536-dimensional query embedding, a similarity threshold (0.6–0.8 recommended), a result count (3–5 recommended), and an optional `filter_project_id` to scope retrieval to a single project.

```sql
select * from match_chunks(
  query_embedding := '[0.1, 0.2, ...]'::vector,
  match_threshold := 0.72,
  match_count := 5,
  filter_project_id := 'uuid-here'
);
```

---

## Edge Functions

All four edge functions are in `supabase/functions/`. Each is a single `index.ts` file that imports from `https://deno.land/std` and `https://esm.sh/@supabase/supabase-js`. They share no code between them — each is fully self-contained to keep deployment simple and blast radius small. For full request/response specs, see `docs/edge-functions.md`.

### Calling edge functions from the frontend

```typescript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const { data, error } = await supabase.functions.invoke('allocation-optimizer', {
  body: {
    intention_id: 'uuid',
    focus: 'water',
    region: 'pk',
    budget_usd: 500,
    horizon: 'perpetual',
  },
});
```

### Adding secrets for local development

```bash
# Secrets used inside edge functions are set via supabase secrets
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set CHARITY_NAVIGATOR_APP_ID=...
supabase secrets set CHARITY_NAVIGATOR_APP_KEY=...
```

### LLM failure handling

Every edge function wraps its Anthropic API call in a try/catch. If the call fails for any reason (timeout, rate limit, malformed response), the function returns a deterministic-only response using its scoring fallback. The LLM failure is logged to `audit_log` with `action: 'llm_call_failed'`. The donor always receives a response — never a 500 error because the LLM was unavailable.

---

## RAG Pipeline

The RAG pipeline runs as a Node.js worker in `packages/rag-pipeline/`. It is not in the critical path of any real-time donor flow. It runs on a nightly schedule (top-100 projects) and a weekly schedule (full corpus refresh).

**Chunking strategy.** Documents are split at 512-token boundaries with a 50-token overlap using the `@anthropic-ai/tokenizer` package. Chunk boundaries respect sentence endings where possible. Each chunk carries metadata: `source_url`, `pdf_hash` (SHA-256 of the full document), `scrape_date`, `page_number`, and `doc_type` (`annual_report | field_report | audit | news`).

**Deduplication.** Before upserting a chunk batch, the pipeline checks whether a document with the same `pdf_hash` already exists in `document_chunks`. If it does, the document is skipped entirely. This prevents re-embedding documents that have not changed between runs.

**Embedding model.** All embeddings are generated using OpenAI `text-embedding-3-small` (1536 dimensions). This model was chosen over larger alternatives for its balance of retrieval quality and cost at the expected corpus scale (100k–1M chunks). The model string is set in `packages/rag-pipeline/src/config.ts` and must be updated if the model changes, since the embedding dimension is also encoded in the Postgres schema.

**Running the pipeline manually:**

```bash
bash scripts/ingest-pdfs.sh
# Or directly:
pnpm --filter rag-pipeline start --source globalgiving --limit 100
pnpm --filter rag-pipeline start --source partner-pdfs --url https://example.org/report.pdf
```

---

## Scoring Engine

The scoring engine (`packages/scoring/`) is a pure TypeScript module with no network calls and no side effects. It takes a structured project input and returns a deterministic float between 0 and 100. The LLM then applies a ±10 adjustment on top of this base — the deterministic score is never replaced, only nudged.

**Scoring weights** (defined in `packages/scoring/src/weights.ts`):

| Factor | Weight | Source |
|--------|--------|--------|
| Charity Navigator overall score | 35% | `organizations.overall_score` |
| External audit present | 20% | RAG chunk signal |
| Maintenance plan documented | 15% | RAG chunk signal |
| Beneficiary count corroborated | 15% | RAG chunk signal |
| Project duration (capped at 60 months) | 15% | `projects.estimated_duration_months` |

**Barakah weight taxonomy** (defined in `packages/scoring/src/barakah.ts`):

| Focus | Multiplier | Basis |
|-------|-----------|-------|
| water | 1.5 | Hadith: "the best sadaqah is giving water" |
| mosque | 1.4 | Ongoing worship space |
| education | 1.4 | Knowledge that outlives the donor |
| quran | 1.3 | Preservation of revelation |
| orphan | 1.3 | Prophetic emphasis |
| healthcare | 1.2 | Sustained physiological benefit |
| food | 1.1 | Essential but less perpetual |
| shelter | 1.1 | Essential but less perpetual |
| general | 1.0 | Baseline |

The barakah multiplier is applied to the deterministic base score before the LLM adjustment. A water project with a base score of 70 and a perpetual horizon bonus of 10 reaches 80 × 1.5 = 120, which is then clamped to 100. In practice the multiplier increases a project's ranking within its focus category but does not override quality signals from the deterministic weights.

---

## AI / LLM Layer

All Anthropic API calls are orchestrated in `packages/ai-engine/src/chainRunner.ts`. The runner always performs the same sequence: retrieve relevant chunks → assemble input JSON → call Anthropic API → strip markdown fences from response → parse and validate JSON → write result and metadata to audit_log → return to caller.

The model used across all prompts is `claude-sonnet-4-20250514`. The `max_tokens` cap per prompt is 1000 for the allocation optimizer's Prompt A, 900 for Prompt B (due diligence), 600 for Prompt C (agent), 400 for Prompt D (micro-update), and 700 for Prompt E (annual reflection). These caps are set in `packages/ai-engine/src/config.ts`.

**Adding a new prompt.** Create the prompt template in `docs/prompt-templates.md` first (the product spec), then implement the corresponding runner function in `packages/ai-engine/src/prompts/`. The runner must validate the JSON output against a Zod schema before returning it. Never return raw LLM text to a caller — always parse and validate.

---

## Authentication

Authentication is handled entirely by Supabase Auth. The frontend uses the Supabase JS client with the anon key. All protected routes check `supabase.auth.getSession()`. The edge functions validate the JWT attached to the request automatically via the Supabase Edge runtime.

Anonymous donations are supported in Phase 0: an `intentions` record can be created with `donor_id = null` and a `session_id` string for tracking. Anonymous sessions are not linked to a user account and will not have a Living Waqf Card or journal unless the donor creates an account and the session is claimed.

There are no custom auth tables in the schema. If you need to extend the auth user object, use the `donor_profiles` table, which has a `user_id` foreign key referencing `auth.users(id)`.

---

## Payments

Phase 0 uses Stripe for card payments. The Stripe integration lives in `apps/api/src/payments/`. The flow is: frontend calls `POST /api/payments/create-intent` → API creates a Stripe PaymentIntent → frontend confirms with the Stripe JS SDK → on success, calls `POST /api/payments/confirm` → API creates the `donations` record, generates the receipt hash, and triggers the Living Waqf Card activation.

Receipt hash generation: `sha256(stripe_payment_id + project_id + amount_usd + timestamp)`. The hash is stored in `donations.receipt_hash` and displayed to the donor. Optional blockchain anchoring (Phase 1) will post this hash to a notarization service and store the anchor transaction ID in `donations.ledger_anchor`.

---

## Testing

```bash
# Unit tests (scoring engine, prompt parsing, chunk matching)
pnpm test

# Integration tests (edge functions against local Supabase)
pnpm test:integration

# Type checking across the monorepo
pnpm typecheck
```

Edge function integration tests use `supabase/functions/tests/` and run against the local Supabase stack. Each test seeds the required database state, invokes the function via HTTP, and asserts on the response shape and the audit_log record created.

---

## Deployment

See `scripts/deploy.sh` for the full deployment script. The short version:

```bash
# Staging
bash scripts/deploy.sh staging

# Production
bash scripts/deploy.sh production
```

The script validates environment variables, pushes migrations, sets Supabase secrets, deploys all four edge functions, builds the frontend, and (for staging only) runs the seed script.

---
<!-- VIBE-CODER SECTION — UPDATE ON CHANGE -->
<!-- [EMBEDDING_MODEL]: text-embedding-3-small -->
<!-- [EMBEDDING_DIMS]: 1536 -->
<!-- [LLM_MODEL]: claude-sonnet-4-20250514 -->
<!-- [CHUNK_SIZE_TOKENS]: 512 -->
<!-- [CHUNK_OVERLAP_TOKENS]: 50 -->
<!-- [IVFFLAT_LISTS]: 100 -->
<!-- [SIMILARITY_THRESHOLD_DEFAULT]: 0.72 -->
<!-- [SCORE_WEIGHTS_FILE]: packages/scoring/src/weights.ts -->
<!-- [BARAKAH_WEIGHTS_FILE]: packages/scoring/src/barakah.ts -->
<!-- [PROMPT_CONFIG_FILE]: packages/ai-engine/src/config.ts -->
<!-- [STRIPE_FLOW]: create-intent → client confirm → server confirm -->
<!-- [RECEIPT_HASH_ALGO]: sha256(payment_id + project_id + amount + timestamp) -->
