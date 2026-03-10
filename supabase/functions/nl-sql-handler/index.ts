// supabase/functions/nl-sql-handler/index.ts
// Edge Function: POST /functions/v1/nl-sql-handler
// Natural-language → parameterized SQL → structured result + LLM summary
//
// SECURITY: Uses a fixed intent-to-template map. NO open-ended SQL generation.
// All SQL templates are pre-validated. User input is passed as $1/$2 query params only.
//
// SLOs: SQL query < 50ms; full round-trip (SQL + LLM summary) < 1500ms
//
// <!-- VIBE-CODER: To add a new intent, add a row to INTENT_TEMPLATES below.
//      Never allow raw SQL passthrough from user input. -->

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
};

// ── Intent template library (FIXED — no user-controlled SQL) ─────────────────
// Each template maps a recognized intent to:
//   - sql: parameterized query (Postgres $1/$2 style)
//   - params_from: field names from request body to bind as params
//   - description: human-readable intent description
//   - result_hint: what the LLM summarizer should focus on

const INTENT_TEMPLATES: Record<string, {
    sql: string;
    params_from: string[];
    description: string;
    result_hint: string;
}> = {
    funding_trends: {
        description: "Monthly funding trends for a sector/country over last 12 months",
        sql: `
      SELECT month, sector_name, ihsan_focus, country_code,
             total_usd, activity_count, org_count
      FROM v_funding_trends
      WHERE ($1::text IS NULL OR ihsan_focus::text = $1)
        AND ($2::text IS NULL OR country_code = $2)
      ORDER BY month DESC
      LIMIT 24
    `,
        params_from: ["focus", "country_code"],
        result_hint: "Summarize the funding trend over time. Note any growth, decline, or seasonal patterns.",
    },

    expense_ratios: {
        description: "Disbursement efficiency ratios for organizations",
        sql: `
      SELECT org_name, activity_count, total_budget_usd,
             total_disbursed_usd, disbursement_ratio_pct,
             total_expenditure_usd
      FROM v_expense_ratios
      WHERE ($1::text IS NULL OR iati_org_id = $1)
      ORDER BY disbursement_ratio_pct DESC NULLS LAST
      LIMIT 20
    `,
        params_from: ["org_id"],
        result_hint: "Summarize which organizations are most efficient at disbursing committed funds. Flag any with ratio < 50%.",
    },

    org_diversity: {
        description: "Geographic and sector diversity of active organizations",
        sql: `
      SELECT org_name, country_count, sector_count,
             activity_count, total_budget_usd, budget_hhi
      FROM v_org_diversity
      WHERE ($1::text IS NULL OR iati_org_id = $1)
      ORDER BY country_count DESC, sector_count DESC
      LIMIT 20
    `,
        params_from: ["org_id"],
        result_hint: "Summarize which organizations have the broadest impact footprint. Lower HHI = more diverse.",
    },

    top_projects: {
        description: "Top-ranked projects by final_score for a given focus and region",
        sql: `
      SELECT p.title, p.focus::text, p.region, p.final_score,
             p.estimated_beneficiaries, p.is_waqf_eligible,
             o.name AS org_name
      FROM projects p
      LEFT JOIN organizations o ON p.organization_id = o.id
      WHERE p.status = 'active'
        AND ($1::text IS NULL OR p.focus::text = $1)
        AND ($2::text IS NULL OR p.region = $2)
        AND p.final_score IS NOT NULL
      ORDER BY p.final_score DESC
      LIMIT 10
    `,
        params_from: ["focus", "country_code"],
        result_hint: "Summarize the highest-impact projects available. Mention waqf-eligible ones specifically.",
    },

    org_search: {
        description: "Search for organizations by name (trigram similarity)",
        sql: `
      SELECT o.name, o.country, o.overall_score, o.description,
             io.iati_org_id, io.canonical_name
      FROM organizations o
      LEFT JOIN iati_orgs io ON io.org_id = o.id
      WHERE ($1::text IS NULL OR o.name % $1)
      ORDER BY similarity(o.name, COALESCE($1, o.name)) DESC
      LIMIT 10
    `,
        params_from: ["query"],
        result_hint: "Summarize the matched organizations and their key attributes.",
    },

    sector_breakdown: {
        description: "Funding breakdown by Ihsan focus category for a country",
        sql: `
      SELECT s.ihsan_focus::text AS focus,
             COUNT(DISTINCT a.id)            AS activity_count,
             SUM(a.budget_usd)               AS total_budget_usd,
             SUM(a.disbursement_usd)         AS total_disbursed_usd
      FROM iati_activities a
      JOIN iati_sectors s ON a.sector_code = s.dac_code
      WHERE a.activity_status = 2
        AND ($1::text IS NULL OR a.country_code = $1)
      GROUP BY s.ihsan_focus
      ORDER BY total_budget_usd DESC NULLS LAST
    `,
        params_from: ["country_code"],
        result_hint: "Summarize which focus areas receive the most funding. Note any under-funded critical sectors.",
    },
};

// ── Intent classifier (keyword-based, deterministic) ─────────────────────────
function classifyIntent(intent: string): { template_key: string; params: Record<string, string | null> } {
    const lower = intent.toLowerCase();

    // Extract country code (ISO 2-char token)
    const countryMatch = lower.match(/\b([a-z]{2})\b/g)?.find(t =>
        ["pk", "bd", "ng", "et", "sd", "so", "ye", "sy", "af", "iq", "mr", "ml", "ne", "td", "bf",
            "gb", "us", "de", "fr", "sa", "ae", "eg", "tn", "ma", "dz", "ly"].includes(t)
    );
    const country_code = countryMatch?.toUpperCase() ?? null;

    // Extract focus category
    const focusMap: Record<string, string> = {
        water: "water", education: "education", school: "education", health: "healthcare",
        medical: "healthcare", food: "food", nutrition: "food", shelter: "shelter",
        mosque: "mosque", quran: "quran", orphan: "orphan",
    };
    const focus = Object.keys(focusMap).find(k => lower.includes(k))
        ? focusMap[Object.keys(focusMap).find(k => lower.includes(k))!]
        : null;

    // Route to template
    if (lower.includes("trend") || lower.includes("over time") || lower.includes("monthly")) {
        return { template_key: "funding_trends", params: { focus, country_code } };
    }
    if (lower.includes("expense") || lower.includes("ratio") || lower.includes("disburse") || lower.includes("efficient")) {
        return { template_key: "expense_ratios", params: { org_id: null } };
    }
    if (lower.includes("diversity") || lower.includes("breadth") || lower.includes("spread")) {
        return { template_key: "org_diversity", params: { org_id: null } };
    }
    if (lower.includes("sector") || lower.includes("breakdown") || lower.includes("category")) {
        return { template_key: "sector_breakdown", params: { country_code } };
    }
    if (lower.includes("project") || lower.includes("allocation") || lower.includes("top") || lower.includes("best")) {
        return { template_key: "top_projects", params: { focus, country_code } };
    }
    if (lower.includes("org") || lower.includes("organisation") || lower.includes("ngo") || lower.includes("charity")) {
        return { template_key: "org_search", params: { query: intent } };
    }

    // Default: top projects
    return { template_key: "top_projects", params: { focus, country_code } };
}

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: CORS_HEADERS });
    }

    const t0 = Date.now();
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    let body: { intent: string; context?: string };
    try {
        body = await req.json();
    } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: CORS_HEADERS });
    }

    if (!body.intent || typeof body.intent !== "string") {
        return new Response(JSON.stringify({ error: "intent field required" }), { status: 400, headers: CORS_HEADERS });
    }

    // ── Step 1: Classify intent → select template ──────────────────────────────
    const { template_key, params } = classifyIntent(body.intent);
    const template = INTENT_TEMPLATES[template_key];

    // ── Step 2: Bind params and execute SQL (<50ms SLO) ───────────────────────
    const t_sql_start = Date.now();
    const boundParams = template.params_from.map(key => params[key] ?? null);

    // Execute via Supabase RPC (raw SQL via stored function for parameterized safety)
    // We use a generic execute helper — in Supabase you'd expose this via a secure RPC
    const { data: rows, error: sqlError } = await supabase.rpc("execute_metric_query", {
        query_template: template_key,
        param1: boundParams[0] ?? null,
        param2: boundParams[1] ?? null,
    }).catch(() => ({ data: null, error: { message: "RPC not available — use direct SQL" } }));

    // Fallback for local dev: use supabase.from() on known views
    let result_rows: any[] = rows ?? [];
    let sql_error = sqlError?.message ?? null;

    if (!rows && !sqlError) {
        // Direct view query fallback (for views accessible via PostgREST)
        const viewMap: Record<string, string> = {
            funding_trends: "v_funding_trends",
            expense_ratios: "v_expense_ratios",
            org_diversity: "v_org_diversity",
            top_projects: "projects",
            org_search: "organizations",
            sector_breakdown: "iati_activities",
        };
        const view = viewMap[template_key];
        if (view) {
            const { data: fallbackData } = await supabase.from(view).select("*").limit(20);
            result_rows = fallbackData ?? [];
        }
    }

    const sql_ms = Date.now() - t_sql_start;

    // ── Step 3: LLM summary (result as context — NOT the DB schema) ────────────
    let summary = "";
    const t_llm_start = Date.now();

    try {
        if (result_rows.length === 0) {
            summary = "No data found for this query. The IATI pipeline may need to ingest data first.";
        } else {
            const res = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01",
                },
                body: JSON.stringify({
                    model: "claude-sonnet-4-20250514",
                    max_tokens: 300,
                    system: `You are a concise data analyst for a Muslim charitable giving platform. 
You receive structured data from a database query and write a 2-3 sentence plain-English summary for a donor.
${template.result_hint}
Rules: no jargon; round numbers sensibly; if data is sparse, say so clearly; never invent numbers.
Return ONLY the summary text — no preamble.`,
                    messages: [{
                        role: "user",
                        content: `User question: "${body.intent}"\n\nQuery results (${result_rows.length} rows):\n${JSON.stringify(result_rows.slice(0, 10), null, 2)}`,
                    }],
                }),
            });
            const resData = await res.json();
            summary = resData.content?.[0]?.text?.trim() ?? "Summary unavailable.";
        }
    } catch (e) {
        console.error("[nl-sql-handler] LLM summary failed:", e);
        summary = `Found ${result_rows.length} results. LLM summary unavailable.`;
    }

    const llm_ms = Date.now() - t_llm_start;
    const total_ms = Date.now() - t0;

    // ── Step 4: Audit log ──────────────────────────────────────────────────────
    await supabase.from("audit_log").insert({
        action: "nl_sql_query",
        metadata: {
            intent: body.intent,
            template_key,
            row_count: result_rows.length,
            sql_ms,
            llm_ms,
            total_ms,
            sql_error,
        },
    }).catch(() => { }); // non-fatal

    // SLO warning
    if (total_ms > 1500) {
        console.warn(`[nl-sql-handler] SLO breach: ${total_ms}ms > 1500ms target`);
    }

    return new Response(JSON.stringify({
        intent: body.intent,
        template_used: template_key,
        template_description: template.description,
        data: result_rows,
        summary,
        meta: {
            row_count: result_rows.length,
            sql_ms,
            llm_ms,
            total_ms,
            slo_met: total_ms <= 1500,
        },
    }), { headers: CORS_HEADERS });
});
