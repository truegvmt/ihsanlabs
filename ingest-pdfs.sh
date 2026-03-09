#!/bin/bash
# scripts/ingest-pdfs.sh
# Batch PDF ingestion script for the Ihsan Labs RAG pipeline
# Usage: bash scripts/ingest-pdfs.sh [--full] [--project-id <uuid>] [--force]
# Default (no flags): nightly batch — top 100 projects by final_score + GlobalGiving sync
# <!-- VIBE-CODER: Update [INGEST_VERSION] and the source list when new data sources are added -->
# [INGEST_VERSION]: 1.0.0

set -e

# ── Parse arguments ────────────────────────────────────────────
FULL=false
FORCE=false
PROJECT_ID=""

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --full)        FULL=true ;;
    --force)       FORCE=true ;;
    --project-id)  PROJECT_ID="$2"; shift ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
  shift
done

# ── Validate environment ───────────────────────────────────────
REQUIRED_VARS=(SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY OPENAI_API_KEY)
for VAR in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!VAR}" ]; then
    echo "✗ Missing required env var: $VAR"
    exit 1
  fi
done

echo "⟶ Ihsan Labs RAG ingestion pipeline"
echo "  Mode:       $([ "$FULL" = true ] && echo "full corpus" || echo "nightly batch (top 100)")"
echo "  Force:      $FORCE"
echo "  Project ID: $([ -n "$PROJECT_ID" ] && echo "$PROJECT_ID" || echo "all")"
echo ""

# ── Step 1: GlobalGiving project sync ─────────────────────────
echo "⟶ [1/4] Syncing GlobalGiving projects..."
if [ -n "$PROJECT_ID" ]; then
  pnpm --filter rag-pipeline start \
    --source globalgiving \
    --project-id "$PROJECT_ID" \
    $([ "$FORCE" = true ] && echo "--force")
else
  LIMIT=$([ "$FULL" = true ] && echo "1000" || echo "200")
  pnpm --filter rag-pipeline start \
    --source globalgiving \
    --limit "$LIMIT" \
    $([ "$FORCE" = true ] && echo "--force")
fi
echo "  ✓ GlobalGiving sync complete"

# ── Step 2: Partner PDF ingestion ─────────────────────────────
echo "⟶ [2/4] Ingesting partner field report PDFs..."
# Fetch the list of pending PDFs from the admin queue in Supabase
# (documents submitted via POST /api/admin/ingest-pdf that have not yet been processed)
PENDING_COUNT=$(curl -s \
  "$SUPABASE_URL/rest/v1/document_chunks?select=count&status=eq.pending" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d))" 2>/dev/null || echo "0")

echo "  Pending partner PDFs: $PENDING_COUNT"

if [ -n "$PROJECT_ID" ]; then
  pnpm --filter rag-pipeline start \
    --source partner-pdfs \
    --project-id "$PROJECT_ID" \
    $([ "$FORCE" = true ] && echo "--force")
else
  pnpm --filter rag-pipeline start \
    --source partner-pdfs \
    $([ "$FORCE" = true ] && echo "--force")
fi
echo "  ✓ Partner PDF ingestion complete"

# ── Step 3: Charity Navigator narrative content ────────────────
echo "⟶ [3/4] Syncing Charity Navigator narrative chunks..."
pnpm --filter rag-pipeline start \
  --source charity-navigator-narratives \
  $([ -n "$PROJECT_ID" ] && echo "--project-id $PROJECT_ID") \
  $([ "$FORCE" = true ] && echo "--force")
echo "  ✓ Charity Navigator sync complete"

# ── Step 4: Trigger due-diligence refresh for updated projects ─
echo "⟶ [4/4] Refreshing due-diligence reports for updated projects..."
# The pipeline emits a list of project IDs it updated to /tmp/ihsan_updated_projects.txt
if [ -f /tmp/ihsan_updated_projects.txt ]; then
  while IFS= read -r PID; do
    curl -s -X POST \
      "$SUPABASE_URL/functions/v1/due-diligence" \
      -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"project_id\": \"$PID\", \"force_refresh\": true}" > /dev/null
    echo "  → refreshed due-diligence for $PID"
  done < /tmp/ihsan_updated_projects.txt
  rm /tmp/ihsan_updated_projects.txt
else
  echo "  (no updated projects to refresh)"
fi

echo ""
echo "✓ RAG ingestion complete"
echo "  Run 'supabase studio' and check the document_chunks table to verify."
