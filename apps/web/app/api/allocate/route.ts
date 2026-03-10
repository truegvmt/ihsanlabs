/**
 * apps/web/app/api/allocate/route.ts
 * Next.js API route — POST /api/allocate
 * Proxies to Supabase edge function (allocation-optimizer)
 * Server-side: LLM secrets never leave this layer
 */

import { NextRequest, NextResponse } from "next/server";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function POST(req: NextRequest) {
    try {
        const body = await req.json() as {
            focus: string;
            region?: string;
            horizon?: string;
            budget_usd: number;
            three_words?: string | null;
        };

        // Basic validation
        if (!body.focus || !body.budget_usd || body.budget_usd <= 0) {
            return NextResponse.json({ error: "focus and budget_usd are required" }, { status: 400 });
        }

        // Forward to Supabase edge function
        const edgeRes = await fetch(
            `${SUPABASE_URL}/functions/v1/allocation-optimizer`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
                },
                body: JSON.stringify({
                    intention_id: crypto.randomUUID(), // anonymous session
                    focus: body.focus,
                    region: body.region ?? "global",
                    budget_usd: body.budget_usd,
                    three_words: body.three_words ?? null,
                }),
            }
        );

        if (!edgeRes.ok) {
            const text = await edgeRes.text();
            console.error("[/api/allocate] edge fn error:", edgeRes.status, text);
            return NextResponse.json({ error: "Allocation service unavailable" }, { status: 502 });
        }

        const data = await edgeRes.json();
        return NextResponse.json(data);
    } catch (err) {
        console.error("[/api/allocate] error:", err);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
