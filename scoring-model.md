# Scoring Model — Ihsan Labs
## docs/scoring-model.md
<!-- VIBE-CODER: Update [SCORING_VERSION] and the weights tables whenever packages/scoring/src/weights.ts or packages/scoring/src/barakah.ts change. The numeric weights here must always match the code — this document is the human-readable contract. -->
<!-- [SCORING_VERSION]: 1.0.0 -->
<!-- [WEIGHTS_FILE]: packages/scoring/src/weights.ts -->
<!-- [BARAKAH_FILE]: packages/scoring/src/barakah.ts -->
<!-- [LAST_REVIEWED]: 2025 -->

---

## Overview

Every project in Ihsan Labs carries a `final_score` between 0 and 100. This score is the primary signal used by the `allocation-optimizer` to rank and select projects for a donor's allocation plan. It is also shown in the Due Diligence panel as the score ring.

The score is computed in two stages. First, a deterministic base score is calculated using the factors described below — this stage involves no LLM and always produces the same output for the same inputs. Second, the LLM reviews the project's evidence chunks and applies an adjustment of between −10 and +10 points. The final score is clamped to the range 0–100 and stored in `projects.final_score`.

This two-stage approach ensures that the score is explainable, reproducible, and manipulation-resistant. The LLM cannot override the deterministic assessment — it can only make a small upward or downward correction based on what it finds in the evidence.

---

## Deterministic Base Score

The base score is a weighted sum of five factors. Each factor is evaluated to produce a sub-score between 0 and 100, and the sub-scores are combined using the weights below.

| Factor | Weight | How it is measured |
|--------|--------|--------------------|
| Organization quality | 35% | `organizations.overall_score` from Charity Navigator (0–100). If no Charity Navigator data is available, defaults to 50. |
| External audit present | 20% | Binary: 1 if any `document_chunks` row for this project or its parent organization has `doc_type = 'audit'`, or if the chunk text contains the phrase "audited financial statements." Otherwise 0. |
| Maintenance plan documented | 15% | Binary: 1 if any chunk mentions "maintenance," "committee," "trained," or "service schedule." Otherwise 0. |
| Beneficiary count corroborated | 15% | Binary: 1 if any chunk mentions "beneficiar," "household," "families," or "recipients" in a quantified context. Otherwise 0. |
| Project duration | 15% | Continuous: `min(estimated_duration_months, 60) / 60 × 100`. A 60-month project scores 100 on this factor; a 12-month project scores 20. |

The binary factors are intentionally coarse. A chunk that mentions "maintenance committee" satisfies the maintenance signal even if the committee's effectiveness is unknown. The LLM adjustment stage is where nuance about the quality of these signals is captured.

---

## Barakah Weight

Before the LLM adjustment is applied, the deterministic base score is multiplied by a barakah weight. The weight reflects the Islamic legal and ethical priority of different categories of charitable giving, based on hadith evidence and scholarly consensus.

| Focus category | Weight | Primary basis |
|----------------|--------|---------------|
| water | 1.5 | "The best sadaqah is giving water" (Ibn Mājah) |
| mosque | 1.4 | Perpetual place of worship and community |
| education | 1.4 | Knowledge that continues to benefit after the donor's death |
| quran | 1.3 | Preservation of and access to revelation |
| orphan care | 1.3 | Prophetic emphasis on the guardian of orphans |
| healthcare | 1.2 | Sustained physiological benefit to living people |
| food | 1.1 | Essential but episodic rather than perpetual |
| shelter | 1.1 | Essential but typically does not generate ongoing reward |
| general | 1.0 | Baseline — no specific multiplier |

The weighted score is clamped to 100 before the LLM adjustment is applied, so a high-quality water project (base score 80 × 1.5 = 120) is clamped to 100 before the LLM adds its ±10. This prevents the barakah weight from producing scores that compress differentiation near the top of the scale.

A perpetual-horizon bonus of 10 points is added before clamping when the donor has selected `horizon = 'perpetual'` and the project has `is_waqf_eligible = true`. This bonus reflects the additional alignment between a donor's stated intention and the project's capability to serve as a long-term waqf.

---

## LLM Adjustment (±10 points)

The `due-diligence` edge function passes the project metadata and up to five retrieved evidence chunks to the LLM (Prompt B). The LLM returns a structured JSON response that includes an `llm_adjustment` float between −10 and +10, and an `adjustment_reasoning` string explaining the primary driver.

The LLM is instructed to apply a conservative bias: evidence gaps or unverified claims produce a negative adjustment, while strong corroboration across multiple independent documents produces a positive one. The adjustment is not a re-scoring — it is a calibration of the deterministic base.

Common negative adjustments: uncorroborated beneficiary count (−3 to −5); no external audit despite the organization claiming one (−5); a single field report as the only evidence source (−2 to −3); political exposure flagged in signal feed (−3).

Common positive adjustments: multiple independent sources corroborating the same impact figures (+3 to +5); a formal audit present and consistent with project claims (+3); IoT telemetry confirming operational status in real time (+5); long operational history with no adverse events (+2 to +4).

---

## Composite Score in the Allocation Optimizer

The `allocation-optimizer` edge function does not call the LLM for its scoring step — it reads `final_score` from the `projects` table, which is pre-computed by the due-diligence pipeline. At optimization time, it adds two additional signals that are specific to the donor's context.

A funding gap bonus of 5 points is added when a project's funding gap (the proportion of its goal that remains unfunded) exceeds 70%. This reflects the leverage principle: a marginal dollar has more impact in a project that is close to its funding threshold than in one that is fully funded.

A perpetual-horizon bonus of 10 points is added when the donor's selected horizon is `perpetual` and the project is `is_waqf_eligible`. This is the same bonus described in the Barakah Weight section above, applied a second time at optimizer runtime to ensure it influences candidate ranking.

The composite score used for ranking is therefore: `final_score × barakah_weight + perpetual_bonus + funding_gap_bonus`. This composite is not persisted — it is computed in memory during the optimizer run and used only for candidate ordering.

---
<!-- VIBE-CODER SECTION — UPDATE ON CHANGE -->
<!-- [BASE_SCORE_DEFAULT_IF_NO_CN]: 50 -->
<!-- [MAX_DURATION_MONTHS_FOR_SCORE]: 60 -->
<!-- [BARAKAH_CAP_BEFORE_LLM]: 100 -->
<!-- [PERPETUAL_BONUS_POINTS]: 10 -->
<!-- [FUNDING_GAP_THRESHOLD]: 0.70 -->
<!-- [FUNDING_GAP_BONUS_POINTS]: 5 -->
<!-- [LLM_ADJUSTMENT_RANGE]: -10 to +10 -->
