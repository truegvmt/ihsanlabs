-- ============================================================
-- IHSAN LABS — MIGRATION 002: IATI ETL TABLES & SQL VIEWS
-- Version: 2026-03-09
-- Adds IATI data pipeline tables alongside existing v1.1.0 schema.
-- EXTEND strategy: new tables bridge into existing organizations + projects.
-- Run: supabase db push
-- ============================================================

-- ============================================================
-- IATI ORGANIZATIONS
-- IATI publishing org registry, bridged to organizations table
-- ============================================================

create table if not exists iati_orgs (
  id              uuid primary key default uuid_generate_v4(),
  iati_org_id     text unique not null,          -- e.g. "GB-CHC-202918"
  name            text not null,
  org_type        smallint,                      -- IATI org-type: 10=Gov,21=INGO,22=NGO,40=Multilateral
  country_code    char(2),                       -- ISO 3166-1 alpha-2 e.g. "GB"
  canonical_name  text,                          -- after entity resolution (fuzzy dedup)
  website         text,
  org_id          uuid references organizations(id) on delete set null, -- bridge to existing table
  raw_xml         jsonb,                         -- full parsed IATI XML for audit
  last_fetched_at timestamptz default now(),
  created_at      timestamptz default now()
);

create index if not exists idx_iati_orgs_code on iati_orgs(iati_org_id);
create index if not exists idx_iati_orgs_country on iati_orgs(country_code);
-- Trigram index for fuzzy org name matching (uses pg_trgm from v1.1.0)
create index if not exists idx_iati_orgs_name_trgm on iati_orgs using gin(name gin_trgm_ops);

-- ============================================================
-- IATI SECTORS (Canonical taxonomy)
-- DAC 5-digit sector codes → Ihsan project_focus taxonomy
-- ============================================================

create table if not exists iati_sectors (
  dac_code        text primary key,             -- e.g. "14030" (drinking water supplies)
  dac_name        text not null,
  ihsan_focus     project_focus,                -- mapped to Ihsan taxonomy enum
  category        text,                         -- e.g. "Water Supply & Sanitation"
  description     text
);

-- Seed canonical sector mappings
insert into iati_sectors (dac_code, dac_name, ihsan_focus, category) values
  ('14030', 'Basic drinking water supply and basic sanitation', 'water', 'Water & Sanitation'),
  ('14031', 'Basic drinking water supply', 'water', 'Water & Sanitation'),
  ('14032', 'Basic sanitation', 'water', 'Water & Sanitation'),
  ('14040', 'River basins development', 'water', 'Water & Sanitation'),
  ('11110', 'Education policy and administrative management', 'education', 'Education'),
  ('11120', 'Education facilities and training', 'education', 'Education'),
  ('11220', 'Primary education', 'education', 'Education'),
  ('11230', 'Basic life skills for youth and adults', 'education', 'Education'),
  ('12110', 'Health policy and administrative management', 'healthcare', 'Health'),
  ('12191', 'Medical services', 'healthcare', 'Health'),
  ('12220', 'Basic health care', 'healthcare', 'Health'),
  ('12230', 'Basic health infrastructure', 'healthcare', 'Health'),
  ('52010', 'Food aid/food security programmes', 'food', 'Food Security'),
  ('72040', 'Emergency food aid', 'food', 'Humanitarian'),
  ('16010', 'Social protection', 'shelter', 'Social Services'),
  ('16020', 'Social/welfare services', 'general', 'Social Services'),
  ('74020', 'Multi-hazard response preparedness', 'general', 'Humanitarian'),
  ('72010', 'Material relief assistance and services', 'general', 'Humanitarian'),
  ('99810', 'Sectors not specified', 'general', 'Unspecified')
on conflict (dac_code) do nothing;

-- ============================================================
-- IATI ACTIVITIES
-- Individual aid activities — maps to projects table
-- ============================================================

create table if not exists iati_activities (
  id                  uuid primary key default uuid_generate_v4(),
  iati_activity_id    text unique not null,      -- e.g. "GB-CHC-202918-PROJ-001"
  iati_org_id         text references iati_orgs(iati_org_id) on delete cascade,
  project_id          uuid references projects(id) on delete set null, -- bridge to existing table
  title               text,
  description         text,                     -- RAG-ELIGIBLE: textual project narrative only
  sector_code         text references iati_sectors(dac_code) on delete set null,
  sector_percentage   float default 100.0,      -- % of activity in this sector (multi-sector)
  country_code        char(2),                  -- primary recipient country ISO 3166-1 alpha-2
  activity_status     smallint default 2,       -- 1=pipeline, 2=active, 3=complete, 4=cancelled
  start_date_planned  date,
  start_date_actual   date,
  end_date_planned    date,
  end_date_actual     date,
  budget_usd          numeric(14,2),            -- total budget in USD
  disbursement_usd    numeric(14,2) default 0,  -- total disbursed to date
  commitment_usd      numeric(14,2) default 0,  -- total committed
  humanitarian        boolean default false,
  raw_xml             jsonb,                    -- full parsed IATI XML
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

create index if not exists idx_iati_act_org on iati_activities(iati_org_id);
create index if not exists idx_iati_act_sector on iati_activities(sector_code);
create index if not exists idx_iati_act_country on iati_activities(country_code);
create index if not exists idx_iati_act_status on iati_activities(activity_status);
create index if not exists idx_iati_act_project on iati_activities(project_id);

-- ============================================================
-- IATI TRANSACTIONS
-- Ledger of financial flows (commitments, disbursements, expenditures)
-- ============================================================

create table if not exists iati_transactions (
  id               uuid primary key default uuid_generate_v4(),
  activity_id      uuid not null references iati_activities(id) on delete cascade,
  transaction_type smallint not null,           -- 1=incoming, 2=commitment, 3=disbursement, 4=expenditure
  value            numeric(14,2) not null,
  currency         char(3) not null default 'USD',
  value_usd        numeric(14,2),               -- USD-normalised value at transaction_date exchange rate
  exchange_rate    float,                       -- rate applied (source: exchange rate API or ECB)
  transaction_date date,
  provider_org     text,                        -- IATI org-id of sending entity
  receiver_org     text,                        -- IATI org-id of receiving entity
  description      text,
  disbursement_channel smallint,               -- 1=central bank, 2=NGO, 3=multi-bilateral, 4=unspecified
  created_at       timestamptz default now()
);

create index if not exists idx_iati_tx_activity on iati_transactions(activity_id);
create index if not exists idx_iati_tx_type on iati_transactions(transaction_type);
create index if not exists idx_iati_tx_date on iati_transactions(transaction_date);
create index if not exists idx_iati_tx_date_type on iati_transactions(transaction_date, transaction_type);

-- ============================================================
-- DETERMINISTIC METRIC VIEWS
-- All factual metric retrieval goes through these views.
-- RAG is NOT used for financial/numeric answers.
-- ============================================================

-- Expense/disbursement ratios by org (commitment vs disbursement efficiency)
create or replace view v_expense_ratios as
  select
    a.iati_org_id,
    o.canonical_name                                                   as org_name,
    count(distinct a.id)                                               as activity_count,
    sum(a.budget_usd)                                                  as total_budget_usd,
    sum(a.disbursement_usd)                                            as total_disbursed_usd,
    sum(a.commitment_usd)                                              as total_committed_usd,
    case
      when sum(a.commitment_usd) > 0
      then round((sum(a.disbursement_usd) / sum(a.commitment_usd) * 100)::numeric, 2)
      else null
    end                                                                as disbursement_ratio_pct,
    sum(case when t.transaction_type = 4 then t.value_usd else 0 end) as total_expenditure_usd,
    sum(case when t.transaction_type = 3 then t.value_usd else 0 end) as total_disbursement_tx_usd
  from iati_activities a
  join iati_orgs o on a.iati_org_id = o.iati_org_id
  left join iati_transactions t on t.activity_id = a.id
  group by a.iati_org_id, o.canonical_name;

-- Funding trends by sector and country (12-month rolling window)
create or replace view v_funding_trends as
  select
    a.sector_code,
    s.dac_name                                          as sector_name,
    s.ihsan_focus,
    a.country_code,
    date_trunc('month', t.transaction_date)::date       as month,
    sum(t.value_usd)                                    as total_usd,
    count(distinct a.id)                                as activity_count,
    count(distinct a.iati_org_id)                       as org_count
  from iati_transactions t
  join iati_activities a on t.activity_id = a.id
  left join iati_sectors s on a.sector_code = s.dac_code
  where t.transaction_date >= current_date - interval '12 months'
    and t.transaction_type in (3, 4)         -- disbursements + expenditures only
    and t.value_usd is not null
  group by a.sector_code, s.dac_name, s.ihsan_focus, a.country_code, month
  order by month desc, total_usd desc;

-- Geographic and sector diversity index per org
create or replace view v_org_diversity as
  select
    a.iati_org_id,
    o.canonical_name                           as org_name,
    count(distinct a.country_code)             as country_count,
    count(distinct a.sector_code)              as sector_count,
    count(distinct a.id)                       as activity_count,
    sum(a.budget_usd)                          as total_budget_usd,
    -- Herfindahl-Hirschman index approximation for concentration risk (lower = more diverse)
    round(
      sum(power(a.budget_usd / nullif(sum(a.budget_usd) over (partition by a.iati_org_id), 0), 2))::numeric
    , 4)                                       as budget_hhi
  from iati_activities a
  join iati_orgs o on a.iati_org_id = o.iati_org_id
  where a.activity_status = 2                  -- active only
  group by a.iati_org_id, o.canonical_name;

-- ============================================================
-- RLS POLICIES FOR IATI TABLES
-- Public read; service_role write (ETL pipeline only)
-- ============================================================

alter table iati_orgs enable row level security;
alter table iati_activities enable row level security;
alter table iati_transactions enable row level security;
alter table iati_sectors enable row level security;

-- Public read for all IATI data (open aid data principle)
create policy "iati_orgs_public_read"       on iati_orgs        for select using (true);
create policy "iati_activities_public_read" on iati_activities   for select using (true);
create policy "iati_transactions_public_read" on iati_transactions for select using (true);
create policy "iati_sectors_public_read"    on iati_sectors      for select using (true);

-- Service role only for writes (ETL pipeline uses service_role key)
create policy "iati_orgs_service_write"       on iati_orgs        for all using (auth.role() = 'service_role');
create policy "iati_activities_service_write" on iati_activities   for all using (auth.role() = 'service_role');
create policy "iati_transactions_service_write" on iati_transactions for all using (auth.role() = 'service_role');

-- ============================================================
-- DOCUMENT_CHUNKS: restrict to description content_type
-- Add content_type column to enforce RAG policy at DB level
-- ============================================================

alter table document_chunks
  add column if not exists content_type text
    not null default 'narrative'
    check (content_type in ('narrative', 'description', 'field_report', 'audit_summary'));

comment on column document_chunks.content_type is
  'RAG policy: only narrative/description/field_report/audit_summary content is embedded. Numeric/financial data must be queried from iati_transactions and SQL views.';

-- Index for fast filtering by content_type (enforcement check)
create index if not exists idx_chunks_content_type on document_chunks(content_type);
