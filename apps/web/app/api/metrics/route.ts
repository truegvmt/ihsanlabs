/**
 * apps/web/app/api/metrics/route.ts
 * Next.js API route — GET /api/metrics?intent=<natural language>
 * Proxies to Supabase nl-sql-handler edge function
 * Returns: { data, summary, meta }
 */

import { NextRequest, NextResponse } from "next/server";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function GET(req: NextRequest) {
    const intent = req.nextUrl.searchParams.get("intent");
    if (!intent || intent.trim().length < 3) {
        return NextResponse.json({ error: "intent query param required (min 3 chars)" }, { status: 400 });
    }

    try {
        const edgeRes = await fetch(
            `${SUPABASE_URL}/functions/v1/nl-sql-handler`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
                },
                body: JSON.stringify({ intent }),
            }
        );

        if (!edgeRes.ok) {
            return NextResponse.json({ error: "Metrics service unavailable" }, { status: 502 });
        }

        const data = await edgeRes.json();
        return NextResponse.json(data, {
            headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" },
        });
    } catch (err) {
        console.error("[/api/metrics] error:", err);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const { intent } = await req.json() as { intent: string };
        if (!intent) return NextResponse.json({ error: "intent required" }, { status: 400 });

        const edgeRes = await fetch(
            `${SUPABASE_URL}/functions/v1/nl-sql-handler`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
                },
                body: JSON.stringify({ intent }),
            }
        );

        const data = await edgeRes.json();
        return NextResponse.json(data);
    } catch (err) {
        console.error("[/api/metrics] POST error:", err);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
