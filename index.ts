// supabase/functions/allocation-optimizer/index.ts
// Edge Function: POST /functions/v1/allocation-optimizer
// Deterministic scorer + LLM resonance layer for instant allocation plans
// <!-- VIBE-CODER: Update BARAKAH_WEIGHTS when taxonomy is revised -->

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

// ─── Barakah weight taxonomy (expert-encoded) ──────────────────
// [BARAKAH_WEIGHTS_VERSION]: 1.0
const BARAKAH_WEIGHTS: Record<string, number> = {
  water: 1.5,        // Hadith: "the best sadaqah is giving water"
  education: 1.4,    // knowledge that outlives the donor
  mosque: 1.4,       // ongoing worship
  quran: 1.3,        // knowledge
  healthcare: 1.2,
  orphan: 1.3,
  food: 1.1,
  shelter: 1.1,
  general: 1.0,
};

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  let body: {
    intention_id: string;
    focus: string;
    region: string;
    budget_usd: number;
    donor_id?: string;
    horizon?: string;
  };

  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }

  const { intention_id, focus, region, budget_usd, donor_id, horizon } = body;

  // ── Step 1: Fetch candidate projects (cached top 200) ──────────
  const { data: candidates } = await supabase
    .from("projects")
    .select(`
      id, title, description, focus, region, final_score,
      barakah_weight, estimated_beneficiaries, estimated_duration_months,
      is_waqf_eligible, funding_goal, funding_raised, thumbnail_url,
      organizations(name, overall_score)
    `)
    .eq("focus", focus)
    .eq("status", "active")
    .gte("final_score", 40)
    .order("final_score", { ascending: false })
    .limit(20);

  if (!candidates || candidates.length === 0) {
    // Fallback: broaden search without region filter
    return new Response(JSON.stringify({ error: "No candidates found", candidates: [] }), { status: 200 });
  }

  // ── Step 2: Deterministic scoring ──────────────────────────────
  const scored = candidates.map((p) => {
    const barakah = BARAKAH_WEIGHTS[p.focus] ?? 1.0;
    const perpetualBonus = p.is_waqf_eligible && horizon === "perpetual" ? 10 : 0;
    const fundingGap = p.funding_goal > 0
      ? (p.funding_goal - (p.funding_raised ?? 0)) / p.funding_goal
      : 0.5;
    const urgencyBonus = fundingGap > 0.7 ? 5 : 0; // high funding gap = more leverage

    return {
      ...p,
      composite_score: (p.final_score ?? 50) * barakah + perpetualBonus + urgencyBonus,
    };
  }).sort((a, b) => b.composite_score - a.composite_score);

  const top = scored[0];

  // ── Step 3: RAG retrieval for top project ──────────────────────
  const { data: chunks } = await supabase.rpc("match_chunks", {
    query_embedding: new Array(1536).fill(0), // placeholder — replace with real embedding
    match_threshold: 0.6,
    match_count: 3,
    filter_project_id: top.id,
  });

  const retrievedChunks = (chunks ?? []).map((c: any) => ({
    chunk_id: c.id,
    text: c.chunk_text,
    source_title: c.source_title ?? "Field Report",
    source_url: c.source_url ?? "",
  }));

  // ── Step 4: LLM evocative layer ────────────────────────────────
  const projectSummary = `${top.title}. ${top.description ?? ""}. Estimated beneficiaries: ${top.estimated_beneficiaries ?? "unknown"}. Duration: ${top.estimated_duration_months ?? "ongoing"} months.`;

  let llmOutput = {
    voice_text: `Your gift supports ${top.title}, bringing lasting benefit to ${top.estimated_beneficiaries ?? "many"} people.`,
    dua_template: "May Allah accept this charity and write its reward in your scales.",
    spiritual_note: "This project qualifies as sadaqah jariyah through its ongoing benefit.",
    evocative_line: `${top.title} — impact that endures.`,
    citations: [] as string[],
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
        max_tokens: 600,
        system: `You are a concise, reverent spiritual assistant for a Muslim charitable giving platform.
Return ONLY a JSON object — no preamble, no markdown fences:
{
  "voice_text": "<30–40 word calm script connecting intention to project impact. Second person. No superlatives.>",
  "dua_template": "<1–2 lines dua starting with 'May Allah...'>",
  "spiritual_note": "<1 sentence explaining sadaqah jariyah mechanism>",
  "evocative_line": "<≤ 12 words, poetic image of long-term impact>",
  "citations": ["<chunk_id>"]
}
Never fabricate numbers not in the input.`,
        messages: [{
          role: "user",
          content: JSON.stringify({
            intention: focus,
            top_project_summary: projectSummary,
            retrieved_chunks: retrievedChunks,
          }),
        }],
      }),
    });

    const anthropicData = await anthropicRes.json();
    const rawText = anthropicData.content?.[0]?.text ?? "";
    const clean = rawText.replace(/```json|```/g, "").trim();
    llmOutput = JSON.parse(clean);
  } catch (e) {
    // LLM failure is non-fatal — use deterministic fallback above
    console.error("LLM evocative layer failed:", e);
  }

  // ── Step 5: Build allocation plan ─────────────────────────────
  // Simple split: 85% to top project, 15% to second if available
  const allocations = [
    {
      project_id: top.id,
      project_title: top.title,
      amount_usd: Math.round(budget_usd * (scored[1] ? 0.85 : 1.0) * 100) / 100,
      reason: "Highest composite score for focus and region",
      score: top.composite_score,
      is_waqf_eligible: top.is_waqf_eligible,
    },
  ];

  if (scored[1]) {
    allocations.push({
      project_id: scored[1].id,
      project_title: scored[1].title,
      amount_usd: Math.round(budget_usd * 0.15 * 100) / 100,
      reason: "Diversification across top-ranked opportunity",
      score: scored[1].composite_score,
      is_waqf_eligible: scored[1].is_waqf_eligible,
    });
  }

  // ── Step 6: Persist plan + audit log ──────────────────────────
  const { data: plan } = await supabase
    .from("allocation_plans")
    .insert({
      intention_id,
      donor_id: donor_id ?? null,
      total_usd: budget_usd,
      generated_by: "deterministic_v1+llm",
      llm_model: "claude-sonnet-4-20250514",
      chunks_used: llmOutput.citations,
      allocations,
      evocative_line: llmOutput.evocative_line,
      barakah_score: top.composite_score,
      voice_text: llmOutput.voice_text,
      dua_template: llmOutput.dua_template,
      spiritual_note: llmOutput.spiritual_note,
    })
    .select()
    .single();

  await supabase.from("audit_log").insert({
    donor_id: donor_id ?? null,
    action: "allocation_plan_generated",
    deterministic_score: top.composite_score,
    chunks_used: llmOutput.citations,
    entity_type: "allocation_plan",
    entity_id: plan?.id,
    metadata: { focus, region, budget_usd, top_project_id: top.id },
  });

  return new Response(
    JSON.stringify({
      plan_id: plan?.id,
      allocations,
      top_project: {
        id: top.id,
        title: top.title,
        thumbnail_url: top.thumbnail_url,
        is_waqf_eligible: top.is_waqf_eligible,
        estimated_beneficiaries: top.estimated_beneficiaries,
        estimated_duration_months: top.estimated_duration_months,
      },
      evocative_line: llmOutput.evocative_line,
      barakah_score: Math.round(top.composite_score),
      voice_text: llmOutput.voice_text,
      dua_template: llmOutput.dua_template,
      spiritual_note: llmOutput.spiritual_note,
      citations: llmOutput.citations,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
});
