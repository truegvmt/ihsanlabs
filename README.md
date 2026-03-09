# Ihsan Labs — Waqf & Charity Intelligence Engine

> **Excellence in action. Ethical intelligence.**  
> The OpenAI for philanthropy — a 2030-grade donor experience for Muslim charitable giving.

---

## What This Is

Ihsan Labs is a frictionless platform that helps Muslims allocate charity and waqf funds to the highest-impact opportunities. It combines verified nonprofit data, RAG-powered AI analysis, and a spiritually resonant UX into a single decision system.

A donor states their intention, budget, and region in under 15 seconds. The system returns a soul-calibrated allocation plan — verified, scored, cited, and executable in one tap.

---

## Repository Structure

```
ihsan-labs/
├── apps/
│   ├── web/                  # Next.js 14 frontend (donor experience)
│   └── api/                  # Node/Express API layer
├── packages/
│   ├── ai-engine/            # LLM prompt templates, chain orchestration
│   ├── rag-pipeline/         # PDF ingestion, chunking, embedding, retrieval
│   └── scoring/              # Deterministic impact + barakah scorer
├── supabase/
│   ├── migrations/           # Unified schema.sql + incremental migrations
│   └── functions/            # Edge functions (Deno/TypeScript)
│       ├── allocation-optimizer/
│       ├── due-diligence/
│       ├── micro-update-composer/
│       └── waqf-agent/
├── docs/
│   ├── product.md            # Human-first UX spec, brand, donor journey, KPIs
│   ├── technical.md          # Engineering reference: stack, setup, DB, AI layer
│   ├── architecture.md       # System design & data flow diagrams
│   ├── graphql.md            # Charity Navigator GraphQL — beginner step-by-step
│   ├── rag-pipeline.md       # RAG ingestion, chunking, embedding, retrieval
│   ├── scoring-model.md      # Barakah score methodology & weight tables
│   ├── prompt-templates.md   # All LLM prompts (A–E) with full I/O schemas
│   ├── edge-functions.md     # Edge function specs, request/response, deployment
│   └── roadmap.md            # Phased implementation roadmap (Phases 0–3)
├── scripts/
│   ├── seed-projects.sh      # Seed initial project data
│   ├── ingest-pdfs.sh        # Batch PDF ingestion for RAG
│   └── deploy.sh             # Full deployment script
└── infra/
    └── docker-compose.yml    # Local dev stack
```

---

## Core Principles

1. **Latency ≤ 2s** for all core donor flows.
2. **Evidence in triplicate**: every recommendation shows audit hash + provenance link + document snapshot.
3. **Privacy-by-default**: minimal PII; federated where possible.
4. **LLMs on RAG'd evidence only**: no hallucinated claims; every output carries chunk citations.
5. **Immutable audit trail**: every action, score, and payment is hashed and logged.

---

## Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env.example .env
# Fill in: SUPABASE_URL, SUPABASE_ANON_KEY, ANTHROPIC_API_KEY,
#          CHARITY_NAVIGATOR_API_KEY, GLOBALGIVING_API_KEY

# 3. Run database migrations
pnpm supabase db push

# 4. Seed initial data
bash scripts/seed-projects.sh

# 5. Start development
pnpm dev
```

---

## Phase Roadmap (summary)

| Phase | Timeline | Deliverable |
|-------|----------|-------------|
| 0 — MVP | 0–3 months | Intention Tap + Resonance Preview + Charity Navigator integration + Living Waqf Card |
| 1 — Trust | 3–6 months | RAG ingestion + LLM due diligence + cryptographic receipts |
| 2 — Automation | 6–12 months | Autonomous agents + IoT telemetry + federated personalization |
| 3 — 2030-grade | 12–36 months | ZK attestations + digital twins + AR site visits |

See [`docs/roadmap.md`](docs/roadmap.md) for full detail.

---

## Branding

**Ihsan Labs** — from *iḥsān* (إحسان): to do something with excellence and full awareness of the divine witness.  
Clean. Minimal. Purposeful. Every pixel earns its place.

---

*Built for the ummah. Verified for scholars. Trusted by donors.*
