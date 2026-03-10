// supabase/functions/micro-update-composer/index.ts
// Edge Function: POST /functions/v1/micro-update-composer
// Converts raw field events into single-sentence Living Waqf Card updates (Prompt D)
// Auth: service_role (called by internal event pipeline, not client-facing)
// <!-- VIBE-CODER: See docs/prompt-templates.md for Prompt D schema -->

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

    let body: {
        event_id: string;
        waqf_asset_id: string;
        event_type: string;
        raw_content: string;
        donor_id?: string;
    };
    try {
        body = await req.json();
    } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: CORS_HEADERS });
    }

    const { event_id, waqf_asset_id, event_type, raw_content, donor_id } = body;

    // ── Step 1: Fetch waqf asset details ────────────────────────────
    const { data: asset } = await supabase
        .from("waqf_assets")
        .select("name, asset_type, location_description")
        .eq("id", waqf_asset_id)
        .single();

    if (!asset) {
        return new Response(JSON.stringify({ error: "Waqf asset not found" }), { status: 404, headers: CORS_HEADERS });
    }

    // Deterministic fallback
    let result = {
        composed_update: `Your ${asset.name} has a new field update.`,
        tone: "neutral" as string,
        action_required: false,
        action_prompt: null as string | null,
    };

    // ── Step 2: LLM composition (Prompt D) ─────────────────────────
    try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({
                model: "claude-sonnet-4-20250514",
                max_tokens: 400,
                system: "You compose one-sentence living waqf updates. Return ONLY a JSON object: {composed_update:string(<=20 words), tone:\"positive\"|\"neutral\"|\"alert\", action_required:boolean, action_prompt:string|null}. Rules: present tense; specific; personal ('your well'); no jargon; for issue events with risk tone=alert; for beneficiary_story tone=positive.",
                messages: [{
                    role: "user",
                    content: JSON.stringify({
                        event_type,
                        raw_content,
                        waqf_asset: { name: asset.name, asset_type: asset.asset_type, location_description: asset.location_description },
                        donor_first_name: "there",
                    }),
                }],
            }),
        });
        const resData = await res.json();
        const raw = resData.content?.[0]?.text ?? "";
        result = JSON.parse(raw.replace(/```json|```/g, "").trim());
    } catch (e) {
        console.error("[micro-update-composer] LLM call failed:", e);
    }

    // ── Step 3: Update waqf_events.composed_update ──────────────────
    await supabase
        .from("waqf_events")
        .update({ composed_update: result.composed_update })
        .eq("id", event_id);

    // ── Step 4: Audit log ────────────────────────────────────────────
    await supabase.from("audit_log").insert({
        donor_id: donor_id ?? null,
        action: "micro_update_composed",
        entity_type: "waqf_event",
        entity_id: event_id,
        metadata: { waqf_asset_id, event_type, tone: result.tone, action_required: result.action_required },
    });

    return new Response(JSON.stringify(result), { headers: CORS_HEADERS });
});
