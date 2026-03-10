// supabase/functions/due-diligence/index.ts
// Edge Function: POST /functions/v1/due-diligence
// Cache-first due diligence report generator using Prompt B
// <!-- VIBE-CODER: See docs/prompt-templates.md for Prompt B schema -->

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;

const CACHE_TTL_DAYS = 7;
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

    let body: { project_id: string; force_refresh?: boolean };
    try {
        body = await req.json();
    } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: CORS_HEADERS });
    }

    const { project_id, force_refresh = false } = body;
    const cacheFrom = new Date(Date.now() - CACHE_TTL_DAYS * 86400 * 1000).toISOString();

    // ── Step 1: Check cache (7-day TTL) ────────────────────────────
    if (!force_refresh) {
        const { data: cached } = await supabase
            .from("due_diligence_reports")
            .select("*")
            .eq("project_id", project_id)
            .gte("created_at", cacheFrom)
            .order("created_at", { ascending: false })
            .limit(1)
            .single();

        if (cached) {
            return new Response(JSON.stringify({ ...cached, cached: true }), { headers: CORS_HEADERS });
        }
    }

    // ── Step 2: Fetch project + org data ────────────────────────────
    const { data: project } = await supabase
        .from("projects")
        .select("*, organizations(name, overall_score, accountability_score)")
        .eq("id", project_id)
        .single();

    if (!project) {
        return new Response(JSON.stringify({ error: "Project not found" }), { status: 404, headers: CORS_HEADERS });
    }

    // ── Step 3: Generate embedding + fetch evidence chunks ──────────
    let queryEmbedding: number[] = new Array(1536).fill(0);
    try {
        const embRes = await fetch("https://api.openai.com/v1/embeddings", {
            method: "POST",
            headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ input: `${project.title} ${project.description ?? ""}`.trim(), model: "text-embedding-3-small" }),
        });
        const embData = await embRes.json();
        queryEmbedding = embData.data?.[0]?.embedding ?? queryEmbedding;
    } catch (e) {
        console.error("[due-diligence] Embedding failed:", e);
    }

    const { data: chunks } = await supabase.rpc("match_chunks", {
        query_embedding: queryEmbedding,
        match_threshold: 0.72,
        match_count: 5,
        filter_project_id: project_id,
    });
    const evidenceChunks = (chunks ?? []).map((c: any) => ({
        chunk_id: c.id, text: c.chunk_text, source_title: c.source_title, source_url: c.source_url, doc_type: c.doc_type ?? "narrative",
    }));

    // ── Step 4: Deterministic base score ────────────────────────────
    const orgScore = project.organizations?.overall_score ?? 50;
    const auditPresent = evidenceChunks.some((c: any) => c.doc_type === "audit" || c.text.includes("audited financial"));
    const maintenancePresent = evidenceChunks.some((c: any) => /maintenance|committee|trained|service schedule/i.test(c.text));
    const beneficiaryPresent = evidenceChunks.some((c: any) => /beneficiar|household|families|recipients/i.test(c.text));
    const durationScore = Math.min((project.estimated_duration_months ?? 0), 60) / 60 * 100;
    const deterministicScore = orgScore * 0.35 + (auditPresent ? 100 : 0) * 0.20 + (maintenancePresent ? 100 : 0) * 0.15 + (beneficiaryPresent ? 100 : 0) * 0.15 + durationScore * 0.15;

    // ── Step 5: LLM adjustment (Prompt B) ───────────────────────────
    let llmResult = { llm_adjustment: 0, short_summary: "Analysis pending.", risks: [], maintenance_plan: "Not documented.", top_citations: [], adjustment_reasoning: "Fallback: no LLM call made." };

    try {
        if (evidenceChunks.length === 0) throw new Error("No evidence; skipping LLM");
        const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({
                model: "claude-sonnet-4-20250514",
                max_tokens: 900,
                system: "You are an evidence-first due diligence engine. Return ONLY a JSON object — no preamble, no fences. Schema: {llm_adjustment:float(-10..+10), short_summary:string, risks:[{type,severity,explanation,citation_chunk_id}], maintenance_plan:string, top_citations:[{title,url,chunk_id}], adjustment_reasoning:string}. Conservative bias; flag evidence gaps; limit risks to 5.",
                messages: [{ role: "user", content: JSON.stringify({ project_meta: { id: project.id, title: project.title, focus: project.focus, organization_name: project.organizations?.name, overall_score: orgScore, estimated_beneficiaries: project.estimated_beneficiaries, estimated_duration_months: project.estimated_duration_months }, evidence_chunks: evidenceChunks }) }],
            }),
        });
        const resData = await res.json();
        const raw = resData.content?.[0]?.text ?? "";
        llmResult = JSON.parse(raw.replace(/```json|```/g, "").trim());
    } catch (e) {
        console.error("[due-diligence] LLM call failed:", e);
    }

    const finalScore = Math.min(100, Math.max(0, deterministicScore + (llmResult.llm_adjustment ?? 0)));

    // ── Step 6: Persist report ───────────────────────────────────────
    const { data: report } = await supabase
        .from("due_diligence_reports")
        .insert({
            project_id,
            deterministic_score: deterministicScore,
            llm_adjustment: llmResult.llm_adjustment,
            final_score: finalScore,
            short_summary: llmResult.short_summary,
            risks: llmResult.risks,
            maintenance_plan: llmResult.maintenance_plan,
            top_citations: llmResult.top_citations,
            llm_model: evidenceChunks.length > 0 ? "claude-sonnet-4-20250514" : null,
            chunks_used: evidenceChunks.map((c: any) => c.chunk_id),
        })
        .select()
        .single();

    // Step 7: Update project.last_due_diligence_at (trigger handles this automatically)
    await supabase.from("audit_log").insert({
        action: "due_diligence_generated",
        entity_type: "due_diligence_report",
        entity_id: report?.id,
        metadata: { project_id, deterministic_score: deterministicScore, llm_adjustment: llmResult.llm_adjustment, chunk_count: evidenceChunks.length },
    });

    return new Response(JSON.stringify({ ...report, cached: false }), { headers: CORS_HEADERS });
});
