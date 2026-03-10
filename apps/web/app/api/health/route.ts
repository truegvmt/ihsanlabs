/**
 * apps/web/app/api/health/route.ts
 * Health check endpoint for monitoring and observability
 */

import { NextResponse } from "next/server";

export async function GET() {
    const start = Date.now();
    const checks: Record<string, any> = {
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        env: process.env.NODE_ENV,
    };

    try {
        const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
            checks.supabase = { status: "error", message: "Environment variables missing" };
        } else {
            // Ping the edge function health check or a simple fetch
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            try {
                const res = await fetch(`${SUPABASE_URL}/functions/v1/allocation-optimizer`, {
                    method: "HEAD", // Minimal traffic
                    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
                    signal: controller.signal,
                });

                checks.supabase = {
                    status: res.status < 500 ? "healthy" : "unhealthy",
                    statusCode: res.status,
                    latency: `${Date.now() - start}ms`,
                };
            } catch (err: any) {
                checks.supabase = {
                    status: "unreachable",
                    message: err.message,
                    code: err.cause?.code,
                };
            } finally {
                clearTimeout(timeoutId);
            }
        }

        const overallHealthy = checks.supabase?.status === "healthy";

        return NextResponse.json(
            {
                status: overallHealthy ? "ok" : "degraded",
                ...checks
            },
            { status: overallHealthy ? 200 : 503 }
        );
    } catch (err: any) {
        return NextResponse.json(
            { status: "error", message: err.message },
            { status: 500 }
        );
    }
}
