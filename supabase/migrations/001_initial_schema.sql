-- ============================================================
-- IHSAN LABS — UNIFIED SUPABASE SCHEMA
-- Version: 1.1.0 (Finalized for RAG & Agentic needs)
-- Last updated: 2025
-- Run: supabase db push (applies all migrations in order)
-- ============================================================

-- NOTE: Auth is handled by Supabase Auth (built-in).
-- This schema assumes auth.users exists and uses auth.uid() for RLS.
-- No custom auth tables needed.

-- ============================================================
-- EXTENSIONS
-- ============================================================

create extension if not exists "uuid-ossp";
create extension if not exists "vector";          -- pgvector for RAG embeddings
create extension if not exists "pg_trgm";         -- fuzzy search on project names
create extension if not exists "pgcrypto";        -- for hashing receipts

-- ============================================================
-- ENUMS
-- ============================================================

create type donation_status as enum ('pending', 'confirmed', 'disbursed', 'failed');
create type waqf_status as enum ('active', 'maintenance', 'suspended', 'completed');
create type project_focus as enum ('water', 'education', 'food', 'healthcare', 'shelter', 'mosque', 'quran', 'orphan', 'general');
create type time_horizon as enum ('one_time', 'monthly', 'annual', 'perpetual');
create type risk_severity as enum ('low', 'medium', 'high', 'critical');
create type signal_type as enum ('crisis', 'price_shock', 'outage', 'opportunity', 'maintenance_due');
create type agent_action as enum ('no_action', 'propose', 'execute');
create type doc_type as enum ('annual_report', 'field_report', 'audit', 'news', 'narrative');
create type ingestion_status as enum ('pending', 'processing', 'completed', 'failed');

-- ============================================================
-- DONOR PROFILES
-- Extended profile linked to auth.users
-- ============================================================

create table donor_profiles (
  id                     uuid primary key default uuid_generate_v4(),
  user_id                uuid not null references auth.users(id) on delete cascade,
  display_name           text,
  preferred_focus        project_focus[] default '{}',
  preferred_region       text,                         -- ISO country code or custom region tag
  default_horizon        time_horizon default 'one_time',
  intention_vector       vector(384),                  -- on-device embedding of recent intentions
  risk_tolerance         float default 0.5,            -- 0=conservative, 1=high-risk/high-leverage
  auto_execute_threshold_usd float default 0.0,       -- $0 = never auto-execute agent actions
  contingency_balance_usd numeric(10,2) default 0.0,   -- balance available for agentic reallocation
  spiritual_journal_private boolean default true,
  created_at             timestamptz default now(),
  updated_at             timestamptz default now(),
  unique(user_id)
);

-- ============================================================
-- ORGANIZATIONS
-- Sourced from Charity Navigator + GlobalGiving + manual entry
-- ============================================================

create table organizations (
  id                   uuid primary key default uuid_generate_v4(),
  external_id          text,                          -- Charity Navigator EIN or GlobalGiving org ID
  source               text not null,                 -- 'charity_navigator' | 'globalgiving' | 'manual'
  name                 text not null,
  ein                  text,                          -- US EIN for Charity Navigator orgs
  description          text,
  website              text,
  country              text,
  overall_score        float,                         -- 0–100 from Charity Navigator
  finance_score        float,
  accountability_score float,
  last_synced_at       timestamptz,
  raw_data             jsonb,                         -- full API response cached
  created_at           timestamptz default now(),
  updated_at           timestamptz default now()
);

create index idx_orgs_source on organizations(source);
create index idx_orgs_ein on organizations(ein);
create index idx_orgs_name_trgm on organizations using gin(name gin_trgm_ops);

-- ============================================================
-- PROJECTS
-- Individual charitable/waqf projects (water wells, schools, etc.)
-- ============================================================

create table projects (
  id                uuid primary key default uuid_generate_v4(),
  organization_id   uuid references organizations(id) on delete set null,
  external_id       text,                        -- GlobalGiving project ID or platform ref
  source            text,                        -- 'globalgiving' | 'manual' | 'partner'
  title             text not null,
  description       text,
  focus             project_focus not null,
  region            text,                        -- ISO country code
  city              text,
  latitude          float,
  longitude         float,
  funding_goal      numeric(14,2),
  funding_raised    numeric(14,2) default 0,
  currency          text default 'USD',
  is_waqf_eligible  boolean default false,       -- can this be a perpetual waqf?
  estimated_duration_months int,
  estimated_beneficiaries int,
  status            waqf_status default 'active',
  barakah_weight    float default 1.0,           -- expert-encoded multiplier
  impact_score      float default 50.0,          -- deterministic score 0–100
  llm_score         float default 0.0,           -- LLM-adjusted score (-10..+10)
  final_score       float,                       -- computed: impact_score + llm_score (clamped 0-100)
  last_due_diligence_at timestamptz,
  thumbnail_url     text,
  raw_data          jsonb,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create index idx_projects_org on projects(organization_id);
create index idx_projects_focus on projects(focus);
create index idx_projects_region on projects(region);
create index idx_projects_final_score on projects(final_score desc);
create index idx_projects_waqf on projects(is_waqf_eligible) where is_waqf_eligible = true;

-- ============================================================
-- RAG: DOCUMENT CHUNKS
-- Ingested from annual reports, PDFs, GlobalGiving pages
-- ============================================================

create table document_chunks (
  id              uuid primary key default uuid_generate_v4(),
  project_id      uuid references projects(id) on delete cascade,
  organization_id uuid references organizations(id) on delete cascade,
  source_url      text,
  source_title    text,
  pdf_hash        text,                          -- sha256 of source document
  scrape_date     timestamptz default now(),
  chunk_index     int,
  chunk_text      text not null,
  embedding       vector(1536),                  -- OpenAI text-embedding-3-small
  page_number     int,
  doc_type        doc_type default 'narrative',
  status          ingestion_status default 'completed', -- for pipeline tracking
  metadata        jsonb,                         -- verbatim storage of any extra data
  created_at      timestamptz default now()
);

create index idx_chunks_project on document_chunks(project_id);
create index idx_chunks_org on document_chunks(organization_id);
create index idx_chunks_status on document_chunks(status);
-- Vector similarity search index (IVFFlat for scale)
create index idx_chunks_embedding on document_chunks
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ============================================================
-- INTENTIONS
-- Each donor session / intention tap
-- ============================================================

create table intentions (
  id               uuid primary key default uuid_generate_v4(),
  donor_id         uuid references donor_profiles(id) on delete cascade,
  tags             text[],                        -- ['mercy', 'water', 'legacy']
  three_words      text,                          -- user's freeform "why giving" input
  horizon          time_horizon,
  region           text,
  focus            project_focus,
  budget_usd       numeric(10,2),
  intention_vector vector(384),
  session_id       text,                          -- for anonymous sessions
  created_at       timestamptz default now()
);

create index idx_intentions_donor on intentions(donor_id);
create index idx_intentions_session on intentions(session_id);

-- ============================================================
-- DONATIONS
-- ============================================================

create table donations (
  id                  uuid primary key default uuid_generate_v4(),
  donor_id            uuid references donor_profiles(id) on delete set null,
  intention_id        uuid references intentions(id) on delete set null,
  project_id          uuid not null references projects(id),
  amount_usd          numeric(10,2) not null,
  currency            text default 'USD',
  payment_method      text,                      -- 'stripe' | 'crypto' | 'bank'
  stripe_payment_id   text,
  status              donation_status default 'pending',
  receipt_hash        text,                      -- sha256(receipt_data)
  ledger_anchor       text,                      -- optional blockchain anchor tx
  allocation_plan_id  uuid,                      -- references allocation_plans
  created_at          timestamptz default now(),
  confirmed_at        timestamptz,
  disbursed_at        timestamptz
);

create index idx_donations_donor on donations(donor_id);
create index idx_donations_project on donations(project_id);
create index idx_donations_status on donations(status);

-- ============================================================
-- ALLOCATION PLANS
-- The AI-generated split across multiple projects
-- ============================================================

create table allocation_plans (
  id              uuid primary key default uuid_generate_v4(),
  intention_id    uuid references intentions(id),
  donor_id        uuid references donor_profiles(id),
  total_usd       numeric(10,2),
  generated_by    text default 'deterministic_v1',
  llm_model       text,
  llm_output_id   text,                          -- for audit trail
  chunks_used     text[],                        -- chunk IDs used in generation
  allocations     jsonb not null,                -- [{project_id, amount, reason, score}]
  evocative_line  text,                          -- "A village well that hums for 12 years"
  barakah_score   float,
  voice_text      text,
  dua_template    text,
  spiritual_note  text,
  created_at      timestamptz default now()
);

-- Backfill FK
alter table donations add constraint fk_allocation_plan
  foreign key (allocation_plan_id) references allocation_plans(id);

-- ============================================================
-- DUE DILIGENCE REPORTS
-- LLM-generated per project, cached and re-run on new evidence
-- ============================================================

create table due_diligence_reports (
  id                  uuid primary key default uuid_generate_v4(),
  project_id          uuid not null references projects(id) on delete cascade,
  deterministic_score float,
  llm_adjustment      float,
  final_score         float,
  short_summary       text,
  risks               jsonb,                     -- [{type, severity, explanation, citation_chunk_id}]
  maintenance_plan    text,
  top_citations       jsonb,                     -- [{title, url, chunk_id}]
  llm_model           text,
  llm_output_raw      text,
  chunks_used         text[],
  created_at          timestamptz default now()
);

create index idx_dd_project on due_diligence_reports(project_id);

-- ============================================================
-- WAQF ASSETS (Living Waqf)
-- Physical assets linked to a donation/project
-- ============================================================

create table waqf_assets (
  id                    uuid primary key default uuid_generate_v4(),
  project_id            uuid not null references projects(id),
  donor_id              uuid references donor_profiles(id),
  asset_type            text,                    -- 'water_pump' | 'solar_panel' | 'school_block'
  name                  text,
  location_lat          float,
  location_lng          float,
  location_description  text,
  installation_date     date,
  last_maintenance_date date,
  next_maintenance_date date,
  estimated_lifespan_years int,
  beneficiary_count_current int,
  serenity_score        float,                   -- 0–100, computed from telemetry + reports
  status                waqf_status default 'active',
  iot_device_id         text,                    -- for IoT telemetry integration
  digital_twin_data     jsonb,                   -- time-series snapshots
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

-- ============================================================
-- WAQF IMPACT EVENTS
-- Field reports, maintenance events, beneficiary stories
-- ============================================================

create table waqf_events (
  id              uuid primary key default uuid_generate_v4(),
  waqf_asset_id   uuid references waqf_assets(id) on delete cascade,
  project_id      uuid references projects(id),
  event_type      text,                          -- 'field_report' | 'maintenance' | 'beneficiary_story' | 'issue'
  title           text,
  raw_content     text,
  composed_update text,                          -- LLM-composed 1-sentence update
  image_url       text,
  source_url      text,
  pdf_hash        text,
  chunk_ids       text[],                        -- RAG chunks used
  metadata        jsonb,
  created_at      timestamptz default now()
);

create index idx_waqf_events_asset on waqf_events(waqf_asset_id);
create index idx_waqf_events_project on waqf_events(project_id);

-- ============================================================
-- AGENT SIGNALS & ACTIONS
-- For autonomous reallocation micro-agents
-- ============================================================

create table agent_signals (
  id              uuid primary key default uuid_generate_v4(),
  signal_type     signal_type not null,
  region          text,
  description     text,
  severity        float,                         -- 0–1
  source          text,
  source_url      text,
  metadata        jsonb,
  expires_at      timestamptz,
  created_at      timestamptz default now()
);

create table agent_actions (
  id                  uuid primary key default uuid_generate_v4(),
  donor_id            uuid references donor_profiles(id),
  signal_id           uuid references agent_signals(id),
  action              agent_action not null,
  reason              text,
  reallocation_plan   jsonb,                     -- [{project_id, from_amount, to_amount}]
  citations           jsonb,
  auto_executed       boolean default false,
  donor_approved      boolean,
  approved_at         timestamptz,
  created_at          timestamptz default now()
);

-- ============================================================
-- DONOR SPIRITUAL JOURNAL
-- ============================================================

create table journal_entries (
  id              uuid primary key default uuid_generate_v4(),
  donor_id        uuid not null references donor_profiles(id) on delete cascade,
  year            int,
  reflection_text text,
  llm_narrative   text,                          -- annual summary from LLM
  dua_snippet     text,
  is_private      boolean default true,
  created_at      timestamptz default now()
);

-- ============================================================
-- IMMUTABLE AUDIT LOG
-- Never deleted. Append-only. Every consequential action.
-- ============================================================

create table audit_log (
  id                  bigserial primary key,
  donor_id            uuid,
  action              text not null,             -- 'donation_created' | 'plan_generated' | 'agent_executed' | etc.
  deterministic_score float,
  llm_output_id       text,
  chunks_used         text[],
  payment_hash        text,
  entity_type         text,                      -- 'donation' | 'plan' | 'agent_action'
  entity_id           uuid,
  metadata            jsonb,
  created_at          timestamptz default now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table donor_profiles         enable row level security;
alter table intentions             enable row level security;
alter table donations              enable row level security;
alter table allocation_plans       enable row level security;
alter table journal_entries        enable row level security;
alter table waqf_assets            enable row level security;
alter table waqf_events            enable row level security;
alter table agent_actions          enable row level security;

-- Donor can only read/write their own data
create policy "donor_own_profile" on donor_profiles
  using (user_id = auth.uid());

create policy "donor_own_intentions" on intentions
  using (donor_id in (select id from donor_profiles where user_id = auth.uid()));

create policy "donor_own_donations" on donations
  using (donor_id in (select id from donor_profiles where user_id = auth.uid()));

create policy "donor_own_plans" on allocation_plans
  using (donor_id in (select id from donor_profiles where user_id = auth.uid()));

create policy "donor_own_journal" on journal_entries
  using (donor_id in (select id from donor_profiles where user_id = auth.uid()));

create policy "donor_own_waqf" on waqf_assets
  using (donor_id in (select id from donor_profiles where user_id = auth.uid()));

-- Projects, organizations, chunks, events, signals: public read
alter table organizations          enable row level security;
alter table projects               enable row level security;
alter table document_chunks        enable row level security;
alter table due_diligence_reports  enable row level security;
alter table agent_signals          enable row level security;

create policy "public_read_orgs"     on organizations         for select using (true);
create policy "public_read_projects" on projects             for select using (true);
create policy "public_read_chunks"   on document_chunks       for select using (true);
create policy "public_read_dd"       on due_diligence_reports for select using (true);
create policy "public_read_signals"  on agent_signals         for select using (true);
create policy "public_read_events"   on waqf_events           for select using (true);

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Similarity search for RAG retrieval
create or replace function match_chunks(
  query_embedding vector(1536),
  match_threshold float default 0.72,            -- Aligned with technical.md
  match_count int default 5,
  filter_project_id uuid default null
)
returns table (
  id uuid,
  chunk_text text,
  source_url text,
  source_title text,
  pdf_hash text,
  similarity float
)
language sql stable as $$
  select
    dc.id,
    dc.chunk_text,
    dc.source_url,
    dc.source_title,
    dc.pdf_hash,
    1 - (dc.embedding <=> query_embedding) as similarity
  from document_chunks dc
  where
    (filter_project_id is null or dc.project_id = filter_project_id)
    and 1 - (dc.embedding <=> query_embedding) > match_threshold
  order by dc.embedding <=> query_embedding
  limit match_count;
$$;

-- Recompute final_score on projects
create or replace function recompute_project_score()
returns trigger language plpgsql as $$
begin
  -- Clamp final score between 0 and 100
  new.final_score := least(100.0, greatest(0.0, coalesce(new.impact_score, 50.0) + coalesce(new.llm_score, 0.0)));
  return new;
end;
$$;

create trigger trg_project_score
  before insert or update of impact_score, llm_score on projects
  for each row execute function recompute_project_score();

-- Auto-update updated_at Trigger
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger trg_donor_updated   before update on donor_profiles for each row execute function set_updated_at();
create trigger trg_org_updated     before update on organizations  for each row execute function set_updated_at();
create trigger trg_project_updated before update on projects       for each row execute function set_updated_at();
create trigger trg_waqf_updated    before update on waqf_assets    for each row execute function set_updated_at();

-- Immutable Audit Log Trigger
create or replace function block_audit_log_edits()
returns trigger language plpgsql as $$
begin
  raise exception 'The audit_log table is immutable and cannot be modified or deleted.';
end;
$$;

create trigger trg_audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION block_audit_log_edits();

-- Update last_due_diligence_at when a report is created
create or replace function update_project_dd_timestamp()
returns trigger language plpgsql as $$
begin
  update projects set last_due_diligence_at = now() where id = new.project_id;
  return new;
end;
$$;

create trigger trg_dd_report_created
  after insert on due_diligence_reports
  for each row execute function update_project_dd_timestamp();
