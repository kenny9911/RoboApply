// backend/src/roboapply/v2/agents/RAInterviewQuestionsAgent.ts
//
// Interview Prompt Generator — STEP 5 of 5.
//
// Generates SEED questions grounded in the role requirements + the candidate's
// résumé + the strategy + the persona's tactics. Each question maps to a
// strategy phase and carries the interviewer's INTENT, the ideal SIGNAL, and a
// PROBE-IF-WEAK follow-up — so the live interviewer can adapt rather than read
// a fixed script. Also emits the candidate-facing `hint` + `coachTip` so the
// existing mock UI keeps working unchanged.
//
// Uses the configured interview model once at start; may throw (orchestrator has a fallback).

import { BaseAgent } from '../../../agents/BaseAgent.js';
import {
  type RASeedQuestion,
  type RAInterviewStrategy,
  type RAInterviewTactics,
  type RAJobRequirements,
  clip,
  interviewGenModel,
  interviewGenReasoningEffort,
  parseJsonObject,
} from '../lib/interviewGenShared.js';

export interface RAInterviewQuestionsInput {
  role: string;
  typeLabel: string;
  typeSub: string;
  persona: { name: string; role: string; style: string; difficulty: number };
  requirements: RAJobRequirements;
  strategy: RAInterviewStrategy;
  tactics: RAInterviewTactics;
  resumeContext?: string;
  count: number;
}

export class RAInterviewQuestionsAgent extends BaseAgent<
  RAInterviewQuestionsInput,
  RASeedQuestion[]
> {
  // The locale of the in-flight call, stashed in run() so parseOutput can tell
  // whether an English literal is safe to emit. This is PER-REQUEST state on
  // `this`, so the instance must NOT be shared: there is deliberately no
  // module-level singleton below — callers construct one agent per call (see
  // RAInterviewPromptService). Share one instance and two concurrent interviews
  // (one en, one zh) overwrite each other's locale between run() and
  // parseOutput, and the zh candidate gets the English literals.
  private activeLocale?: string;

  constructor() {
    super('RAInterviewQuestionsAgent');
  }

  protected getTemperature(): number {
    return 0.5;
  }

  protected getMaxTokens(): number | undefined {
    return 1800;
  }

  protected getReasoningEffort() {
    return interviewGenReasoningEffort();
  }

  /**
   * Honor the interview language over auto-detection. The auto-detect source is
   * `role + typeLabel + persona.style`, and the last two are English-only
   * raMockCatalog constants — so a Chinese-language interview reliably detected
   * as English and the candidate got English questions.
   *
   * Scope is 'content': every field here is user-facing authored text — the
   * question the interviewer asks, the candidate's `hint`, and the `coachTip`
   * shown live in the coach panel. "kind" is the one schema token and stays
   * good|careful (the 'content' clause covers that).
   */
  protected getLocaleDirective(locale: string): string | null {
    return (
      this.language.getStrictOutputLanguageDirective(locale, 'content') ??
      super.getLocaleDirective(locale)
    );
  }

  protected getAgentPrompt(): string {
    return `You are the interviewer, writing the SEED questions for a mock interview. The questions are starting points the interviewer will adapt from — not a rigid script. Ground them in the role requirements, the candidate's résumé (probe real claims on it), the strategy phases, and the persona's voice.

For EACH question return:
- "phase": which strategy phase it belongs to (use a phase name from the strategy).
- "q": the question, phrased in the persona's VOICE (1–2 sentences).
- "intent": what the interviewer is trying to learn (internal note).
- "idealSignal": what a strong answer reveals.
- "probeIfWeak": the follow-up to use if the answer is vague/weak (a concrete probing move).
- "hint": a short tactical tip to the CANDIDATE on how to answer well (coaching them).
- "coachTip": { "kind": "good" | "careful", "text": "one-line live nudge" } — "careful" for a trap, "good" for an opportunity.

Rules:
- Mix résumé-specific questions (reference a real line from their résumé) with role-requirement questions.
- Match the interview TYPE (behavioral = STAR/conflict/ownership; technical = data structures/coding/tradeoffs; system = architecture/scale; case = open product/strategy; culture = values/motivation; panel = rapid mix).
- Order questions to follow the strategy's phase arc.
- Stay fully in the persona's voice + difficulty.

Return STRICT JSON only (no prose, no code fences):
{ "questions": [ { "phase": "...", "q": "...", "intent": "...", "idealSignal": "...", "probeIfWeak": "...", "hint": "...", "coachTip": { "kind": "good", "text": "..." } }, ... ] }`;
  }

  protected formatInput(input: RAInterviewQuestionsInput, locale?: string): string {
    const r = input.requirements;
    const parts: string[] = [];
    // Restate the language in the user message too — the persona/type blocks
    // are English catalog constants and the résumé is often English.
    const languageLine = this.outputLanguageReminder(locale);
    if (languageLine) parts.push(languageLine);
    parts.push(
      `## Persona\n${clip(input.persona.name, 80)} — ${clip(input.persona.role, 120)} (difficulty ${input.persona.difficulty}/3)\nStyle: ${clip(input.persona.style, 200)}`,
    );
    parts.push(
      `## Interview\nRole: ${clip(input.role, 160) || '(unspecified)'}\nType: ${clip(input.typeLabel, 80)} — ${clip(input.typeSub, 200)}`,
    );
    parts.push(
      `## Requirements\nMust-have: ${r.mustHaveSkills.join('; ')}\nResponsibilities: ${r.coreResponsibilities.join('; ')}\nSuccess signals: ${r.successSignals.join('; ')}\nFocus: ${r.commonInterviewFocus.join('; ')}`,
    );
    parts.push(
      `## Strategy phases\n${input.strategy.phases.map((ph) => `${ph.name} (${ph.minutes}m): ${ph.goal}`).join('\n')}`,
    );
    parts.push(`## Probing tactics to weave in\n${input.tactics.probingTactics.join('; ')}`);
    if (input.resumeContext) {
      parts.push(`## Candidate résumé (probe real claims here)\n${clip(input.resumeContext, 2200)}`);
    }
    const count = Math.max(4, Math.min(input.count, 10));
    parts.push(`Generate exactly ${count} seed questions ordered by phase. Output ONLY {"questions": [...]}.`);
    return parts.join('\n\n');
  }

  /**
   * An English literal is only a sane default when the output language IS
   * English. For a zh/ja/ko interview a hardcoded English hint is worse than no
   * hint at all — the coach panel tolerates an empty string, the candidate does
   * not tolerate a language switch mid-interview. Unknown/absent locale keeps
   * the English literal, which is the pre-existing behaviour.
   */
  private localeSafeDefault(englishText: string): string {
    const language = this.activeLocale
      ? this.language.getLanguageFromLocale(this.activeLocale)
      : null;
    return language && language !== 'English' ? '' : englishText;
  }

  protected parseOutput(response: string): RASeedQuestion[] {
    const p = parseJsonObject(response);
    const raw = Array.isArray(p.questions) ? p.questions : [];
    const out: RASeedQuestion[] = [];
    for (const row of raw) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const q = clip(r.q, 800);
      if (!q) continue;
      const tip = r.coachTip && typeof r.coachTip === 'object' ? (r.coachTip as Record<string, unknown>) : {};
      out.push({
        phase: clip(r.phase, 80) || 'Core',
        q,
        intent: clip(r.intent, 300),
        idealSignal: clip(r.idealSignal, 300),
        probeIfWeak: clip(r.probeIfWeak, 400),
        hint: clip(r.hint, 400) || this.localeSafeDefault('Lead with a concrete example.'),
        coachTip: {
          kind: tip.kind === 'careful' ? 'careful' : 'good',
          text: clip(tip.text, 300) || this.localeSafeDefault('Be specific — concrete beats abstract.'),
        },
      });
      if (out.length >= 10) break;
    }
    return out;
  }

  async run(
    input: RAInterviewQuestionsInput,
    options: { requestId?: string; locale?: string; signal?: AbortSignal } = {},
  ): Promise<RASeedQuestion[]> {
    this.activeLocale = options.locale;
    return this.execute(
      input,
      `${input.role} ${input.typeLabel} ${input.persona.style}`,
      options.requestId,
      options.locale,
      interviewGenModel(),
      options.signal,
    );
  }
}

// No module-level singleton on purpose — this agent carries per-request state
// (`activeLocale`). Construct one per call, the way RAMockService constructs
// RAMockInterviewerAgent.
export default RAInterviewQuestionsAgent;
