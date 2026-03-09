// supabase/functions/due-diligence/index.ts
// Edge Function: POST /functions/v1/due-diligence
// Triggered when: (a) donor taps "Explain", (b) new evidence chunk arrives for a project
// <!-- VIBE-CODER: Update DETERMINISTIC_WEIGHTS when scoring model changes -->

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

// ─── Deterministic scoring weights ────────────────────────────
// [DETERMINISTIC_WEIGHTS_VERSION]: 1.0
const WEIGHTS = {
  charity_navigator_score: 0.35,   // financial health + accountability
  has_audit: 0.20,                 // formal external audit present
  has_maintenance_plan: 0.15,      // documented maintenance / sustainability
  beneficiary_count_verified: 0.15,// beneficiary numbers backed by field report
  duration_score: 0.15,            // longer projects score higher (capped at 60 months)
};

function deterministic(meta: any, chunks: any[]): number {
  const cnScore = (meta.overall_score ?? 50) * WEIGHTS.charity_navigator_score;

  const hasAudit = chunks.some(c =>
    c.doc_type === "audit" || c.text?.toLowerCase().includes("audited financial")
  ) ? 1 : 0;
  const auditScore = hasAudit * 100 * WEIGHTS.has_audit;

  const hasMaint = chunks.some(c =>
    c.text?.toLowerCase().includes("maintenance") || c.text?.toLowerCase().includes("committee")
  ) ? 1 : 0;
  const maintScore = hasMaint * 100 * WEIGHTS.has_maintenance_plan;

  const hasBenef = chunks.some(c =>
    c.text?.toLowerCase().includes("beneficiar") ||
    c.text?.toLowerCase().includes("household") ||
    c.text?.toLowerCase().includes("families")
  ) ? 1 : 0;
  const benefScore = hasBenef * 100 * WEIGHTS.beneficiary_count_verified;

  const durationMonths = Math.min(meta.estimated_duration_months ?? 12, 60);
  const durScore = (durationMonths / 60) * 100 * WEIGHTS.duration_score;

  return Math.round(cnScore + auditScore + maintScore + benefScore + durScore);
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { project_id, force_refresh = false } = await req.json();

  // ── Check for recent cached report ────────────────────────────
  if (!force_refresh) {
    const { data: cached } = await supabase
      .from("due_diligence_reports")
      .select("*")
      .eq("project_id", project_id)
      .gte("created_at", new Date(Date.now() - 7 * 86400 * 1000).toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (cached) {
      return new Response(JSON.stringify({ cached: true, report: cached }), {
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // ── Fetch project + org data ───────────────────────────────────
  const { data: project } = await supabase
    .from("projects")
    .select(`*, organizations(name, overall_score, accountability_score)`)
    .eq("id", project_id)
    .single();

  if (!project) {
    return new Response(JSON.stringify({ error: "Project not found" }), { status: 404 });
  }

  // ── Fetch evidence chunks ──────────────────────────────────────
  const { data: chunks } = await supabase
    .from("document_chunks")
    .select("id, chunk_text, source_title, source_url, metadata")
    .eq("project_id", project_id)
    .limit(5);

  const evidenceChunks = (chunks ?? []).map((c) => ({
    chunk_id: c.id,
    text: c.chunk_text,
    source_title: c.source_title ?? "Document",
    source_url: c.source_url ?? "",
    doc_type: c.metadata?.doc_type ?? "unknown",
  }));

  // ── Deterministic score ────────────────────────────────────────
  const projectMeta = {
    overall_score: project.organizations?.overall_score ?? 50,
    estimated_duration_months: project.estimated_duration_months,
    estimated_beneficiaries: project.estimated_beneficiaries,
  };

  const detScore = deterministic(projectMeta, evidenceChunks);

  // ── LLM due diligence ─────────────────────────────────────────
  let llmReport: any = {
    llm_adjustment: 0,
    short_summary: `${project.title} — LLM analysis unavailable. Deterministic score: ${detScore}.`,
    risks: [{ type: "evidence_gap", severity: "medium", explanation: "LLM analysis not available.", citation_chunk_id: null }],
    maintenance_plan: "Not documented in available evidence.",
    top_citations: [],
    adjustment_reasoning: "LLM call failed; no adjustment applied.",
  };

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 900,
        system: `You are an evidence-first due diligence engine for a Muslim charitable giving platform.
Return ONLY a JSON object — no preamble, no markdown fences:
{
  "llm_adjustment": <float -10 to +10>,
  "short_summary": "<2–3 sentences>",
  "risks": [{ "type": "string", "severity": "low|medium|high|critical", "explanation": "string", "citation_chunk_id": "string|null" }],
  "maintenance_plan": "<string or 'Not documented in available evidence.'>",
  "top_citations": [{ "title": "string", "url": "string", "chunk_id": "string" }],
  "adjustment_reasoning": "<1 sentence>"
}
Conservative bias: any uncorroborated claim must generate an evidence_gap risk.
Limit risks to 5. top_citations limited to 3.`,
        messages: [{
          role: "user",
          content: JSON.stringify({
            project_meta: {
              id: project.id,
              title: project.title,
              focus: project.focus,
              organization_name: project.organizations?.name ?? "Unknown",
              overall_score: projectMeta.overall_score,
              funding_goal_usd: project.funding_goal,
              estimated_beneficiaries: project.estimated_beneficiaries,
              estimated_duration_months: project.estimated_duration_months,
            },
            evidence_chunks: evidenceChunks,
          }),
        }],
      }),
    });

    const data = await anthropicRes.json();
    const raw = data.content?.[0]?.text ?? "";
    llmReport = JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch (e) {
    console.error("LLM due diligence failed:", e);
  }

  const finalScore = Math.min(100, Math.max(0, detScore + (llmReport.llm_adjustment ?? 0)));

  // ── Persist report ─────────────────────────────────────────────
  const { data: report } = await supabase
    .from("due_diligence_reports")
    .insert({
      project_id,
      deterministic_score: detScore,
      llm_adjustment: llmReport.llm_adjustment,
      final_score: finalScore,
      short_summary: llmReport.short_summary,
      risks: llmReport.risks,
      maintenance_plan: llmReport.maintenance_plan,
      top_citations: llmReport.top_citations,
      llm_model: "claude-sonnet-4-20250514",
      llm_output_raw: JSON.stringify(llmReport),
      chunks_used: evidenceChunks.map((c) => c.chunk_id),
    })
    .select()
    .single();

  // ── Update project scores ──────────────────────────────────────
  await supabase
    .from("projects")
    .update({
      impact_score: detScore,
      llm_score: llmReport.llm_adjustment,
      final_score: finalScore,
      last_due_diligence_at: new Date().toISOString(),
    })
    .eq("id", project_id);

  // ── Audit log ─────────────────────────────────────────────────
  await supabase.from("audit_log").insert({
    action: "due_diligence_run",
    deterministic_score: detScore,
    chunks_used: evidenceChunks.map((c) => c.chunk_id),
    entity_type: "due_diligence_report",
    entity_id: report?.id,
    metadata: { project_id, final_score: finalScore },
  });

  return new Response(
    JSON.stringify({ cached: false, report }),
    { headers: { "Content-Type": "application/json" } }
  );
});
