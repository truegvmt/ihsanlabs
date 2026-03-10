// supabase/functions/waqf-agent/index.ts
// Edge Function: POST /functions/v1/waqf-agent
// Autonomous reallocation agent using Prompt C — enforces donor policy constraints
// Auth: service_role (called by cron job every 6h, or on high-severity signal insert)
// <!-- VIBE-CODER: See docs/prompt-templates.md for Prompt C schema -->

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

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: CORS_HEADERS });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    let body: { donor_id: string; signal_ids: string[] };
    try {
        body = await req.json();
    } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: CORS_HEADERS });
    }

    const { donor_id, signal_ids } = body;

    // ── Step 1: Fetch donor policy ────────────────────────────────
    const { data: profile } = await supabase
        .from("donor_profiles")
        .select("risk_tolerance, auto_execute_threshold_usd, contingency_balance_usd, preferred_focus, preferred_region")
        .eq("id", donor_id)
        .single();

    if (!profile) {
        return new Response(JSON.stringify({ error: "Donor profile not found" }), { status: 404, headers: CORS_HEADERS });
    }

    // ── Step 2: Fetch signals ─────────────────────────────────────
    const { data: signals } = await supabase
        .from("agent_signals")
        .select("id, signal_type, region, description, severity, source, source_url")
        .in("id", signal_ids)
        .gt("expires_at", new Date().toISOString());

    if (!signals || signals.length === 0) {
        return new Response(JSON.stringify({ action: "no_action", reason: "No active signals found." }), { headers: CORS_HEADERS });
    }

    // ── Step 3: Fetch candidate projects ──────────────────────────
    const { data: candidates } = await supabase
        .from("projects")
        .select("id, title, focus, region, final_score, funding_goal, funding_raised")
        .eq("status", "active")
        .in("focus", profile.preferred_focus ?? [])
        .gte("final_score", 50)
        .order("final_score", { ascending: false })
        .limit(10);

    const candidateProjects = (candidates ?? []).map((p: any) => ({
        project_id: p.id, title: p.title, focus: p.focus, region: p.region, final_score: p.final_score,
        funding_gap_usd: Math.max(0, (p.funding_goal ?? 0) - (p.funding_raised ?? 0)),
    }));

    // ── Step 4: LLM agent decision (Prompt C) ─────────────────────
    const donorPolicy = {
        risk_tolerance: profile.risk_tolerance,
        auto_execute_threshold_usd: profile.auto_execute_threshold_usd,
        priority_focus: profile.preferred_focus ?? [],
        excluded_regions: [],
        contingency_balance_usd: profile.contingency_balance_usd,
    };

    // Deterministic safe default
    let agentResult = { action: "no_action", reason: "Insufficient data for autonomous decision.", reallocation_plan: [], citations: [], confidence: 0 };

    try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({
                model: "claude-sonnet-4-20250514",
                max_tokens: 600,
                system: "You are an autonomous waqf agent. Return ONLY a JSON object: {action:\"no_action\"|\"propose\"|\"execute\", reason:string, reallocation_plan:[{project_id,from_amount_usd,to_amount_usd,rationale}], citations:[{signal_id,source,url}], confidence:float}. SAFETY RULES: never exceed contingency_balance_usd; never allocate to excluded_regions; never set action=execute if any reallocation exceeds auto_execute_threshold_usd; conservative bias.",
                messages: [{ role: "user", content: JSON.stringify({ donor_policy: donorPolicy, current_signals: signals, candidate_projects: candidateProjects }) }],
            }),
        });
        const resData = await res.json();
        const raw = resData.content?.[0]?.text ?? "";
        agentResult = JSON.parse(raw.replace(/```json|```/g, "").trim());

        // Safety enforcement: downgrade execute → propose if threshold exceeded
        if (agentResult.action === "execute") {
            const maxSingleRealloc = Math.max(...(agentResult.reallocation_plan ?? []).map((r: any) => r.to_amount_usd ?? 0), 0);
            if (maxSingleRealloc > (profile.auto_execute_threshold_usd ?? 0)) {
                agentResult.action = "propose";
                agentResult.reason = `[Safety downgrade] ${agentResult.reason}`;
            }
        }
    } catch (e) {
        console.error("[waqf-agent] LLM call failed:", e);
    }

    // ── Step 5: Persist agent action + audit log ──────────────────
    const { data: actionRecord } = await supabase
        .from("agent_actions")
        .insert({
            donor_id,
            signal_id: signal_ids[0] ?? null,
            action: agentResult.action,
            reason: agentResult.reason,
            reallocation_plan: agentResult.reallocation_plan,
            citations: agentResult.citations,
            auto_executed: agentResult.action === "execute",
        })
        .select()
        .single();

    await supabase.from("audit_log").insert({
        donor_id,
        action: `agent_${agentResult.action}`,
        entity_type: "agent_action",
        entity_id: actionRecord?.id,
        metadata: { signal_ids, confidence: agentResult.confidence, reallocation_count: agentResult.reallocation_plan?.length ?? 0 },
    });

    return new Response(JSON.stringify(actionRecord), { headers: CORS_HEADERS });
});
