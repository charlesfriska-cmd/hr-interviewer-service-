/**
 * Outbound response DTOs — hand-built allowlists, never a pass-through
 * serialization of an internal entity (API_CONTRACT.md v3 §7).
 *
 * This is what keeps evidence, strength, coverage, confidence band, gate status,
 * operational reasoning and every scoring signal off the candidate-facing surface
 * even if a future refactor widens an entity.
 */
import type { Interview, InterviewState } from '../../domain/types/entities.ts';

export interface InterviewStatusResponse {
  readonly interview: {
    readonly id: string;
    readonly status: string;
    readonly createdAt: string;
    readonly startedAt: string | null;
  };
  readonly progress: {
    readonly phase: string;
    readonly questionsAsked: number;
    readonly questionsRemaining: number;
  };
  readonly currentQuestion: { readonly id: string; readonly text: string } | null;
}

export function toInterviewStatusResponse(
  interview: Interview,
  state: InterviewState,
  currentQuestion: { id: string; text: string } | null,
): InterviewStatusResponse {
  return {
    interview: {
      id: interview.id,
      status: interview.status,
      createdAt: interview.createdAt,
      startedAt: interview.startedAt ?? null,
    },
    progress: {
      phase: state.currentPhase,
      questionsAsked: state.questionsAskedCount,
      questionsRemaining: Math.max(0, interview.maxQuestions - state.questionsAskedCount),
    },
    currentQuestion,
  };
}

/** Recruiter-facing. Reads persisted, already-finalized data; never recomputed. */
export function toResultResponse(row: Record<string, unknown>): Record<string, unknown> {
  return {
    interviewId: row.interview_id,
    scoringConfigVersion: row.scoring_config_version,
    competencyScore: row.competency_score === null ? null : Number(row.competency_score),
    competencyConfidenceBand: row.competency_confidence_band,
    criticalGateStatus: row.critical_gate_status,
    overallRecommendation: row.overall_recommendation,
    overallConfidenceBand: row.overall_confidence_band,
    keyStrengths: row.key_strengths,
    concerns: row.concerns,
    unverifiedAreas: row.unverified_areas,
    contradictions: row.contradictions,
    riskFlags: row.risk_flags,
    niceToHaveHighlights: row.nice_to_have_highlights,
    recommendationRationale: row.recommendation_rationale,
    generatedAt: row.generated_at,
  };
}
