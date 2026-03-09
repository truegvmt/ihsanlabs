# Phased Roadmap — Ihsan Labs
## docs/roadmap.md
<!-- VIBE-CODER: Update phase status markers ([COMPLETE], [IN PROGRESS], [PLANNED]) as work advances -->
<!-- [ROADMAP_VERSION]: 1.0.0 -->

---

## Guiding Principle

Build the emotional UX and the high-trust data backbone in parallel. The UX sells; the data guarantees impact. Every phase must be shippable and testable on its own — no phase requires the next to deliver value to donors.

---

## Phase 0 — MVP (Months 0–3) [PLANNED]

The goal of Phase 0 is to prove the core loop: a donor states an intention, receives a credible allocation plan in under 2 seconds, and can give in a single tap. Everything else is scaffolding.

**What to build.** The Intention Tap and Resonance Preview UI (the `apps/web` single-page experience). The deterministic scorer in `packages/scoring`, operating against a manually curated set of 20–50 seed projects across the five primary focus categories. The `allocation-optimizer` edge function, wired to the seed data with a simple barakah-weight calculation. The Charity Navigator GraphQL integration with a 7-day Postgres cache, so the top-rated organizations for each cause category are always available within 50ms. Auto-generated evocative lines using Prompt A (the reflection layer). A minimal Living Waqf Card: title, status, and a static "first update pending" message. Cryptographic receipt generation (SHA-256 hash of payment data, stored locally — no blockchain anchor yet).

**What to skip.** Full PDF ingestion. GlobalGiving integration. The due-diligence LLM call on the critical path. Agent automation. Anything requiring IoT.

**Success metric.** A donor can complete the full flow — intention to receipt — in under 3 minutes. The allocation plan returns in under 2 seconds for any of the five focus categories.

---

## Phase 1 — Trust & Scale (Months 3–6) [PLANNED]

The goal of Phase 1 is to make every recommendation evidenced, audited, and explainable.

**What to build.** The RAG ingestion pipeline in `packages/rag-pipeline`: PDF fetching, chunking at 512-token boundaries, embedding via `text-embedding-3-small`, and upsert into `document_chunks` with deduplication by `pdf_hash`. The GlobalGiving REST API integration, syncing project-level data nightly. The `due-diligence` edge function (Prompt B), surfaced via the "Explain" button on the Resonance Preview. Immutable blockchain anchoring for payment receipts (a simple anchored-hash notarization service — Chainpoint or equivalent). The micro-update composer edge function, triggered by partner webhook events. The donor journal (annual reflection entry, private by default). Full `audit_log` instrumentation across all functions.

**Success metric.** Every allocation plan links to at least one verified document chunk. The "Explain" panel loads with a structured risk report in under 5 seconds. Due-diligence reports are cached and served in under 200ms on repeat views.

---

## Phase 2 — Automation & Impact (Months 6–12) [PLANNED]

The goal of Phase 2 is to make the platform proactive rather than reactive.

**What to build.** The `waqf-agent` edge function (Prompt C) with full policy enforcement: contingency balance checks, excluded-region guards, auto-execute threshold. The signal ingestion pipeline: a lightweight service that monitors ACAPS, ReliefWeb, and satellite alert APIs and inserts `agent_signals` records. IoT telemetry integration for priority waqf asset classes (solar pumps, boreholes): a LoRa/cellular data bridge that streams sensor readings into `waqf_assets.digital_twin_data` and triggers maintenance alerts. Federated personalization: client-side intention vectors updated on-device and synced to `donor_profiles.intention_vector` without exposing raw behavioral data.

**Success metric.** At least 10% of active waqf assets have live telemetry. The agent correctly proposes or executes at least one reallocation during a simulated crisis signal test. Donor retention at 6-month mark exceeds 40% (measured by at least one Living Waqf Card view per month per donor).

---

## Phase 3 — 2030-Grade (Months 12–36) [PLANNED]

The goal of Phase 3 is to make Ihsan Labs the trust infrastructure for Islamic philanthropy globally.

**What to build.** Verifiable attestation pipeline: partners sign structured impact reports using a keypair issued by Ihsan. The system verifies each signature and publishes an attestation to the donor's ledger. Optional ZK proof layer for claim minimization (prove a beneficiary count is above a threshold without revealing the exact figure). Digital twin dashboard for physical waqf assets: a donor-facing view of procurement records, service logs, sensor streams, and predicted maintenance windows. Multimodal evidence verification: vision models that cross-check field photos against reported beneficiary counts, flagging discrepancies. AR site visits: integration with a partner field survey tool that allows donors to view a 360° photo tour of their funded asset, linked directly from the Living Waqf Card.

**Success metric.** At least 50% of active waqf assets have a signed attestation. Digital twin data is available for at least 20 assets. Donor Net Promoter Score exceeds 60.

---

## Immediate Next Steps (Do These First)

Three actions generate the highest leverage for the least effort in Phase 0.

First, build the Intention Tap and Resonance Preview and wire them to the seed data in Supabase. This is the fastest way to test emotional conversion — the moment a donor sees their barakah score and evocative line, you will know whether the UX is working.

Second, stand up the Charity Navigator GraphQL integration with the caching layer. This gives every allocation plan a credible organization score within Phase 0 without requiring any PDF ingestion.

Third, add the due-diligence LLM call (Prompt B) behind the "Explain" button. This is the trust signal that converts skeptical donors — it should be ready before any public launch.

---
<!-- VIBE-CODER SECTION -->
<!-- [PHASE_0_STATUS]: PLANNED -->
<!-- [PHASE_1_STATUS]: PLANNED -->
<!-- [PHASE_2_STATUS]: PLANNED -->
<!-- [PHASE_3_STATUS]: PLANNED -->
<!-- [CURRENT_PHASE]: 0 -->
