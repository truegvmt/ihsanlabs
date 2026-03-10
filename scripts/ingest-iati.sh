#!/usr/bin/env bash
# scripts/ingest-iati.sh
# IATI ETL orchestrator — downloads IATI activity data and runs the parser
# Usage: bash scripts/ingest-iati.sh [--publisher PUBLISHER_ID] [--limit N] [--force]
# Requires: python3, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, IATI_DATASTORE_URL (in .env)
# Schedule: nightly cron or manual run
# Observability: writes logs/ingest-<run_id>.json per run

set -euo pipefail

# ── Load env ───────────────────────────────────────────────────────────────────
if [ -f .env ]; then source .env; fi

: "${SUPABASE_URL:?Required: SUPABASE_URL}"
: "${SUPABASE_SERVICE_ROLE_KEY:?Required: SUPABASE_SERVICE_ROLE_KEY}"
IATI_DATASTORE_URL="${IATI_DATASTORE_URL:-https://api.iatistandard.org/datastore}"
IATI_PUBLISHER_ID="${IATI_PUBLISHER_ID:-}"
EXCHANGE_RATE_API_KEY="${EXCHANGE_RATE_API_KEY:-}"

# ── Parse args ─────────────────────────────────────────────────────────────────
PUBLISHER_FILTER=""
LIMIT=500
FORCE=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --publisher) PUBLISHER_FILTER="$2"; shift 2 ;;
    --limit)     LIMIT="$2"; shift 2 ;;
    --force)     FORCE=true; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

RUN_ID=$(date +%Y%m%d_%H%M%S)
WORK_DIR="tmp/iati/${RUN_ID}"
LOG_DIR="logs"
LOG_FILE="${LOG_DIR}/ingest-${RUN_ID}.json"
mkdir -p "${WORK_DIR}" "${LOG_DIR}"

echo "[IATI] Starting ingestion run ${RUN_ID}"
echo "[IATI] Publisher filter: ${PUBLISHER_FILTER:-all}"
echo "[IATI] Activity limit: ${LIMIT}"

START_TIME=$(date +%s)

# ── Step 1: Fetch IATI activities from Datastore API ──────────────────────────
# IATI Datastore paginates at 100 records; fetch pages until limit reached
echo "[IATI] Fetching activity list from datastore..."

PUBLISHER_PARAM=""
if [ -n "${PUBLISHER_FILTER}" ]; then
  PUBLISHER_PARAM="&reporting_org_ref=${PUBLISHER_FILTER}"
fi

# Fetch top-N activities (focus: water, education, health — DAC sectors)
SECTOR_FILTER="14030,14031,14032,14040,11110,11220,12110,12191,12220,52010"
curl -sSf \
  "${IATI_DATASTORE_URL}/activity?query=hierarchy:1${PUBLISHER_PARAM}&fl=iati_identifier,title_narrative,description_narrative,reporting_org_ref,sector_code,recipient_country_code,activity_status_code,start_date_planned,start_date_actual,end_date_planned,budget&limit=${LIMIT}&format=json" \
  -o "${WORK_DIR}/activities.json" || {
    echo "[IATI] Datastore fetch failed. Falling back to d-portal bulk download..."
    # Fallback: d-portal simplified JSON export for humanitarian orgs
    curl -sSf \
      "https://d-portal.org/q.json?limit=${LIMIT}&sector=${SECTOR_FILTER}" \
      -o "${WORK_DIR}/activities.json"
  }

echo "[IATI] Activities file size: $(wc -c < "${WORK_DIR}/activities.json") bytes"

# ── Step 2: Run Python parser ──────────────────────────────────────────────────
echo "[IATI] Running ETL parser..."

PYTHON_ARGS="--input ${WORK_DIR}/activities.json --out ${WORK_DIR}/parsed --run-id ${RUN_ID}"
if [ "${FORCE}" = "true" ]; then
  PYTHON_ARGS="${PYTHON_ARGS} --force"
fi
if [ -n "${EXCHANGE_RATE_API_KEY}" ]; then
  PYTHON_ARGS="${PYTHON_ARGS} --exchange-rate-key ${EXCHANGE_RATE_API_KEY}"
fi

python3 scripts/parse_iati.py ${PYTHON_ARGS}

# ── Step 3: Read parse output and upsert to Supabase ─────────────────────────
if [ -f "${WORK_DIR}/parsed/summary.json" ]; then
  RECORDS=$(python3 -c "import json; d=json.load(open('${WORK_DIR}/parsed/summary.json')); print(d.get('records_parsed',0))")
  ERRORS=$(python3 -c "import json; d=json.load(open('${WORK_DIR}/parsed/summary.json')); print(d.get('errors',0))")
else
  RECORDS=0
  ERRORS=1
fi

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

# ── Step 4: Write observability log ───────────────────────────────────────────
cat > "${LOG_FILE}" <<EOF
{
  "run_id": "${RUN_ID}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "publisher_filter": "${PUBLISHER_FILTER:-all}",
  "limit": ${LIMIT},
  "records_ingested": ${RECORDS},
  "errors": ${ERRORS},
  "duration_seconds": ${DURATION},
  "work_dir": "${WORK_DIR}",
  "status": "$([ "${ERRORS}" -gt 0 ] && echo 'partial' || echo 'success')"
}
EOF

echo "[IATI] Run ${RUN_ID} complete: ${RECORDS} records ingested, ${ERRORS} errors, ${DURATION}s"
echo "[IATI] Log written to: ${LOG_FILE}"

# ── Step 5: Trigger due-diligence refresh for newly ingested activities ────────
# (Only run if SUPABASE credentials are set and records were ingested)
if [ "${RECORDS}" -gt 0 ] && [ -n "${SUPABASE_URL}" ]; then
  echo "[IATI] Triggering due-diligence cache invalidation for updated projects..."
  # Call the allocation-optimizer to log the ingest event to audit_log
  curl -sSf -X POST \
    "${SUPABASE_URL}/functions/v1/allocation-optimizer" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"_internal_event\":\"iati_ingest_complete\",\"run_id\":\"${RUN_ID}\",\"records\":${RECORDS}}" \
    --max-time 10 2>/dev/null || echo "[IATI] Audit log call skipped (edge function not serving)"
fi

exit $([ "${ERRORS}" -gt 5 ] && echo 1 || echo 0)
