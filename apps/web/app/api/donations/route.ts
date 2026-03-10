/**
 * apps/web/app/api/donations/route.ts
 * POST /api/donations — persist a confirmed donation after Stripe payment
 * GET  /api/donations — fetch donation history for authenticated donor
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

function supabaseServerClient() {
    const cookieStore = cookies();
    return createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { cookies: { get: (n: string) => cookieStore.get(n)?.value } }
    );
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json() as {
            intention_id: string;
            project_id: string;
            allocation_plan_id: string;
            amount_usd: number;
            stripe_payment_id: string;
        };

        const required = ["intention_id", "project_id", "amount_usd", "stripe_payment_id"];
        const missing = required.filter((k) => !(body as Record<string, unknown>)[k]);
        if (missing.length) {
            return NextResponse.json({ error: `Missing: ${missing.join(", ")}` }, { status: 400 });
        }

        const supabase = supabaseServerClient();

        const { data, error } = await supabase
            .from("donations")
            .insert({
                intention_id: body.intention_id,
                project_id: body.project_id,
                allocation_plan_id: body.allocation_plan_id ?? null,
                amount_usd: body.amount_usd,
                stripe_payment_id: body.stripe_payment_id,
                status: "confirmed",
                payment_method: "stripe",
                confirmed_at: new Date().toISOString(),
            })
            .select("id, amount_usd, status, confirmed_at")
            .single();

        if (error) {
            console.error("[/api/donations] insert error:", error);
            return NextResponse.json({ error: "Failed to persist donation" }, { status: 500 });
        }

        // Write to audit log
        await supabase.from("audit_log").insert({
            action: "donation_confirmed",
            entity_type: "donation",
            entity_id: data.id,
            metadata: { amount_usd: body.amount_usd, stripe_payment_id: body.stripe_payment_id },
        });

        return NextResponse.json(data, { status: 201 });
    } catch (err) {
        console.error("[/api/donations] error:", err);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

export async function GET(req: NextRequest) {
    const limit = Number(req.nextUrl.searchParams.get("limit") ?? "10");
    const supabase = supabaseServerClient();

    const { data, error } = await supabase
        .from("donations")
        .select("id, amount_usd, status, confirmed_at, disbursed_at, projects(title, focus, region)")
        .order("confirmed_at", { ascending: false })
        .limit(Math.min(limit, 50));

    if (error) {
        return NextResponse.json({ error: "Failed to fetch donations" }, { status: 500 });
    }

    return NextResponse.json({ donations: data });
}
