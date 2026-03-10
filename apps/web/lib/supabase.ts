/**
 * apps/web/lib/supabase.ts
 * Supabase client helpers — browser + server (SSR-safe)
 */

import { createBrowserClient } from "@supabase/ssr";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/** Browser-side Supabase client (use inside client components) */
export function createClient() {
    return createBrowserClient(supabaseUrl, supabaseAnonKey);
}

/** Type helpers for database tables */
export type Json =
    | string | number | boolean | null
    | { [key: string]: Json | undefined }
    | Json[];

export interface Intention {
    id: string;
    donor_id: string | null;
    tags: string[];
    three_words: string | null;
    horizon: "one_time" | "monthly" | "annual" | "perpetual";
    region: string | null;
    focus: "water" | "education" | "food" | "healthcare" | "shelter" | "mosque" | "quran" | "orphan" | "general";
    budget_usd: number;
    session_id: string | null;
    created_at: string;
}

export interface AllocationPlan {
    id: string;
    intention_id: string;
    total_usd: number;
    allocations: Array<{
        project_id: string;
        amount_usd: number;
        project_title: string;
        org_name: string;
        reason: string;
        score: number;
    }>;
    evocative_line: string;
    barakah_score: number;
    voice_text: string | null;
    dua_template: string | null;
    spiritual_note: string | null;
    created_at: string;
}

export interface Project {
    id: string;
    title: string;
    description: string | null;
    focus: string;
    region: string | null;
    final_score: number | null;
    estimated_beneficiaries: number | null;
    is_waqf_eligible: boolean;
    organization_id: string | null;
}
