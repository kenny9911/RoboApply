// backend/src/roboapply/v2/agents/RAOnboardingResumeSeedAgent.ts
//
// The LLM half of the resume seed. It exists to fill exactly two gaps the
// deterministic pass (lib/raResumeSeed.ts) cannot close:
//
//   1. `industriesTarget` — the taxonomy is a closed 19-item list and mapping
//      "Stripe, Adyen, a small payments startup" onto "Fintech" is a judgment
//      call, not a lookup.
//   2. `targetRoles` — ONLY when the deterministic pass found none. A resume
//      with no structured `experience[]` (a scanned PDF, a one-page portfolio,
//      a career changer's narrative CV) still contains role evidence in prose.
//
// It contributes nothing else. Not salary, not locations, not seniority, not
// work modes — those are either never inferred (salary, D7) or already correct
// deterministically, and a model that is allowed to touch them will.
//
// TIMING IS THE CONTRACT. This agent runs in PARALLEL with the bootstrap write
// and NEVER blocks the response. If it is slow, if it fails, if the model is
// down — step 2 is already on screen and already correct, because the
// deterministic seed produced it in single-digit milliseconds. What this agent
// adds is an improvement, never a dependency. The orchestrator awaits it with
// `Promise.allSettled` past a deadline and persists whatever landed.
//
// It reuses `normalizeDraftUpdates` + the false-clear guard from the extractor
// verbatim, including the protected-attributes rule — which matters MORE here
// than on the chat path, because a resume carries graduation years, sometimes
// a photo reference, sometimes nationality, and the model is being handed all
// of it at once.

import { BaseAgent } from '../../../agents/BaseAgent.js';
import { RA_MODEL_HAIKU } from './raModels.js';
import { clip, parseJsonObject } from '../lib/interviewGenShared.js';
import { normalizeDraftUpdates } from '../lib/raOnboardingDraft.js';
import { RA_PREFERENCE_OPTIONS } from '../services/RAPreferencesService.js';
import type {
  OnboardingDraftPreferences,
  OnboardingResumeSeedInput,
  OnboardingResumeSeedOutput,
} from '../types/onboarding.js';

export const RA_ONBOARDING_SEED_MODEL = RA_MODEL_HAIKU;
const ENV_MODEL = 'RA_V2_ONBOARDING_SEED_MODEL';

export function pickOnboardingSeedModel(): string {
  return process.env[ENV_MODEL]?.trim() || RA_ONBOARDING_SEED_MODEL;
}

/** The only fields this agent is permitted to contribute. Anything else the
 *  model emits is discarded by the parser, not by the prompt — prompts are
 *  guidance, parsers are enforcement. */
const ALLOWED_FIELDS = ['industriesTarget', 'targetRoles'] as const;

export function emptySeedOutput(): OnboardingResumeSeedOutput {
  return { updates: {}, fieldConfidence: {} };
}

export class RAOnboardingResumeSeedAgent extends BaseAgent<
  OnboardingResumeSeedInput,
  OnboardingResumeSeedOutput
> {
  constructor() {
    super('RAOnboardingResumeSeedAgent');
  }

  protected getTemperature(): number {
    // A classification over a closed list. Nothing here benefits from variety.
    return 0.1;
  }

  protected getMaxTokens(): number | undefined {
    // Two short arrays and a confidence map.
    return 700;
  }

  protected getLocaleDirective(locale: string): string | null {
    // Scope is 'content', not 'analysis': `targetRoles` is resume CONTENT this
    // agent authors — job titles that land in the user's stored preferences and
    // are rendered back to them. Under 'analysis' the model reads the resume as
    // an *input* it is commenting on and mirrors the resume's language, so a zh
    // user with an English CV got English target roles stored against a Chinese
    // UI. The 'content' scope's schema clause still pins `industriesTarget` —
    // those tokens are enumerated verbatim in the prompt and matched against
    // RA_PREFERENCE_OPTIONS, so translating one silently drops the field in
    // normalizeDraftUpdates.
    return (
      this.language.getStrictOutputLanguageDirective(locale, 'content') ??
      super.getLocaleDirective(locale)
    );
  }

  protected getAgentPrompt(): string {
    const industryOptions = RA_PREFERENCE_OPTIONS.industries.join(' | ');

    return `You read one person's resume and propose where they should look NEXT. You
write no prose. You never address the reader.

The system has already extracted job titles, employment types, years and city
deterministically. You fill only the gaps it cannot:

1. industriesTarget — which of the canonical industries below their employers
   and products belong to. Judge by what the COMPANIES do, not by the person's
   job function: a backend engineer at three payment companies is Fintech, not
   "Developer tools". Emit at most 3, most-represented first. If the employers
   span unrelated sectors with no pattern, emit nothing — a wrong industry is
   worse than no industry, because it becomes a stored preference.

2. targetRoles — ONLY when DETERMINISTIC_ROLES is empty. Then read the prose
   for what this person actually does and emit 1-3 plain job titles as an
   employer in the output language would post them — the contrast between
   "Product Designer" and "Design Visionary" shows the register to hit (a title
   a job board would list, not a self-description), not the language to use. If
   DETERMINISTIC_ROLES is non-empty, omit targetRoles entirely; the structured
   parse already won and your version would only fight it.

CANONICAL INDUSTRIES (the only legal values for industriesTarget; map onto the
closest entry and emit the token exactly as written; if nothing is genuinely
close, omit the field):
${industryOptions}

HARD RULES
- Emit ONLY the two keys above. Never salary, locations, workModes, seniority,
  employmentTypes, companyStages, companySizes, mustHaves or dealbreakers —
  the system fills those itself or deliberately leaves them empty.
- A resume records the PAST. You are proposing a FUTURE. Where the two clearly
  diverge (a decade in one sector then a bootcamp certificate in another), the
  most recent evidence wins.
- Never emit an empty array as a placeholder. Omit the key instead.

PROTECTED ATTRIBUTES — age, graduation year, gender, marital or family status,
pregnancy, religion, ethnicity, nationality, disability, photo:
- A resume carries these. Never record them, never let them shape a value you
  emit, and never infer seniority or "fit" from them.

"fieldConfidence": one entry per key you emit, 0-1. Industries read from three
or more employers in the same sector → 0.7-0.8. A single employer or an
indirect signal → 0.4-0.6. Roles recovered from prose → 0.5.

Schema:
{"updates": {"industriesTarget": ["..."], "targetRoles": ["..."]}, "fieldConfidence": {"industriesTarget": 0.0}}

EXAMPLE
PARSED_RESUME: {"experience":[{"role":"Backend Engineer","company":"Adyen"},{"role":"Backend Engineer","company":"Klarna"}]}
DETERMINISTIC_ROLES: ["Backend Engineer"]
OUTPUT: {"updates":{"industriesTarget":["Fintech"]},"fieldConfidence":{"industriesTarget":0.8}}
(Two payments employers → Fintech. targetRoles omitted: the structured parse
already found one.)

Output ONLY the JSON object. No prose, no fences.`;
  }

  protected formatInput(input: OnboardingResumeSeedInput): string {
    return [
      `PARSED_RESUME: ${clip(input.parsedJson, 6000)}`,
      `RESUME_MARKDOWN: ${clip(input.resumeMarkdown, 1200)}`,
      `DETERMINISTIC_ROLES: ${JSON.stringify(input.deterministicRoles.slice(0, 3))}`,
    ].join('\n');
  }

  protected parseOutput(response: string): OnboardingResumeSeedOutput {
    const obj = parseJsonObject(response);
    if (Object.keys(obj).length === 0) return emptySeedOutput();

    const normalized = normalizeDraftUpdates(obj.updates);

    // Enforcement, not persuasion: keep only the two sanctioned keys, and drop
    // a key that normalized to [] from a non-empty raw value (the taxonomy ate
    // every value — that is a bad extraction, not an explicit "clear").
    const rawUpdates =
      obj.updates && typeof obj.updates === 'object' && !Array.isArray(obj.updates)
        ? (obj.updates as Record<string, unknown>)
        : {};
    const updates: OnboardingDraftPreferences = {};
    for (const field of ALLOWED_FIELDS) {
      const value = normalized[field];
      if (!Array.isArray(value) || value.length === 0) continue;
      if (!Array.isArray(rawUpdates[field])) continue;
      updates[field] = value;
    }

    const rawConfidence =
      obj.fieldConfidence && typeof obj.fieldConfidence === 'object'
        ? (obj.fieldConfidence as Record<string, unknown>)
        : {};
    const fieldConfidence: Record<string, number> = {};
    for (const key of Object.keys(updates)) {
      const value = rawConfidence[key];
      // Default 0.6, NOT 1: everything this agent produces is an inference
      // about someone's future from a record of their past. The client renders
      // it with the "inferred" marker, which requires the number to be honest.
      fieldConfidence[key] =
        typeof value === 'number' && Number.isFinite(value)
          ? Math.max(0, Math.min(1, value))
          : 0.6;
    }

    return { updates, fieldConfidence };
  }

  /** The orchestrator calls this inside `Promise.allSettled` past a deadline;
   *  a throw, a timeout and an empty result are all the same outcome — the
   *  screen the user already has. */
  async run(
    input: OnboardingResumeSeedInput,
    options: { requestId?: string; locale?: string; signal?: AbortSignal } = {},
  ): Promise<OnboardingResumeSeedOutput> {
    return this.execute(
      input,
      input.resumeMarkdown || input.parsedJson,
      options.requestId,
      options.locale,
      pickOnboardingSeedModel(),
      options.signal,
    );
  }
}

export const raOnboardingResumeSeedAgent = new RAOnboardingResumeSeedAgent();
export default raOnboardingResumeSeedAgent;

export const __test = {
  pickOnboardingSeedModel,
  emptySeedOutput,
  ALLOWED_FIELDS,
};
