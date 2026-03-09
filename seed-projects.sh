#!/bin/bash
# scripts/seed-projects.sh
# Seeds Supabase with initial project and organization data for development/staging
# Requires: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in environment
# <!-- VIBE-CODER: Update [SEED_VERSION] when new seed categories are added -->
# [SEED_VERSION]: 1.0.0

set -e

echo "⟶ Seeding Ihsan Labs initial data..."

SUPABASE_URL=${SUPABASE_URL:-"http://localhost:54321"}
SERVICE_KEY=${SUPABASE_SERVICE_ROLE_KEY:-""}

if [ -z "$SERVICE_KEY" ]; then
  echo "✗ SUPABASE_SERVICE_ROLE_KEY not set"
  exit 1
fi

AUTH_HEADER="Authorization: Bearer $SERVICE_KEY"
CT_HEADER="Content-Type: application/json"
PREFER_HEADER="Prefer: return=minimal"

# ── Helper ─────────────────────────────────────────────────────
post() {
  local TABLE=$1
  local BODY=$2
  curl -s -X POST \
    "$SUPABASE_URL/rest/v1/$TABLE" \
    -H "$AUTH_HEADER" \
    -H "$CT_HEADER" \
    -H "$PREFER_HEADER" \
    -H "apikey: $SERVICE_KEY" \
    -d "$BODY" > /dev/null
  echo "  ✓ Inserted into $TABLE"
}

# ── Seed organizations ─────────────────────────────────────────
echo "⟶ Seeding organizations..."

post "organizations" '{
  "external_id": "CN_001",
  "source": "charity_navigator",
  "name": "Islamic Relief USA",
  "ein": "95-3893342",
  "description": "Providing emergency relief and development programs worldwide.",
  "website": "https://irusa.org",
  "country": "US",
  "overall_score": 91.0,
  "finance_score": 88.5,
  "accountability_score": 96.0,
  "last_synced_at": "2025-01-01T00:00:00Z"
}'

post "organizations" '{
  "external_id": "CN_002",
  "source": "charity_navigator",
  "name": "Water.org",
  "ein": "52-1780975",
  "description": "Providing access to safe water and sanitation through affordable financing.",
  "website": "https://water.org",
  "country": "US",
  "overall_score": 95.0,
  "finance_score": 94.0,
  "accountability_score": 97.0,
  "last_synced_at": "2025-01-01T00:00:00Z"
}'

post "organizations" '{
  "external_id": "CN_003",
  "source": "charity_navigator",
  "name": "CARE International",
  "ein": "13-1623946",
  "description": "Leading humanitarian organization fighting poverty and providing emergency relief.",
  "website": "https://care.org",
  "country": "US",
  "overall_score": 89.0,
  "finance_score": 87.0,
  "accountability_score": 93.0,
  "last_synced_at": "2025-01-01T00:00:00Z"
}'

# ── Seed projects ──────────────────────────────────────────────
echo "⟶ Seeding projects..."

post "projects" '{
  "source": "manual",
  "title": "Solar-Powered Borehole · Sindh, Pakistan",
  "description": "Solar-powered borehole providing year-round clean water to 340 rural families in Sindh province. Local maintenance committee trained and operational.",
  "focus": "water",
  "region": "pk",
  "city": "Hyderabad",
  "latitude": 25.396,
  "longitude": 68.374,
  "funding_goal": 28000,
  "funding_raised": 19600,
  "is_waqf_eligible": true,
  "estimated_duration_months": 60,
  "estimated_beneficiaries": 340,
  "status": "active",
  "barakah_weight": 1.5,
  "impact_score": 82,
  "llm_score": 5,
  "final_score": 87
}'

post "projects" '{
  "source": "manual",
  "title": "Girls Primary School Extension · Kabul",
  "description": "Three-classroom extension for a girls school serving 180 students. Construction 70% complete. Local NGO partner operational since 2018.",
  "focus": "education",
  "region": "af",
  "city": "Kabul",
  "latitude": 34.528,
  "longitude": 69.172,
  "funding_goal": 45000,
  "funding_raised": 28000,
  "is_waqf_eligible": true,
  "estimated_duration_months": 84,
  "estimated_beneficiaries": 180,
  "status": "active",
  "barakah_weight": 1.4,
  "impact_score": 78,
  "llm_score": 6,
  "final_score": 84
}'

post "projects" '{
  "source": "globalgiving",
  "title": "Community Food Garden · Mogadishu",
  "description": "Sustainable community food garden providing nutritious vegetables to 500 households. Second harvest season now underway.",
  "focus": "food",
  "region": "so",
  "city": "Mogadishu",
  "latitude": 2.046,
  "longitude": 45.343,
  "funding_goal": 18000,
  "funding_raised": 9000,
  "is_waqf_eligible": false,
  "estimated_duration_months": 36,
  "estimated_beneficiaries": 500,
  "status": "active",
  "barakah_weight": 1.1,
  "impact_score": 72,
  "llm_score": 7,
  "final_score": 79
}'

post "projects" '{
  "source": "manual",
  "title": "Mobile Clinic · Cox'"'"'s Bazar, Bangladesh",
  "description": "Mobile health clinic serving 800 patients per month in underserved coastal communities. Covers maternal health, child nutrition, and preventive care.",
  "focus": "healthcare",
  "region": "bd",
  "city": "Cox'"'"'s Bazar",
  "latitude": 21.428,
  "longitude": 92.006,
  "funding_goal": 36000,
  "funding_raised": 21600,
  "is_waqf_eligible": false,
  "estimated_duration_months": 24,
  "estimated_beneficiaries": 800,
  "status": "active",
  "barakah_weight": 1.2,
  "impact_score": 74,
  "llm_score": 7,
  "final_score": 81
}'

post "projects" '{
  "source": "manual",
  "title": "Orphan Care Centre · Nairobi",
  "description": "Residential care, education, and vocational training for 60 orphaned children. Centre has operated continuously since 2017 with full financial audit history.",
  "focus": "orphan",
  "region": "ke",
  "city": "Nairobi",
  "latitude": -1.286,
  "longitude": 36.817,
  "funding_goal": 52000,
  "funding_raised": 35000,
  "is_waqf_eligible": true,
  "estimated_duration_months": 72,
  "estimated_beneficiaries": 60,
  "status": "active",
  "barakah_weight": 1.3,
  "impact_score": 80,
  "llm_score": 8,
  "final_score": 88
}'

echo ""
echo "✓ Seed complete"
echo "  Organizations: 3"
echo "  Projects: 5"
echo ""
echo "Run 'bash scripts/ingest-pdfs.sh' to seed RAG document chunks."
