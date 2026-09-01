/**
 * Opt-in synthetic smoke test against the real Claude API.
 *
 * NEVER part of the automated suite: it costs money and needs credentials.
 * Run with:  ANTHROPIC_API_KEY=... npm run smoke:claude
 *
 * Synthetic candidate data only. Bounded to a handful of turns — this is a
 * contract check, not an interview-quality evaluation.
 */
import { ClaudeProvider } from '../src/llm/providers/claude/ClaudeProvider.ts';
import { resolveProviderConfig } from '../src/config/provider.config.ts';
import { ProviderMetricsRecorder } from '../src/observability/providerMetrics.ts';
import {
  buildInitializationPayload,
  buildTurnPayload,
} from '../src/llm/prompt/buildUserPayload.ts';
import { validateDecision } from '../src/llm/schema/dispatch.ts';
import { SCENARIOS, type SmokeScenario } from './smokeScenarios.ts';

let cfg;
try {
  cfg = resolveProviderConfig({ ...process.env, LLM_PROVIDER: 'claude' });
} catch (err) {
  // This script costs money and needs real credentials; say so plainly rather
  // than surfacing a stack trace.
  process.stderr.write(
    `\nCannot run the Claude smoke test: ${err instanceof Error ? err.message : String(err)}\n` +
      `\nSet ANTHROPIC_API_KEY and re-run:  ANTHROPIC_API_KEY=sk-... npm run smoke:claude\n` +
      `The automated suite does not need credentials — run: npm test\n\n`,
  );
  process.exit(2);
}
const provider = new ClaudeProvider(
  {
    apiKey: cfg.apiKey, model: cfg.model, maxOutputTokens: cfg.maxOutputTokens,
    timeoutMs: cfg.timeoutMs, maxTransportRetries: cfg.maxTransportRetries,
    maxSchemaRetries: cfg.maxSchemaRetries, effort: cfg.effort, temperature: cfg.temperature,
  },
  new ProviderMetricsRecorder(),
);

let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures += 1;
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`);
};

/** Nothing internal may reach the candidate — the same rule the app enforces. */
const CANDIDATE_FORBIDDEN = [
  'strength', 'coverage_level', 'confidence_band', 'critical gate', 'criticalGate',
  'operational_reasoning', 'system prompt', 'evidence_updates', 'score',
];

async function runScenario(s: SmokeScenario): Promise<void> {
  process.stdout.write(`\n▸ ${s.name}\n`);

  const init = await provider.generate(
    'initialization',
    buildInitializationPayload({
      interviewId: `smoke_${s.id}`,
      positionTitle: s.positionTitle,
      jobDescription: s.jobDescription,
      requirements: s.requirements,
      candidateFullName: s.candidateName,
      candidateCvText: s.cv,
      constraints: { maxQuestions: 8, maxFollowUpsPerObjective: 2, maxDurationMinutes: 20 },
      limits: { maxCvChars: cfg.maxCvChars, maxJdChars: cfg.maxJdChars },
    }),
    { interviewId: `smoke_${s.id}` },
  );

  check('initialization returned a decision', init.kind === 'ok', init.errors?.join('; ') ?? '');
  if (init.kind !== 'ok') return;

  const decision = init.decision as {
    objectives: Array<{ ref: string; competency_tag: string; phase: string; target_evidence_count: number }>;
    first_question: { objective_ref: string; text: string };
    candidate_message: string;
  };
  check('InitializationDecision revalidates', validateDecision('initialization', init.decision).valid);
  check('objectives were proposed', decision.objectives.length > 0, `${decision.objectives.length}`);
  check(
    'first question maps to a proposed ref',
    decision.objectives.some((o) => o.ref === decision.first_question.objective_ref),
  );
  check('refs are the contracted local form', decision.objectives.every((o) => /^obj_\d+$/.test(o.ref)));
  check(
    'opening message leaks nothing internal',
    !CANDIDATE_FORBIDDEN.some((f) => decision.candidate_message.toLowerCase().includes(f.toLowerCase())),
  );

  // Node.js mints the canonical id — the agent never sees a ref again.
  const objective = decision.objectives[0]!;
  const canonicalId = `obj-canonical-${s.id}`;
  let question = decision.first_question.text;

  for (const [i, answer] of s.answers.entries()) {
    const turn = await provider.generate(
      'turn',
      buildTurnPayload({
        interviewId: `smoke_${s.id}`,
        currentPhase: 'COMPETENCY_DEEP_DIVE',
        currentObjective: {
          id: canonicalId,
          phase: 'COMPETENCY_DEEP_DIVE',
          competencyTag: objective.competency_tag,
          targetEvidenceCount: objective.target_evidence_count,
        },
        relevantRequirements: s.requirements,
        currentQuestion: { id: `q_${i + 1}`, text: question },
        latestAnswer: answer,
        relevantEvidence: [],
        unresolvedGaps: [],
        currentCoverage: 'PARTIALLY_COVERED',
        currentConfidenceBand: 'LOW',
        constraints: {
          questionsAskedCount: i + 1, maxQuestions: 8,
          followUpsUsedForObjective: i, maxFollowUpsPerObjective: 2,
          remainingTimeMinutes: 15, phaseBudgetStatus: 'ON_TRACK',
        },
        limits: { maxAnswerChars: cfg.maxAnswerChars },
      }),
      { interviewId: `smoke_${s.id}` },
    );

    check(`turn ${i + 1} returned a decision`, turn.kind === 'ok', turn.errors?.join('; ') ?? '');
    if (turn.kind !== 'ok') return;

    const d = turn.decision as {
      recommended_action: string;
      candidate_message: string;
      question: { text: string } | null;
      evidence_updates: Array<{ strength: string }>;
      operational_reasoning: { objective: string; evidence_gap: string };
      contradiction_status: string;
    };
    check(`turn ${i + 1} revalidates`, validateDecision('turn', turn.decision).valid);
    check(
      `turn ${i + 1} message leaks nothing internal`,
      !CANDIDATE_FORBIDDEN.some((f) => d.candidate_message.toLowerCase().includes(f.toLowerCase())),
    );
    check(
      `turn ${i + 1} question is null iff completing`,
      (d.recommended_action === 'COMPLETE_INTERVIEW') === (d.question === null),
    );
    check(
      `turn ${i + 1} reasoning stays two concise fields`,
      d.operational_reasoning.objective.length < 400 && d.operational_reasoning.evidence_gap.length < 400,
    );
    if (s.expect) s.expect(d, check);

    if (d.question === null) break;
    question = d.question.text;
  }
}

const only = process.argv[2];
const selected = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;
if (selected.length === 0) {
  process.stdout.write(`No scenario "${only}". Available: ${SCENARIOS.map((s) => s.id).join(', ')}\n`);
  process.exit(1);
}

process.stdout.write(`Claude smoke test — model ${cfg.model}, ${selected.length} scenario(s)\n`);
for (const s of selected) await runScenario(s);
process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
