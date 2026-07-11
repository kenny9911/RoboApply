// backend/src/roboapply/v2/agents/RACrossBankExplorerAgent.ts
//
// Opportunity Explorer — the coverage agent. Turns the candidate's headline +
// resume-derived titles/skills + draft prefs into an expansion plan of
// primary + adjacent + transferable-skill-stretch titles plus a normalized
// tag/keyword vocabulary used as both banks' OR-union net. Haiku, cheap, wide.
//
// Contract (spec §3.2): the ONLY component allowed to broaden beyond the stated
// target. Internal tokens ALWAYS English/ASCII (CJK matches nothing in the
// normalized corpus). Never invents unrelated roles; every stretch shares ≥1
// transferable skill tag. parseOutput NEVER throws — run() back-fills from a
// deterministic fallback.

import { BaseAgent } from '../../../agents/BaseAgent.js';
import { RA_MODEL_HAIKU } from './raModels.js';
import { dedupeStrings } from '../lib/raCrossBankMatch.js';
import type {
  CrossBankExplorerInput,
  CrossBankExplorerPlan,
} from '../types/crossBank.js';

const ENV_MODEL = 'RA_V2_CROSSBANK_EXPLORER_MODEL';

export function pickCrossBankExplorerModel(): string {
  return process.env[ENV_MODEL]?.trim() || RA_MODEL_HAIKU;
}

function strArr(v: unknown, maxLen: number, maxItems: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const t = x.trim();
    if (!t) continue;
    out.push(t.slice(0, maxLen));
    if (out.length >= maxItems) break;
  }
  return out;
}

/** Deterministic plan when the LLM is unavailable or returns junk. */
export function buildExplorerFallback(
  input: Pick<CrossBankExplorerInput, 'currentTitles' | 'topSkills' | 'draft' | 'seniority'>,
): CrossBankExplorerPlan {
  const targetRoles = input.draft.targetRoles ?? [];
  const primaryTitles = dedupeStrings([...targetRoles, ...input.currentTitles]).slice(0, 4);
  return {
    primaryTitles: primaryTitles.length ? primaryTitles : ['Software Engineer'],
    adjacentTitles: [],
    stretchTitles: [],
    transferableSkillTags: dedupeStrings(input.topSkills).slice(0, 20),
    mustKeywords: dedupeStrings(input.topSkills).slice(0, 15),
    niceKeywords: [],
    seniorityBands: input.seniority !== 'unknown' ? [input.seniority] : [],
    rationale: 'Deterministic fallback plan (explorer unavailable).',
  };
}

export class RACrossBankExplorerAgent extends BaseAgent<
  CrossBankExplorerInput,
  CrossBankExplorerPlan
> {
  constructor() {
    super('RACrossBankExplorerAgent');
  }

  protected getTemperature(): number {
    return 0.3;
  }

  protected getMaxTokens(): number | undefined {
    return 700; // CJK headroom for the tag/keyword arrays
  }

  protected getResponseFormat(): 'json_object' | undefined {
    return 'json_object';
  }

  // Internal query is English/ASCII; the prompt owns per-field language.
  protected getLocaleDirective(): string | null {
    return null;
  }

  protected getAgentPrompt(): string {
    return `You are RoboApply's opportunity explorer. Your job is COVERAGE: given a
candidate, produce a search expansion plan that surfaces every viable job across
two recruiter job banks — including adjacent roles and transferable-skill
stretches the candidate would never search for themselves — WITHOUT drifting
into unrelated work.

## Hard rules
1. Output ALL title/keyword/tag tokens in ENGLISH, lowercase where natural. The
   job corpus is English-normalized; non-English tokens match nothing.
2. primaryTitles ALWAYS include the candidate's stated target role(s) and current
   title(s). Never narrow below the stated target.
3. adjacentTitles: roles a recruiter would consider this candidate for (same
   discipline, ±1 seniority, or a natural pivot). stretchTitles: transferable
   reaches. EVERY stretch/adjacent must share ≥1 transferableSkillTag with the
   candidate — never invent unrelated roles.
4. transferableSkillTags: the concrete skills/domains that justify the adjacency.
   Emit BOTH a bare form (e.g. "python", "kubernetes") AND, where natural, a
   namespaced form (e.g. "lang:python", "skill:kubernetes"). Only skills the
   candidate actually has.
5. mustKeywords: core hard skills/tools to match in job text. niceKeywords:
   bonus signals. Keep verbatim technical terms.
6. Caps: primaryTitles ≤4, adjacentTitles ≤6, stretchTitles ≤4,
   transferableSkillTags ≤20, mustKeywords ≤15, niceKeywords ≤15.
7. seniorityBands: which of entry|mid|senior|lead|exec to include (usually the
   candidate's band ±1).

## Output schema (STRICT JSON, no prose around it, no code fences)
{
  "primaryTitles": ["..."],
  "adjacentTitles": ["..."],
  "stretchTitles": ["..."],
  "transferableSkillTags": ["python", "lang:python", "..."],
  "mustKeywords": ["..."],
  "niceKeywords": ["..."],
  "seniorityBands": ["senior"],
  "rationale": "1-2 sentences on how you widened the net."
}
Output ONLY the JSON object.`;
  }

  protected formatInput(input: CrossBankExplorerInput): string {
    const parts: string[] = [];
    parts.push(`## Candidate\nHeadline: ${input.candidateHeadline.slice(0, 400)}`);
    parts.push(`Current titles: ${input.currentTitles.slice(0, 6).join(', ') || '(none parsed)'}`);
    parts.push(`Top skills: ${input.topSkills.slice(0, 30).join(', ') || '(none parsed)'}`);
    parts.push(`Seniority: ${input.seniority} · Years: ${input.yearsExperience ?? 'unknown'}`);
    parts.push(`Market country: ${input.marketCountry}`);
    const d = input.draft;
    parts.push(
      `Target roles: ${(d.targetRoles ?? []).join(', ') || '(none)'} · Industries to target: ${(d.industriesTarget ?? []).join(', ') || '(none)'}`,
    );
    parts.push('Produce the expansion plan. Output ONLY the JSON object.');
    return parts.join('\n');
  }

  protected parseOutput(response: string): CrossBankExplorerPlan {
    // NEVER throws — the orchestrator relies on run() back-filling empties.
    const cleaned = (response ?? '')
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          parsed = {};
        }
      }
    }
    return {
      primaryTitles: strArr(parsed.primaryTitles, 120, 4),
      adjacentTitles: strArr(parsed.adjacentTitles, 120, 6),
      stretchTitles: strArr(parsed.stretchTitles, 120, 4),
      transferableSkillTags: strArr(parsed.transferableSkillTags, 60, 20),
      mustKeywords: strArr(parsed.mustKeywords, 60, 15),
      niceKeywords: strArr(parsed.niceKeywords, 60, 15),
      seniorityBands: strArr(parsed.seniorityBands, 20, 5),
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 400) : '',
    };
  }

  async run(
    input: CrossBankExplorerInput,
    options: { requestId?: string; signal?: AbortSignal } = {},
  ): Promise<CrossBankExplorerPlan> {
    let plan: CrossBankExplorerPlan;
    try {
      plan = await this.executeWithJsonResponse(
        input,
        input.candidateHeadline,
        options.requestId,
        pickCrossBankExplorerModel(),
        undefined,
        undefined,
      );
    } catch {
      return buildExplorerFallback(input);
    }
    // Back-fill any empty slots from the deterministic fallback so retrieval is
    // never starved by a thin LLM response.
    const fb = buildExplorerFallback(input);
    if (plan.primaryTitles.length === 0) plan.primaryTitles = fb.primaryTitles;
    if (plan.transferableSkillTags.length === 0) plan.transferableSkillTags = fb.transferableSkillTags;
    if (plan.mustKeywords.length === 0) plan.mustKeywords = fb.mustKeywords;
    return plan;
  }
}

export const raCrossBankExplorerAgent = new RACrossBankExplorerAgent();
export default raCrossBankExplorerAgent;

export const __test = { pickCrossBankExplorerModel, buildExplorerFallback, strArr };
