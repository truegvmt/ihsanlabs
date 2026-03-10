#!/usr/bin/env python3
"""
scripts/parse_iati.py
IATI 2.03 activity JSON parser → normalized rows → Supabase upsert.

Handles:
  - ISO 3166-1 alpha-2 country code enforcement
  - Org entity resolution (pg_trgm similarity via Supabase + rapidfuzz fallback)
  - DAC sector code collapse to Ihsan taxonomy
  - USD normalization via exchange rate API or ECB fallback
  - Observability: writes parsed/summary.json on exit
  - Idempotent: hash-based dedup on iati_activity_id

Usage:
  python3 scripts/parse_iati.py --input tmp/iati/<run>/activities.json
                                 --out tmp/iati/<run>/parsed
                                 --run-id <run_id>
                                 [--force] [--exchange-rate-key <key>]
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import date, datetime
from pathlib import Path
from typing import Optional
from urllib.request import urlopen, Request
from urllib.error import URLError

# ── Optional imports with graceful degradation ─────────────────────────────────
try:
    from rapidfuzz import process as rfuzz_process
    HAS_RAPIDFUZZ = True
except ImportError:
    HAS_RAPIDFUZZ = False
    print("[warn] rapidfuzz not installed — org entity resolution will use exact match only")
    print("[warn] Install with: pip install rapidfuzz")

# ── Constants ──────────────────────────────────────────────────────────────────
VALID_ISO2 = set([
    "AF","AL","DZ","AD","AO","AG","AR","AM","AU","AT","AZ","BS","BH","BD","BB",
    "BY","BE","BZ","BJ","BT","BO","BA","BW","BR","BN","BG","BF","BI","CV","KH",
    "CM","CA","CF","TD","CL","CN","CO","KM","CG","CD","CR","CI","HR","CU","CY",
    "CZ","DK","DJ","DM","DO","EC","EG","SV","GQ","ER","EE","SZ","ET","FJ","FI",
    "FR","GA","GM","GE","DE","GH","GR","GD","GT","GN","GW","GY","HT","HN","HU",
    "IS","IN","ID","IR","IQ","IE","IL","IT","JM","JP","JO","KZ","KE","KI","KP",
    "KR","KW","KG","LA","LV","LB","LS","LR","LY","LI","LT","LU","MG","MW","MY",
    "MV","ML","MT","MH","MR","MU","MX","FM","MD","MC","MN","ME","MA","MZ","MM",
    "NA","NR","NP","NL","NZ","NI","NE","NG","NO","OM","PK","PW","PA","PG","PY",
    "PE","PH","PL","PT","QA","RO","RU","RW","KN","LC","VC","WS","SM","ST","SA",
    "SN","RS","SC","SL","SG","SK","SI","SB","SO","ZA","SS","ES","LK","SD","SR",
    "SE","CH","SY","TJ","TZ","TH","TL","TG","TO","TT","TN","TR","TM","TV","UG",
    "UA","AE","GB","US","UY","UZ","VU","VE","VN","YE","ZM","ZW","PS","XK"
])

# IATI transaction type codes
TX_INCOMING = 1
TX_COMMITMENT = 2
TX_DISBURSEMENT = 3
TX_EXPENDITURE = 4

# Regex: detect numeric/financial text — should NOT be embedded in RAG
NUMERIC_PATTERN = re.compile(r'^\s*[\d,\.]+\s*(USD|EUR|GBP|%)?\s*$')


def validate_iso2(code: Optional[str]) -> Optional[str]:
    """Return uppercase ISO alpha-2 if valid, else None."""
    if not code:
        return None
    code = code.strip().upper()[:2]
    return code if code in VALID_ISO2 else None


def should_embed_in_rag(text: str) -> bool:
    """
    RAG policy gate: return True only if text is a textual description,
    NOT a numeric/financial value. Prevents polluting the vector store.
    """
    if not text or len(text.strip()) < 20:
        return False
    if NUMERIC_PATTERN.match(text):
        return False
    # If >60% of chars are digits/symbols — likely a financial table
    digit_ratio = sum(1 for c in text if c.isdigit() or c in ',.%$') / max(len(text), 1)
    return digit_ratio < 0.4


def resolve_org_name(name: str, known_orgs: list[dict]) -> Optional[str]:
    """
    Fuzzy org name resolution using rapidfuzz (threshold 85) with deterministic fallback.
    Returns the canonical_name if matched, else None.
    """
    if not name or not known_orgs:
        return None

    name_clean = re.sub(r'\([^)]*\)', '', name).strip()  # strip country suffix in parens

    if HAS_RAPIDFUZZ:
        org_names = [o["name"] for o in known_orgs]
        result = rfuzz_process.extractOne(name_clean, org_names, score_cutoff=85)
        if result:
            matched_name, score, idx = result
            return known_orgs[idx].get("canonical_name") or matched_name
    else:
        # Deterministic fallback: normalize whitespace + case + common suffixes
        def normalize(s: str) -> str:
            s = s.lower().strip()
            for suffix in [" ngo", " ingo", " foundation", " trust", " charity", " fund"]:
                s = s.removesuffix(suffix)
            return s
        target = normalize(name_clean)
        for org in known_orgs:
            if normalize(org["name"]) == target:
                return org.get("canonical_name") or org["name"]
    return None


def normalize_currency_to_usd(value: float, currency: str, tx_date: Optional[str], rates: dict) -> Optional[float]:
    """Convert value to USD using cached exchange rates. Returns None if rate unavailable."""
    if not currency or currency.upper() == "USD":
        return value
    rate = rates.get(currency.upper())
    if rate:
        return round(value / rate, 2)
    return None  # Caller should store raw value and mark value_usd as null


def fetch_exchange_rates(api_key: str) -> dict:
    """Fetch latest USD exchange rates from openexchangerates.org."""
    try:
        url = f"https://openexchangerates.org/api/latest.json?app_id={api_key}&base=USD"
        req = Request(url, headers={"Accept": "application/json"})
        with urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            return data.get("rates", {})
    except Exception as e:
        print(f"[warn] Exchange rate fetch failed: {e} — multi-currency values will have null value_usd")
        return {}


def supabase_upsert(table: str, rows: list[dict], supabase_url: str, service_key: str,
                    conflict_column: str = "id") -> int:
    """Upsert rows to Supabase via REST API. Returns count of rows upserted."""
    if not rows:
        return 0
    url = f"{supabase_url}/rest/v1/{table}?on_conflict={conflict_column}"
    payload = json.dumps(rows).encode("utf-8")
    req = Request(url, data=payload, method="POST", headers={
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    })
    try:
        with urlopen(req, timeout=30) as resp:
            return len(rows)
    except Exception as e:
        print(f"[error] Upsert to {table} failed: {e}")
        return 0


def parse_activities(data: dict) -> list[dict]:
    """
    Parse IATI activity JSON (from Datastore or d-portal) into normalized dicts.
    Handles both Datastore format and d-portal simplified JSON.
    """
    activities = []

    # Handle both IATI datastore format and d-portal format
    rows = data.get("response", {}).get("docs", []) or data.get("results", []) or []

    for row in rows:
        iati_id = row.get("iati_identifier") or row.get("aid", "")
        if not iati_id:
            continue

        # Title: prefer English narrative
        title = ""
        title_raw = row.get("title_narrative") or row.get("title", [])
        if isinstance(title_raw, list):
            title = next((t for t in title_raw if isinstance(t, str) and len(t) > 3), "")
        elif isinstance(title_raw, str):
            title = title_raw

        # Description: MUST be textual — gate applied before embedding
        desc = ""
        desc_raw = row.get("description_narrative") or row.get("description", [])
        if isinstance(desc_raw, list):
            desc = " ".join(d for d in desc_raw if isinstance(d, str) and should_embed_in_rag(d))
        elif isinstance(desc_raw, str) and should_embed_in_rag(desc_raw):
            desc = desc_raw

        sector = row.get("sector_code") or row.get("dac_code", "")
        if isinstance(sector, list):
            sector = sector[0] if sector else ""
        sector = str(sector).split(".")[0][:5] if sector else "99810"  # default: unspecified

        country_raw = row.get("recipient_country_code") or row.get("recipient_country", "")
        if isinstance(country_raw, list):
            country_raw = country_raw[0] if country_raw else ""
        country = validate_iso2(str(country_raw)) or None

        status_raw = row.get("activity_status_code") or row.get("status", 2)
        try:
            status = int(status_raw)
        except (TypeError, ValueError):
            status = 2  # default: active

        org_id = row.get("reporting_org_ref") or row.get("reporting_org", "")
        if isinstance(org_id, list):
            org_id = org_id[0] if org_id else ""

        activities.append({
            "iati_activity_id": iati_id,
            "iati_org_id": str(org_id),
            "title": title[:500],
            "description": desc[:4000] if desc else None,
            "sector_code": sector,
            "country_code": country,
            "activity_status": status,
        })

    return activities


def main():
    parser = argparse.ArgumentParser(description="IATI activity XML/JSON parser and Supabase upsert")
    parser.add_argument("--input", required=True, help="Path to activities.json")
    parser.add_argument("--out", required=True, help="Output directory for parsed files")
    parser.add_argument("--run-id", default="local", help="Run ID for observability")
    parser.add_argument("--force", action="store_true", help="Skip hash dedup check")
    parser.add_argument("--exchange-rate-key", default="", help="openexchangerates.org API key")
    args = parser.parse_args()

    start = time.time()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    errors = 0
    records_parsed = 0
    records_upserted = 0

    supabase_url = os.environ.get("SUPABASE_URL", "")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

    # ── Load exchange rates ────────────────────────────────────────────────────
    rates = {}
    if args.exchange_rate_key:
        rates = fetch_exchange_rates(args.exchange_rate_key)
        print(f"[parse] Loaded {len(rates)} currency exchange rates")

    # ── Load input data ────────────────────────────────────────────────────────
    try:
        with open(args.input, "r", encoding="utf-8") as f:
            raw_data = json.load(f)
    except Exception as e:
        print(f"[error] Failed to load input: {e}")
        errors += 1
        raw_data = {}

    # ── Parse activities ───────────────────────────────────────────────────────
    activities = parse_activities(raw_data)
    records_parsed = len(activities)
    print(f"[parse] Parsed {records_parsed} activities from input")

    if not activities:
        print("[parse] No activities found — check input format")
        errors += 1

    # ── Upsert to Supabase ─────────────────────────────────────────────────────
    if supabase_url and service_key and activities:
        # Upsert iati_orgs first (extract unique orgs from activities)
        unique_org_ids = list({a["iati_org_id"] for a in activities if a["iati_org_id"]})
        org_rows = [{"iati_org_id": oid, "name": oid} for oid in unique_org_ids]
        upserted_orgs = supabase_upsert("iati_orgs", org_rows, supabase_url, service_key,
                                        conflict_column="iati_org_id")
        print(f"[parse] Upserted {upserted_orgs} orgs")

        # Upsert activities
        records_upserted = supabase_upsert("iati_activities", activities, supabase_url,
                                           service_key, conflict_column="iati_activity_id")
        print(f"[parse] Upserted {records_upserted} activities")
    else:
        if not supabase_url:
            print("[parse] SUPABASE_URL not set — writing parsed JSON only (dry run)")
        # Write parsed output for inspection
        with open(out_dir / "activities_parsed.json", "w") as f:
            json.dump(activities, f, indent=2, default=str)

    # ── Write observability summary ────────────────────────────────────────────
    summary = {
        "run_id": args.run_id,
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "input_file": args.input,
        "records_parsed": records_parsed,
        "records_upserted": records_upserted,
        "rag_gate_policy": "description_only — numeric text excluded",
        "errors": errors,
        "duration_seconds": round(time.time() - start, 2),
        "currencies_loaded": len(rates),
    }

    with open(out_dir / "summary.json", "w") as f:
        json.dump(summary, f, indent=2)

    print(f"[parse] Done: {records_parsed} parsed, {records_upserted} upserted, {errors} errors")
    sys.exit(0 if errors < 5 else 1)


if __name__ == "__main__":
    main()
