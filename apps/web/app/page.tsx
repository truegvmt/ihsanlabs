"use client";

import { useState, useTransition } from "react";

const FOCUS_OPTIONS = [
    { value: "water", label: "💧 Water", emoji: "💧" },
    { value: "education", label: "📚 Education", emoji: "📚" },
    { value: "food", label: "🌾 Food", emoji: "🌾" },
    { value: "healthcare", label: "🏥 Healthcare", emoji: "🏥" },
    { value: "shelter", label: "🏠 Shelter", emoji: "🏠" },
    { value: "orphan", label: "🤲 Orphan", emoji: "🤲" },
    { value: "mosque", label: "🕌 Mosque", emoji: "🕌" },
    { value: "general", label: "✨ General", emoji: "✨" },
] as const;

const REGION_OPTIONS = [
    { value: "PK", label: "Pakistan" },
    { value: "BD", label: "Bangladesh" },
    { value: "NG", label: "Nigeria" },
    { value: "ET", label: "Ethiopia" },
    { value: "SD", label: "Sudan" },
    { value: "SO", label: "Somalia" },
    { value: "YE", label: "Yemen" },
    { value: "AF", label: "Afghanistan" },
    { value: "global", label: "Global — highest impact" },
];

const HORIZON_OPTIONS = [
    { value: "one_time", label: "One-time sadaqah" },
    { value: "monthly", label: "Monthly sadaqah jariyah" },
    { value: "annual", label: "Annual (Ramadan)" },
    { value: "perpetual", label: "Living Waqf — forever" },
];

type Step = "form" | "loading" | "resonance";

interface AllocationPlan {
    id: string;
    evocative_line: string;
    barakah_score: number;
    dua_template: string | null;
    spiritual_note: string | null;
    allocations: Array<{
        project_id: string;
        project_title: string;
        org_name: string;
        amount_usd: number;
        reason: string;
    }>;
}

export default function DonorPage() {
    const [step, setStep] = useState<Step>("form");
    const [plan, setPlan] = useState<AllocationPlan | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isPending, startTransition] = useTransition();

    const [focus, setFocus] = useState<string>("");
    const [region, setRegion] = useState<string>("global");
    const [horizon, setHorizon] = useState<string>("one_time");
    const [budget, setBudget] = useState<string>("100");
    const [threeWords, setThreeWords] = useState<string>("");

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!focus || !budget) return;

        setStep("loading");
        setError(null);

        startTransition(async () => {
            try {
                const res = await fetch("/api/allocate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        focus,
                        region,
                        horizon,
                        budget_usd: parseFloat(budget),
                        three_words: threeWords || null,
                    }),
                });
                if (!res.ok) throw new Error(`Error ${res.status}`);
                const data = await res.json();
                setPlan(data);
                setStep("resonance");
            } catch (err: unknown) {
                setError(err instanceof Error ? err.message : "Something went wrong");
                setStep("form");
            }
        });
    }

    return (
        <main style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px 16px" }}>
            {/* Ambient glow */}
            <div style={{ position: "fixed", inset: 0, pointerEvents: "none", background: "radial-gradient(ellipse 60% 40% at 50% 0%, rgba(99,102,241,0.12) 0%, transparent 70%)" }} />

            <div style={{ width: "100%", maxWidth: "480px", position: "relative" }}>
                {step === "form" && (
                    <div className="glass fade-up" style={{ padding: "40px 32px" }}>
                        {/* Header */}
                        <div style={{ textAlign: "center", marginBottom: "32px" }}>
                            <div style={{ fontSize: "2rem", marginBottom: "8px" }}>🌙</div>
                            <h1 style={{ fontSize: "1.75rem", fontWeight: 700, lineHeight: 1.2, marginBottom: "8px" }}>
                                <span className="gradient-text">Ihsan Labs</span>
                            </h1>
                            <p style={{ color: "var(--text-muted)", fontSize: "0.95rem" }}>
                                Give with intention. Every dirham guided by evidence.
                            </p>
                        </div>

                        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                            {/* Focus */}
                            <div>
                                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 500, color: "var(--text-muted)", marginBottom: "8px" }}>
                                    Where should your sadaqah flow?
                                </label>
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px" }}>
                                    {FOCUS_OPTIONS.map((f) => (
                                        <button
                                            key={f.value}
                                            type="button"
                                            onClick={() => setFocus(f.value)}
                                            style={{
                                                padding: "10px 4px",
                                                borderRadius: "8px",
                                                border: `1px solid ${focus === f.value ? "var(--accent)" : "var(--border)"}`,
                                                background: focus === f.value ? "rgba(99,102,241,0.12)" : "var(--bg-surface)",
                                                color: "var(--text-primary)",
                                                cursor: "pointer",
                                                fontSize: "0.75rem",
                                                display: "flex",
                                                flexDirection: "column",
                                                alignItems: "center",
                                                gap: "4px",
                                                transition: "all 0.15s",
                                            }}
                                        >
                                            <span style={{ fontSize: "1.25rem" }}>{f.emoji}</span>
                                            <span>{f.label.split(" ").slice(1).join(" ")}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Region */}
                            <div>
                                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 500, color: "var(--text-muted)", marginBottom: "8px" }}>Region</label>
                                <select className="input" value={region} onChange={(e) => setRegion(e.target.value)}>
                                    {REGION_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                                </select>
                            </div>

                            {/* Horizon */}
                            <div>
                                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 500, color: "var(--text-muted)", marginBottom: "8px" }}>Giving horizon</label>
                                <select className="input" value={horizon} onChange={(e) => setHorizon(e.target.value)}>
                                    {HORIZON_OPTIONS.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
                                </select>
                            </div>

                            {/* Budget */}
                            <div>
                                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 500, color: "var(--text-muted)", marginBottom: "8px" }}>Amount (USD)</label>
                                <input
                                    className="input"
                                    type="number"
                                    min="1"
                                    step="any"
                                    placeholder="100"
                                    value={budget}
                                    onChange={(e) => setBudget(e.target.value)}
                                    required
                                />
                            </div>

                            {/* Why */}
                            <div>
                                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 500, color: "var(--text-muted)", marginBottom: "8px" }}>
                                    Why are you giving? <span style={{ opacity: 0.5 }}>(optional)</span>
                                </label>
                                <input
                                    className="input"
                                    type="text"
                                    placeholder="e.g. for my parents, for barakah, in sha Allah"
                                    maxLength={120}
                                    value={threeWords}
                                    onChange={(e) => setThreeWords(e.target.value)}
                                />
                            </div>

                            {error && (
                                <p style={{ color: "var(--error)", fontSize: "0.875rem", textAlign: "center" }}>{error}</p>
                            )}

                            <button
                                className="btn-primary"
                                type="submit"
                                disabled={!focus || !budget || isPending}
                                style={{ width: "100%", marginTop: "4px" }}
                            >
                                {isPending ? "Finding your impact..." : "See Your Impact →"}
                            </button>
                        </form>
                    </div>
                )}

                {step === "loading" && (
                    <div className="glass fade-up" style={{ padding: "60px 32px", textAlign: "center" }}>
                        <div style={{ fontSize: "2.5rem", marginBottom: "16px", animation: "fadeUp 0.5s ease both" }}>🔍</div>
                        <h2 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "8px" }}>Scanning IATI evidence...</h2>
                        <p style={{ color: "var(--text-muted)", fontSize: "0.95rem" }}>
                            Matching your intention to verified field data across thousands of aid activities.
                        </p>
                    </div>
                )}

                {step === "resonance" && plan && (
                    <div className="fade-up" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                        {/* Evocative line */}
                        <div className="glass" style={{ padding: "32px", textAlign: "center" }}>
                            <div style={{ fontSize: "2rem", marginBottom: "12px" }}>✨</div>
                            <p style={{ fontSize: "1.15rem", fontWeight: 500, lineHeight: 1.5, fontStyle: "italic", color: "var(--text-primary)", marginBottom: "16px" }}>
                                &ldquo;{plan.evocative_line}&rdquo;
                            </p>
                            <span style={{
                                display: "inline-block",
                                padding: "4px 14px",
                                borderRadius: "100px",
                                background: "rgba(245,158,11,0.15)",
                                border: "1px solid rgba(245,158,11,0.3)",
                                color: "var(--accent-warm)",
                                fontSize: "0.85rem",
                                fontWeight: 600,
                            }}>
                                ✦ Barakah Score: {Math.round(plan.barakah_score)}/100
                            </span>
                        </div>

                        {/* Allocations */}
                        <div className="glass" style={{ padding: "24px" }}>
                            <h3 style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "16px" }}>
                                Your Allocation
                            </h3>
                            {plan.allocations.map((a, i) => (
                                <div key={i} style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "flex-start",
                                    gap: "12px",
                                    padding: "12px 0",
                                    borderBottom: i < plan.allocations.length - 1 ? "1px solid var(--border)" : "none",
                                }}>
                                    <div>
                                        <p style={{ fontWeight: 600, fontSize: "0.95rem" }}>{a.project_title}</p>
                                        <p style={{ color: "var(--text-muted)", fontSize: "0.8rem", marginTop: "2px" }}>{a.org_name}</p>
                                        <p style={{ color: "var(--text-muted)", fontSize: "0.8rem", marginTop: "4px", lineHeight: 1.4 }}>{a.reason}</p>
                                    </div>
                                    <span style={{ fontWeight: 700, color: "var(--accent-warm)", whiteSpace: "nowrap", fontSize: "1rem" }}>
                                        ${a.amount_usd.toFixed(2)}
                                    </span>
                                </div>
                            ))}
                        </div>

                        {/* Dua */}
                        {plan.dua_template && (
                            <div className="glass" style={{ padding: "20px 24px", textAlign: "center" }}>
                                <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "6px" }}>Your Dua</p>
                                <p style={{ fontStyle: "italic", lineHeight: 1.6 }}>{plan.dua_template}</p>
                            </div>
                        )}

                        {/* CTA */}
                        <button className="btn-primary" style={{ width: "100%" }}>
                            Confirm & Give Now →
                        </button>
                        <button
                            onClick={() => { setStep("form"); setPlan(null); }}
                            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: "0.875rem", textAlign: "center", padding: "8px" }}
                        >
                            ← Start over
                        </button>
                    </div>
                )}
            </div>
        </main>
    );
}
