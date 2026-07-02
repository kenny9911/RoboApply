// backend/src/roboapply/v2/agents/RAInterviewJobRequirementsAgent.ts
//
// Interview Prompt Generator — STEP 1 of 5.
//
// Synthesizes a PRACTICAL requirements profile for the target role, grounded
// in live web evidence (Tavily, passed in by the orchestrator) plus the
// candidate's résumé. Output is the foundation the strategy / tactics /
// questions agents build on.
//
// Sonnet-tier (env RA_V2_INTERVIEW_GEN_MODEL). Runs ONCE at "Start interview".
// On any failure the orchestrator substitutes a heuristic fallback, so this
// agent may throw freely.

import { BaseAgent } from '../../../agents/BaseAgent.js';
import {
  type RAJobRequirements,
  asStringArray,
  clip,
  interviewGenModel,
  parseJsonObject,
} from '../lib/interviewGenShared.js';

export interface RAJobRequirementsInput {
  /** Target role / job title the candidate is interviewing for. */
  role: string;
  /** Interview type label + sub (behavioral / technical / system / …). */
  typeLabel: string;
  typeSub: string;
  /** Optional seniority hint derived from the persona/role. */
  seniorityHint?: string;
  /** Compact résumé context (summary or first ~1.5k chars of markdown). */
  resumeContext?: string;
  /** Flattened Tavily evidence block (may be empty when search is off). */
  webEvidence?: string;
}

export class RAInterviewJobRequirementsAgent extends BaseAgent<
  RAJobRequirementsInput,
  RAJobRequirements
> {
  constructor() {
    super('RAInterviewJobRequirementsAgent');
  }

  protected getTemperature(): number {
    return 0.3; // grounded + practical, low variance
  }

  protected getMaxTokens(): number | undefined {
    return 1100;
  }

  protected getAgentPrompt(): string {
    return `You are a senior technical recruiter and hiring-panel designer. Given a target ROLE, the interview TYPE, optional live web research, and the candidate's résumé context, produce a PRACTICAL, role-specific requirements profile that a real hiring team would use to structure an interview.

Rules:
- Be concrete and role-specific. NO generic filler ("good communication", "team player") unless it is genuinely a top signal for THIS role.
- Prefer the WEB RESEARCH for current, market-accurate expectations (tools, frameworks, seniority bar). If research is absent, use well-known industry norms for the role.
- Use the résumé only to calibrate seniority/domain — do NOT tailor requirements to flatter the candidate.
- Keep each list tight (3–7 items), each item a short noun phrase or one line.

Return STRICT JSON only (no prose, no code fences):
{
  "roleSummary": "1–2 sentences: what this role really does and what the bar is",
  "seniorityBar": "the level expected (e.g. 'Senior IC: owns ambiguous projects end-to-end')",
  "mustHaveSkills": ["..."],
  "niceToHaveSkills": ["..."],
  "coreResponsibilities": ["..."],
  "successSignals": ["what a strong candidate demonstrates"],
  "commonInterviewFocus": ["what interviewers for this role typically probe hardest"],
  "domainContext": "1–2 sentences of current market / domain context (cite the gist of the research if present)"
}`;
  }

  protected formatInput(input: RAJobRequirementsInput): string {
    const parts: string[] = [];
    parts.push(`## Target role\n${clip(input.role, 160) || '(unspecified role)'}`);
    parts.push(`## Interview type\n${clip(input.typeLabel, 80)} — ${clip(input.typeSub, 200)}`);
    if (input.seniorityHint) parts.push(`## Seniority hint\n${clip(input.seniorityHint, 160)}`);
    if (input.resumeContext) {
      parts.push(`## Candidate résumé context (for seniority/domain calibration only)\n${clip(input.resumeContext, 1800)}`);
    }
    if (input.webEvidence) {
      parts.push(`## Live web research (Tavily)\n${clip(input.webEvidence, 2400)}`);
    } else {
      parts.push('## Live web research\n(none available — use industry norms for the role)');
    }
    parts.push('Output ONLY the JSON object described above.');
    return parts.join('\n\n');
  }

  protected parseOutput(response: string): RAJobRequirements {
    const p = parseJsonObject(response);
    return {
      roleSummary: clip(p.roleSummary, 600),
      seniorityBar: clip(p.seniorityBar, 300),
      mustHaveSkills: asStringArray(p.mustHaveSkills, 8, 120),
      niceToHaveSkills: asStringArray(p.niceToHaveSkills, 8, 120),
      coreResponsibilities: asStringArray(p.coreResponsibilities, 8, 160),
      successSignals: asStringArray(p.successSignals, 8, 200),
      commonInterviewFocus: asStringArray(p.commonInterviewFocus, 8, 160),
      domainContext: clip(p.domainContext, 600),
    };
  }

  async run(
    input: RAJobRequirementsInput,
    options: { requestId?: string; locale?: string; signal?: AbortSignal } = {},
  ): Promise<RAJobRequirements> {
    return this.execute(
      input,
      `${input.role} ${input.typeLabel}`,
      options.requestId,
      options.locale,
      interviewGenModel(),
      options.signal,
    );
  }
}

export const raInterviewJobRequirementsAgent = new RAInterviewJobRequirementsAgent();
export default raInterviewJobRequirementsAgent;
