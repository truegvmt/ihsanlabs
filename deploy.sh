#!/bin/bash
# scripts/deploy.sh
# Full deployment script for Ihsan Labs
# Usage: bash scripts/deploy.sh [staging|production]
# <!-- VIBE-CODER: Update [DEPLOY_VERSION] and checklist when new services are added -->
# [DEPLOY_VERSION]: 1.0.0

set -e

ENV=${1:-staging}
echo "⟶ Deploying Ihsan Labs to: $ENV"

# ── 1. Validate environment variables ──────────────────────────
REQUIRED_VARS=(
  SUPABASE_PROJECT_REF
  SUPABASE_ACCESS_TOKEN
  ANTHROPIC_API_KEY
  CHARITY_NAVIGATOR_APP_ID
  CHARITY_NAVIGATOR_APP_KEY
  GLOBALGIVING_API_KEY
)

for VAR in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!VAR}" ]; then
    echo "✗ Missing required env var: $VAR"
    exit 1
  fi
done

echo "✓ All required environment variables present"

# ── 2. Install dependencies ────────────────────────────────────
echo "⟶ Installing dependencies..."
pnpm install --frozen-lockfile

# ── 3. Run database migrations ────────────────────────────────
echo "⟶ Applying database migrations..."
supabase db push --project-ref "$SUPABASE_PROJECT_REF"

# ── 4. Set Supabase secrets ────────────────────────────────────
echo "⟶ Setting edge function secrets..."
supabase secrets set \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  CHARITY_NAVIGATOR_APP_ID="$CHARITY_NAVIGATOR_APP_ID" \
  CHARITY_NAVIGATOR_APP_KEY="$CHARITY_NAVIGATOR_APP_KEY" \
  GLOBALGIVING_API_KEY="$GLOBALGIVING_API_KEY" \
  --project-ref "$SUPABASE_PROJECT_REF"

# ── 5. Deploy edge functions ───────────────────────────────────
echo "⟶ Deploying edge functions..."
FUNCTIONS=(
  "allocation-optimizer"
  "due-diligence"
  "micro-update-composer"
  "waqf-agent"
)

for FN in "${FUNCTIONS[@]}"; do
  echo "  → deploying $FN..."
  supabase functions deploy "$FN" --project-ref "$SUPABASE_PROJECT_REF"
done

# ── 6. Build and deploy frontend ───────────────────────────────
echo "⟶ Building frontend..."
cd apps/web
pnpm build
cd ../..

echo "✓ Build complete"

# ── 7. Seed initial data (staging only) ───────────────────────
if [ "$ENV" = "staging" ]; then
  echo "⟶ Seeding staging data..."
  bash scripts/seed-projects.sh
fi

echo ""
echo "✓ Deployment complete — $ENV"
echo "  Supabase project: $SUPABASE_PROJECT_REF"
echo "  Edge functions: ${FUNCTIONS[*]}"
