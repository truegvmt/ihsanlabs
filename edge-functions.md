# Edge Functions — Ihsan Labs
## docs/edge-functions.md
<!-- VIBE-CODER: Update [FUNCTION_VERSION] and endpoint specs when signatures change -->
<!-- [FUNCTION_VERSION]: 1.0.0 -->

All edge functions are deployed as Deno serverless functions on Supabase Edge. They share a single environment (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, etc.) and are called by the frontend via the Supabase client or direct fetch.

---

## Function 1: `allocation-optimizer`

**Endpoint:** `POST /functions/v1/allocation-optimizer`  
**Auth:** Supabase JWT (anon key is sufficient; service role is NOT required from client)  
**Latency target:** ≤ 2s  
**Called by:** Intention Tap flow, immediately after the donor submits their intention

**Request body:**
```json
{
  "intention_id": "uuid",
  "focus": "water | education | food | healthcare | mosque | orphan | general",
  "region": "ISO country code or 'global'",
  "budget_usd": 500,
  "horizon": "one_time | monthly | perpetual",
  "donor_id": "uuid (optional, null for anonymous)"
}
```

**Response:**
```json
{
  "plan_id": "uuid",
  "allocations": [{ "project_id": "uuid", "project_title": "string", "amount_usd": 425, "pct": 85, "reason": "string" }],
  "top_project": { "id": "uuid", "title": "string", "estimated_beneficiaries": 340, "estimated_duration_months": 60, "is_waqf_eligible": true },
  "evocative_line": "string",
  "barakah_score": 87,
  "voice_text": "string",
  "dua_template": "string",
  "spiritual_note": "string",
  "citations": ["chunk_id_1"]
}
```

**Internal steps:** (1) fetch top-20 candidate projects from Postgres by focus+region, (2) apply deterministic composite score, (3) retrieve top-3 chunks via `match_chunks()`, (4) call Anthropic API (Prompt A), (5) write `allocation_plans` record, (6) append `audit_log` entry, (7) return response.

**Failure modes:** If the Anthropic call fails, the function returns a deterministic-only plan with a fallback `evocative_line`. This is non-fatal and logged. If no candidate projects are found, the function returns `{ "error": "No candidates found" }` with HTTP 200 so the client can handle the empty state gracefully.

---

## Function 2: `due-diligence`

**Endpoint:** `POST /functions/v1/due-diligence`  
**Auth:** Supabase JWT  
**Latency target:** ≤ 5s (runs outside the critical path)  
**Called by:** "Explain" button on the Resonance Preview; also triggered automatically when a new document chunk is ingested for a project

**Request body:**
```json
{
  "project_id": "uuid",
  "force_refresh": false
}
```

**Response:** A full `due_diligence_reports` record (see schema).

**Caching:** If a report exists for the project with `created_at` within the last 7 days, it is returned immediately without an LLM call (`cached: true`). Pass `force_refresh: true` to bypass the cache.

**Internal steps:** (1) check cache, (2) fetch project + org data, (3) fetch up to 5 document chunks, (4) compute deterministic score, (5) call Anthropic API (Prompt B), (6) persist report, (7) update `projects.final_score`, (8) append audit log.

---

## Function 3: `micro-update-composer`

**Endpoint:** `POST /functions/v1/micro-update-composer`  
**Auth:** Service role (called by internal event pipeline, not the client)  
**Latency target:** ≤ 3s  
**Called by:** The event pipeline when a `waqf_events` record is inserted (trigger or scheduled job)

**Request body:**
```json
{
  "event_id": "uuid",
  "waqf_asset_id": "uuid",
  "event_type": "field_report | maintenance | beneficiary_story | issue",
  "raw_content": "string",
  "donor_id": "uuid"
}
```

**Response:**
```json
{
  "composed_update": "string (≤ 20 words)",
  "tone": "positive | neutral | alert",
  "action_required": false,
  "action_prompt": null
}
```

**Internal steps:** (1) fetch waqf asset details, (2) call Anthropic API (Prompt D), (3) update `waqf_events.composed_update`, (4) if `action_required`, trigger a push notification via Supabase Realtime, (5) append audit log.

---

## Function 4: `waqf-agent`

**Endpoint:** `POST /functions/v1/waqf-agent`  
**Auth:** Service role (called by scheduled cron job, not client-facing)  
**Latency target:** ≤ 8s  
**Called by:** A cron job that runs every 6 hours; also called ad-hoc when a high-severity `agent_signals` record is inserted

**Request body:**
```json
{
  "donor_id": "uuid",
  "signal_ids": ["uuid"]
}
```

**Response:** An `agent_actions` record with `action: "no_action" | "propose" | "execute"`.

**Safety guardrails enforced in this function:**
- Total reallocation never exceeds `donor_profiles.contingency_balance_usd`.
- If any single reallocation exceeds `auto_execute_threshold_usd`, action is downgraded to `propose`.
- Excluded regions are never allocated to, regardless of signal severity.
- All `execute` actions write to `audit_log` before any payment is triggered.

---

## Deployment

```bash
# Deploy all functions
supabase functions deploy allocation-optimizer
supabase functions deploy due-diligence
supabase functions deploy micro-update-composer
supabase functions deploy waqf-agent

# Set secrets (run once per environment)
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set CHARITY_NAVIGATOR_APP_ID=...
supabase secrets set CHARITY_NAVIGATOR_APP_KEY=...
supabase secrets set GLOBALGIVING_API_KEY=...
```

## Local development

```bash
supabase start                          # Start local Supabase stack
supabase functions serve               # Serve all functions locally on port 54321
```

Functions are available at `http://localhost:54321/functions/v1/<name>`.

---
<!-- VIBE-CODER SECTION -->
<!-- [FUNCTIONS]: allocation-optimizer, due-diligence, micro-update-composer, waqf-agent -->
<!-- [RUNTIME]: Deno 1.x on Supabase Edge -->
<!-- [AUTH]: JWT for client-facing; service_role for internal/cron -->
<!-- [LLM_FAILSAFE]: all functions return deterministic fallback if Anthropic call fails -->
