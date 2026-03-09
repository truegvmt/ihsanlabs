# System Architecture — Ihsan Labs
## docs/architecture.md
<!-- VIBE-CODER: Update [ARCH_VERSION] and data flow diagrams when new services are added -->
<!-- [ARCH_VERSION]: 1.0.0 -->
<!-- [LAST_REVIEWED]: 2025 -->

---

## Overview

Ihsan Labs is a three-layer system: a donor-facing frontend, a set of Supabase Edge Functions that form the intelligence API, and a data backbone combining a relational store (Postgres via Supabase), a vector store (pgvector), and an immutable audit log.

The design principle is **evidence-first, latency-minimised**. All AI-generated outputs are grounded in retrieved document chunks. No LLM call is made without attached evidence, and every output is logged before it is returned to the client.

---

## High-Level Data Flow

```
Donor (mobile / web)
    │
    │  POST /functions/v1/allocation-optimizer
    │  {intention_id, focus, region, budget_usd, horizon}
    ▼
┌─────────────────────────────────────────────────────┐
│  Edge Function: allocation-optimizer                │
│  1. Fetch candidate projects from Postgres cache    │
│  2. Deterministic score (org rating × barakah wt)  │
│  3. match_chunks() — pgvector similarity search     │
│  4. Anthropic API (Prompt A — evocative reflection) │
│  5. Write allocation_plans + audit_log              │
└─────────────────────────────────────────────────────┘
    │
    │  Response: {plan_id, allocations, evocative_line,
    │             barakah_score, voice_text, dua_template}
    ▼
Donor sees Resonance Preview (≤ 2s)

    │  (optional) GET /functions/v1/due-diligence
    │  {project_id}
    ▼
┌─────────────────────────────────────────────────────┐
│  Edge Function: due-diligence                       │
│  1. Check cache (due_diligence_reports, 7-day TTL)  │
│  2. Deterministic score from chunks + org data      │
│  3. Anthropic API (Prompt B — structured risk JSON) │
│  4. Upsert due_diligence_reports + update projects  │
└─────────────────────────────────────────────────────┘

    │  (ongoing) Event-driven micro-updates
    │  {event_type: field_report | maintenance | issue}
    ▼
┌─────────────────────────────────────────────────────┐
│  Edge Function: micro-update-composer               │
│  1. Receive event from partner webhook              │
│  2. Retrieve latest chunk for context               │
│  3. Anthropic API (Prompt D — 1-sentence update)   │
│  4. Push notification to donor (mobile / PWA)       │
│  5. Write waqf_events + audit_log                   │
└─────────────────────────────────────────────────────┘

    │  (autonomous) Agent signal processing
    ▼
┌─────────────────────────────────────────────────────┐
│  Edge Function: waqf-agent                          │
│  1. Ingest signal (crisis, outage, price shock)     │
│  2. Fetch donor_policy from donor_profiles          │
│  3. Anthropic API (Prompt C — policy composer)      │
│  4. Execute or propose based on auto_execute_thresh │
│  5. Write agent_actions + audit_log                 │
└─────────────────────────────────────────────────────┘
```

---

## Component Responsibilities

### Frontend (`apps/web`)

A Next.js 14 application (or standalone HTML/PWA for Phase 0). Responsible for the full donor journey: Intention Tap → Resonance Preview → Reflection → Approval → Living Waqf Card. Communicates exclusively with Supabase Edge Functions and the Supabase client SDK. Stores no sensitive data in the browser beyond the authenticated session token.

### API Layer (`apps/api`)

A lightweight Node/Express service that handles Charity Navigator GraphQL fetches, GlobalGiving API calls, and the RAG ingestion pipeline (PDF parsing, chunking, embedding). This is a background service — it does not sit in the critical path of the sub-2s donor flow.

### Edge Functions (`supabase/functions/`)

Four Deno-based functions deployed to Supabase Edge. Each function is stateless, receives a JSON payload, performs its intelligence work, writes results to Postgres, and returns a structured JSON response. Details in `docs/edge-functions.md`.

### RAG Pipeline (`packages/rag-pipeline/`)

A batch pipeline that runs on schedule (nightly for top 100 projects, weekly for full corpus). It fetches PDFs from partner URLs and GlobalGiving project pages, chunks them at 512-token boundaries with 50-token overlap, generates embeddings via OpenAI `text-embedding-3-small`, and upserts into `document_chunks` with `pdf_hash` for deduplication.

### Scoring Engine (`packages/scoring/`)

A pure TypeScript module (no side effects) that implements the deterministic composite scorer. Input: organization rating, barakah weight, chunk signals (audit present, maintenance plan present, beneficiary data present), duration. Output: a float 0–100. This score is passed to the LLM as context — the LLM applies a ±10 adjustment, never replaces the deterministic base.

---

## Latency Budget

The sub-2s target for the core donor flow (Intention Tap → Resonance Preview) is achieved through three mechanisms.

First, the candidate project set is pre-ranked and cached in Postgres. The `allocation-optimizer` function does not make external API calls during the scoring phase — it reads from the local database.

Second, the LLM call (evocative reflection) runs against a small input: three retrieved chunks plus a one-paragraph project summary. At `max_tokens: 600`, the Anthropic API typically responds in 800ms–1.2s from an edge node.

Third, pgvector similarity search with IVFFlat indexing returns in under 50ms for the 100k-chunk corpus.

The due-diligence report and agent computations run outside the critical path and can take 3–5s without impacting the core UX.

---

## Evidence & Audit Trail

Every LLM-generated output is associated with a set of `chunk_ids` that were provided in the context. These IDs are stored in `allocation_plans.chunks_used`, `due_diligence_reports.chunks_used`, and `audit_log.chunks_used`. A donor or auditor can always trace any recommendation back to the exact PDF page from which supporting evidence was drawn.

The `audit_log` table is append-only (enforced by RLS: no UPDATE or DELETE policies). It records every allocation plan generation, due-diligence run, agent action, and payment confirmation, along with the deterministic score and the `llm_output_id` returned by the Anthropic API.

---

## External Data Sources

**Charity Navigator** is queried via GraphQL for organization-level ratings (financial health, accountability score, advisories). Data is cached in the `organizations` table with a 7-day TTL. See `docs/graphql.md` for the full integration guide.

**GlobalGiving** is queried via its REST API for project-level data: title, description, region, funding status, and partner reports. Project data is synced nightly and stored in `projects`.

**Partner field reports** are ingested as PDFs via the RAG pipeline. Partners submit report URLs to the Ihsan admin API; the pipeline fetches, hashes, and ingests each report within the nightly batch.

**IoT telemetry** (Phase 2+) is received via a dedicated MQTT broker and stored in `waqf_assets.digital_twin_data` as time-series snapshots.

---
<!-- VIBE-CODER SECTION -->
<!-- [DATA_SOURCES]: charity_navigator, globalgiving, partner_pdfs, iot_telemetry(phase2) -->
<!-- [VECTOR_MODEL]: text-embedding-3-small (1536 dims) -->
<!-- [LLM_MODEL]: claude-sonnet-4-20250514 -->
<!-- [CACHE_LAYER]: postgres (organizations: 7d TTL, due_diligence_reports: 7d TTL) -->
