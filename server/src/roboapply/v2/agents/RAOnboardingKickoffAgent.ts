// backend/src/roboapply/v2/agents/RAOnboardingKickoffAgent.ts
//
// Onboarding-chat Agent #1 — read one resume variant at POST /onboarding/
// bootstrap and produce the three judgment artifacts that start the
// conversation: a candidate headline, an opening message in the candidate's
// own voice, and 3-4 resume-grounded suggestion chips. Per the production
// prompt pack §1 (docs/roboapply-onboarding-prompt-pack.md) with fix R9
// applied: the kickoff ALSO emits per-topic suggested-answer chips
// (`topicSuggestions`) so the deterministic per-turn chip composer can keep
// offering resume-grounded, sendable answers after turn 0 instead of
// collapsing into generic catalog labels.
//
// Notes:
//   - Sonnet tier, temperature 0.4, maxTokens 700; runs ONCE per bootstrap
//   - The 5-6 ingest rows are deterministic (raOnboardingIngestRows.ts) —
//     this agent does NOT produce them
//   - parseOutput never throws; the orchestrator falls back to the catalog
//     genericOpeningPrompt/genericChips when the sanitized output is unusable
//     (empty headline/openingPrompt or fewer than 3 surviving chips)
//   - Locale: BaseAgent prepends getLanguageInstructionFromLocale via the
//     default getLocaleDirective seam (prose-bearing JSON — no enum carve-out
//     needed). Do NOT embed a second directive in the prompt body.

import { BaseAgent } from '../../../agents/BaseAgent.js';
import { RA_MODEL_SONNET } from './raModels.js';
import { asStringArray, clip, parseJsonObject } from '../lib/interviewGenShared.js';
import type { OnboardingKickoffInput, OnboardingKickoffOutput } from '../types/onboarding.js';

// ─── Public types ───────────────────────────────────────────────────────

/**
 * Topics the kickoff pre-answers (fix R9). Keys are the chip composer's
 * vocabulary: `workMode`/`salary`/`employmentType` line up 1:1 with
 * `OnboardingTopic`; `roles` and `industries` map to the composer's
 * targetRoles / `industry` topics respectively.
 */
export type OnboardingTopicSuggestionKey =
  | 'roles'
  | 'workMode'
  | 'salary'
  | 'industries'
  | 'employmentType';

export const TOPIC_SUGGESTION_KEYS: readonly OnboardingTopicSuggestionKey[] = [
  'roles',
  'workMode',
  'salary',
  'industries',
  'employmentType',
];

/** Kickoff output = the wire shape + the R9 per-topic suggestion cache. */
export interface RAOnboardingKickoffOutput extends OnboardingKickoffOutput {
  /** One sendable, resume-grounded answer per elicitation topic (≤60 chars
   *  each); keys without grounding are omitted. Cached on the session and
   *  consumed by the deterministic per-turn chip composer. */
  topicSuggestions: Partial<Record<OnboardingTopicSuggestionKey, string>>;
}

// Default model. Exported so the orchestrator / tests can reference the
// default without reaching into the agent's internals.
export const RA_ONBOARDING_KICKOFF_MODEL = RA_MODEL_SONNET;

// Env var that overrides the model at runtime.
const ENV_MODEL = 'RA_V2_ONBOARDING_KICKOFF_MODEL';

/**
 * Resolve the kickoff model. Reads `process.env` at CALL TIME (not
 * module-load) so it picks up dotenv values regardless of ESM import order.
 */
export function pickOnboardingKickoffModel(): string {
  return process.env[ENV_MODEL]?.trim() || RA_ONBOARDING_KICKOFF_MODEL;
}

// ─── Output limits (pack §1.3 clamps) ───────────────────────────────────

const MAX_HEADLINE_LEN = 80;
const MAX_OPENING_PROMPT_LEN = 220;
const MAX_CHIP_LEN = 60;
const MAX_CHIPS = 4;
/** Below this many surviving chips the orchestrator must use the catalog
 *  fallback (pack §1.3: "<3 surviving chips = failure"). */
export const MIN_USABLE_CHIPS = 3;

/** True when a sanitized kickoff output is good enough to show; otherwise
 *  the orchestrator substitutes the raOnboardingMessages catalog fallback. */
export function isUsableKickoffOutput(out: RAOnboardingKickoffOutput): boolean {
  return (
    out.candidateHeadline.length > 0 &&
    out.openingPrompt.length > 0 &&
    out.chips.length >= MIN_USABLE_CHIPS
  );
}

// ─── Agent ──────────────────────────────────────────────────────────────

export class RAOnboardingKickoffAgent extends BaseAgent<
  OnboardingKickoffInput,
  RAOnboardingKickoffOutput
> {
  constructor() {
    super('RAOnboardingKickoffAgent');
  }

  protected getTemperature(): number {
    // Judgment with personality, but no flights of fancy (pack §1).
    return 0.4;
  }

  protected getMaxTokens(): number | undefined {
    // Headline + opener + ≤4 chips + ≤5 topic suggestions is small.
    return 700;
  }

  // Prompt pack §1.2 verbatim, with: the {{LANGUAGE_DIRECTIVE}} slot removed
  // (BaseAgent.buildSystemPrompt prepends the real directive), the INPUT
  // trailer moved to formatInput(), and the R9 "topicSuggestions" field added
  // to OUTPUT FIELDS + the example + the schema.
  protected getAgentPrompt(): string {
    return `You are the kickoff analyst for RoboApply, a job-search assistant for candidates.
You read one resume and produce exactly four artifacts that start a job-search
conversation: a headline, an opening message written in the candidate's own voice,
3-4 tappable suggestion chips, and one suggested answer per onboarding topic.

You will receive:
- VARIANT_NAME: the resume's display name.
- RETURNING: "true" if this user completed onboarding before and is re-running it.
- STORED_PREFS_DIGEST: (only when RETURNING=true) a short digest of their previously
  saved preferences.
- SUMMARY: an AI-generated highlight of the resume (may be empty).
- RESUME: the resume content in markdown (may be truncated).

HOW TO READ THE RESUME (in priority order):
1. Most recent role and company — this anchors everything. Weight the last 2 years
   far above earlier history.
2. Trajectory: is scope growing toward deeper individual-contributor work or toward
   leading people? A "Senior X" with mentoring bullets hints at a lead/staff step.
3. Domain thread: the subject matter that persists across jobs (e.g. payments,
   e-commerce logistics, B2B SaaS, healthcare data). Name it specifically.
4. Tenure and seniority: total years in the discipline; do not inflate ("8 years"
   only if the dates support it).
5. PIVOT SIGNALS: recent certifications, side projects, or a summary section that
   points somewhere the job history does not. If the resume signals a career
   change, the headline names the DIRECTION ("Backend engineer pivoting toward
   data engineering"), never just the old identity.
6. Location and work-mode hints: city in the header, remote roles in history.

OUTPUT FIELDS:

"candidateHeadline" — max 80 characters. Third person, no name. The one-line skim a
recruiter would form: discipline + seniority + domain thread + a differentiator if
one is obvious. Example: "Senior backend engineer, ~8 yrs, payments systems at scale".

"openingPrompt" — max 220 characters. FIRST PERSON, written exactly as this candidate
would plausibly type it into a chat to start a job search. Requirements:
- State who they are (role + years or seniority + domain) and the natural next step
  their trajectory points to.
- Include a location or work-mode angle ONLY if the resume itself supports it
  (header city, history of remote roles). Never invent salary, industries, or
  preferences the resume does not evidence.
- Sound like a person typing, not a resume. No buzzwords ("results-driven",
  "passionate"), no third person, no markdown.
- It must be sendable as-is: complete, self-contained, ending with what they want.

"chips" — array of 3-4 strings, each max 60 characters. Each chip is a COMPLETE
message the candidate could send, not a topic label. Each must cite something
concrete from this resume — a role, a domain, a location, a skill. Cover different
intents across the set:
  1. The continuation: the obvious next role in their arc, with a concrete qualifier
     ("Find senior backend roles in fintech, Taipei or remote").
  2. The step-up or transition the resume hints at ("I want to move from senior IC
     to a tech-lead role").
  3. The constraint-led ask ("Remote-only roles — I don't want to relocate from
     Kaohsiung").
  4. The pivot or exploration grounded in a real secondary signal ("Could my
     payments experience transfer to crypto/web3 companies?").
DIVERSITY RULE: at most ONE chip in the set may be a constraint/work-style chip;
every other chip must reference a DISTINCT facet of the candidate's craft, domain,
or trajectory. Four rephrasings of the same idea is a failure. Never produce a
generic chip ("Find me a job", "Help with my career"). If the resume cannot
support 4 grounded chips, return 3 rather than padding with a generic one.

"topicSuggestions" — object with up to five keys, exactly: "roles", "workMode",
"salary", "industries", "employmentType". Each value is ONE complete, sendable
answer (max 60 characters) the candidate could tap LATER in the conversation,
when the assistant asks about that topic — first person, in their voice,
grounded in this resume the same way the chips are. These are SUGGESTED answers
the candidate chooses to send, so each should be the most plausible stance
their resume supports:
- roles: the natural next-role answer ("Senior backend or tech-lead roles").
- workMode: a work-mode stance the resume supports ("Remote, or hybrid in Taipei").
- salary: NEVER invent a number — suggest a market-rate question grounded in
  their role/city ("What's typical for senior backend in Taipei?") or a skip
  ("I'd rather skip salary for now").
- industries: the 1-2 industries their history points to ("Fintech, or
  payments-adjacent teams").
- employmentType: the type their history suggests ("Full-time, like my last roles").
Omit any key the resume gives you no grounding for — never pad with a generic
answer.

EXAMPLE (en input → output, study the register and grounding):
Resume digest: Senior Backend Engineer @ Tappay (Taipei), 8 yrs total, payment
gateway, Go/PostgreSQL/Kubernetes, mentors 2 juniors; earlier e-commerce startups.
OUTPUT:
{"candidateHeadline": "Senior backend engineer, ~8 yrs, payments infrastructure in Taipei",
 "openingPrompt": "I'm a backend engineer with 8 years building payment systems, most recently at Tappay in Taipei. Looking for a senior or lead role — Taipei-based or remote.",
 "chips": ["Find senior backend roles at fintech companies in Taipei",
           "I want to step up from senior IC to tech lead",
           "Remote-only backend roles where my Go and Kubernetes fit",
           "Would payments experience transfer well into crypto exchanges?"],
 "topicSuggestions": {"roles": "Senior backend or tech-lead roles",
                      "workMode": "Taipei-based or fully remote",
                      "salary": "What's typical for senior backend in Taipei?",
                      "industries": "Fintech and payments companies",
                      "employmentType": "Full-time, like my past roles"}}
Note: every noun is traceable to the resume; one constraint chip only; four
distinct facets (role+place, trajectory, constraint+stack, pivot); the salary
suggestion asks about the market instead of inventing a number.

IF RETURNING=true: the user has saved preferences already (see STORED_PREFS_DIGEST).
- "openingPrompt" becomes an update-style message ("Still looking for senior backend
  roles, but I'd consider hybrid in Taipei now").
- Chips become update actions grounded in the stored preferences: refresh matches,
  change one stored constraint (salary, work mode, location), or explore a new
  direction the resume supports.

IF THE RESUME IS SPARSE (few roles, no dates, mostly empty): do not fabricate. Build
the headline from whatever is real (or from VARIANT_NAME), make the openingPrompt a
short honest statement of the strongest available fact plus an open ask, and return
exactly 3 broader-but-still-grounded chips (chips that invite elaboration — "Help me
figure out what roles fit my background" — are acceptable here). Omit topicSuggestions
keys you cannot ground.

HARD RULES:
- Every factual claim in every field must be traceable to SUMMARY or RESUME
  (or STORED_PREFS_DIGEST when returning). No invented employers, numbers, years,
  salaries, or locations.
- All four fields are user-visible text and must follow the language directive above.
- Output schema:
{"candidateHeadline": "...", "openingPrompt": "...", "chips": ["...", "..."], "topicSuggestions": {"roles": "...", "workMode": "...", "salary": "...", "industries": "...", "employmentType": "..."}}

Output ONLY the JSON object. No prose, no fences, no trailing newline noise.`;
  }

  protected formatInput(input: OnboardingKickoffInput): string {
    // Clips per pack §1.2: RESUME 2400 (loadResumeContext pattern), SUMMARY
    // 600, STORED_PREFS_DIGEST 400, VARIANT_NAME 80.
    return [
      `VARIANT_NAME: ${clip(input.variantName, 80)}`,
      `RETURNING: ${input.returning ? 'true' : 'false'}`,
      `STORED_PREFS_DIGEST: ${clip(input.storedPrefsDigest ?? '', 400) || '(none)'}`,
      `SUMMARY: ${clip(input.summary ?? '', 600) || '(none)'}`,
      `RESUME:\n${clip(input.resumeMarkdown, 2400)}`,
    ].join('\n');
  }

  protected parseOutput(response: string): RAOnboardingKickoffOutput {
    const obj = parseJsonObject(response);

    const topicSuggestions: RAOnboardingKickoffOutput['topicSuggestions'] = {};
    const rawSuggestions = obj.topicSuggestions;
    if (
      rawSuggestions &&
      typeof rawSuggestions === 'object' &&
      !Array.isArray(rawSuggestions)
    ) {
      for (const key of TOPIC_SUGGESTION_KEYS) {
        const value = clip((rawSuggestions as Record<string, unknown>)[key], MAX_CHIP_LEN);
        if (value) topicSuggestions[key] = value;
      }
    }

    return {
      candidateHeadline: clip(obj.candidateHeadline, MAX_HEADLINE_LEN),
      openingPrompt: clip(obj.openingPrompt, MAX_OPENING_PROMPT_LEN),
      chips: asStringArray(obj.chips, MAX_CHIPS, MAX_CHIP_LEN),
      topicSuggestions,
    };
  }

  /**
   * Public wrapper. The orchestrator calls this inside a try/catch and falls
   * back to the catalog when it throws OR when `isUsableKickoffOutput` is
   * false. Failures cost nothing (no deduction is written for bootstrap).
   */
  async run(
    input: OnboardingKickoffInput,
    options: { requestId?: string; locale?: string; signal?: AbortSignal } = {},
  ): Promise<RAOnboardingKickoffOutput> {
    return this.execute(
      input,
      input.resumeMarkdown, // language auto-detect fallback when locale is unknown
      options.requestId,
      options.locale,
      pickOnboardingKickoffModel(),
      options.signal,
    );
  }
}

export const raOnboardingKickoffAgent = new RAOnboardingKickoffAgent();
export default raOnboardingKickoffAgent;

// Test surface — keep tight.
export const __test = {
  pickOnboardingKickoffModel,
  isUsableKickoffOutput,
};
