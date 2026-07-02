// backend/src/seeker/agents/SeekerResumeTailorAgent.ts
//
// Tailor the seeker's master resume for a specific job. Wraps the BaseAgent
// LLM call with THREE layers of hallucination defense:
//
//   Layer 1 — Prompt engineering: explicit "never invent" rules + few-shot
//     examples that show valid (reword/reorder/emphasize/demote) vs invalid
//     (fabricate) outputs.
//
//   Layer 2 — Structured schema: separates `originalBullets` from
//     `tailoredBullets`; skills section forbids `added` (banned in v1) so
//     the agent can only `removed` / `reorderedToTop` / `kept`.
//
//   Layer 3 — Post-hoc claim-checker: a separate (cheap, deterministic) LLM
//     pass extracts every skill / company / role / date / numeric claim from
//     the tailored output and verifies each is supported by the original
//     resume. If anything fails, retry ONCE with the failed claims called
//     out; if the retry still fails, throw `SeekerResumeTailorRejectedError`.
//
// Quota debit is BILLED ON SUCCESS (success = claim-checker passed). Failures
// (LLM error, parse error, claim-checker rejection after retry) cost the
// seeker zero credits. See docs/job-seeker-ai-architecture.md §4.2 +
// docs/prd-job-seeker-app.md §F (Pricing & Tiers).
//
// Cost: Sonnet (rewrite) ≈ $0.06–$0.10; Gemini Flash (claim-checker) ≈
// $0.003. Total ≈ $0.07/call.
//
// Boundary: extends BaseAgent (explicitly allow-listed for seeker code).
// References ResumeMatchAgent only as a public re-scoring utility — the
// re-score happens in SeekerResumeVersionService, not here.

import { BaseAgent } from '../../../agents/BaseAgent.js';
import { llmService } from '../../../services/llm/LLMService.js';
import { logger } from '../../../services/LoggerService.js';
import type { ParsedResume } from '../../../types/index.js';

// ─── Public types ───────────────────────────────────────────────────────

export interface SeekerResumeTailorInput {
  /** Parsed resume content (the source of truth — original facts). */
  originalParsedResume: ParsedResume | null;
  /** Original resume markdown / text. Always provided. */
  originalResumeText: string;
  /** Target job content (title + description + qualifications + nice-to-have). */
  job: {
    title: string;
    companyName?: string | null;
    description?: string | null;
    qualifications?: string | null;
    hardRequirements?: string | null;
    niceToHave?: string | null;
  };
  /** Optional seeker preferences for tone calibration. */
  preferences?: Record<string, unknown> | null;
  /** Locale for output language. Defaults to 'en'. */
  locale?: string;
}

export type TailorChangeType = 'reworded' | 'reordered' | 'emphasized' | 'demoted' | 'kept';

export interface TailoredExperienceSection {
  /** Verbatim from original — MUST match. */
  company: string;
  /** Verbatim from original — MUST match. */
  role: string;
  /** Verbatim from original — MUST match. */
  dateRange: string;
  /** Verbatim bullets from input. */
  originalBullets: string[];
  /** Rewritten / reordered bullets. NEVER fabricate. */
  tailoredBullets: string[];
  /** Per-bullet rationale. */
  changeNotes: Array<{
    bulletIndex: number;
    rationale: string;
    type: TailorChangeType;
  }>;
}

export interface TailoredSections {
  summary?: {
    original: string;
    tailored: string;
    rationale: string;
  };
  experience: TailoredExperienceSection[];
  skills: {
    /** MUST be empty in v1 — never invent skills. */
    added: string[];
    /** Less-relevant skills downplayed. */
    removed: string[];
    /** Skills lifted to the top because the JD prioritizes them. */
    reorderedToTop: string[];
    /** Unchanged baseline skills. */
    kept: string[];
  };
  education: {
    changes: Array<{ section: string; rationale: string }>;
  };
}

export interface SeekerResumeTailorOutput {
  tailoredSections: TailoredSections;
  /** ATS keywords from JD now present in tailored output. */
  injectedKeywords: string[];
  /** Less-relevant keywords downplayed. */
  removedKeywords: string[];
  /** 2-3 sentence summary of the tailoring strategy. */
  atsAlignmentNotes: string;
  /** Agent's own confidence in the tailor. */
  confidence: 'high' | 'medium' | 'low';
}

// ─── Errors ─────────────────────────────────────────────────────────────

export type SeekerResumeTailorRejectionCode =
  | 'hallucination_after_retry'
  | 'parse_failed_after_retry'
  | 'no_experience_to_tailor';

export class SeekerResumeTailorRejectedError extends Error {
  constructor(
    public readonly code: SeekerResumeTailorRejectionCode,
    message: string,
    public readonly violations?: ClaimViolation[],
  ) {
    super(message);
    this.name = 'SeekerResumeTailorRejectedError';
  }
}

// ─── Claim-checker types ────────────────────────────────────────────────

export interface ClaimViolation {
  /** Where in the tailored output the violation lives ('skills.added[0]', 'experience[1].tailoredBullets[2]', etc.). */
  location: string;
  /** The claim that wasn't supported. */
  claim: string;
  /** 'hallucination' = inventing a fact; 'mismatch' = changing a fact (e.g. dates); 'metric' = inventing or altering a number. */
  severity: 'hallucination' | 'mismatch' | 'metric';
  /** What the original resume actually says (or 'NONE'). */
  originalSupport: string;
}

export interface ClaimCheckerResult {
  passed: boolean;
  violations: ClaimViolation[];
  /** The model the claim-checker ran on. */
  modelUsed: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function clipString(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  return s.trim().slice(0, max);
}

function sanitizeStringArray(value: unknown, maxLen: number, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, maxLen));
    if (out.length >= maxItems) break;
  }
  return out;
}

const DEFAULT_OUTPUT: SeekerResumeTailorOutput = {
  tailoredSections: {
    experience: [],
    skills: { added: [], removed: [], reorderedToTop: [], kept: [] },
    education: { changes: [] },
  },
  injectedKeywords: [],
  removedKeywords: [],
  atsAlignmentNotes: 'No tailoring performed — agent returned an empty response.',
  confidence: 'low',
};

// ─── Agent ──────────────────────────────────────────────────────────────

export class SeekerResumeTailorAgent extends BaseAgent<
  SeekerResumeTailorInput,
  SeekerResumeTailorOutput
> {
  constructor() {
    super('SeekerResumeTailorAgent');
  }

  protected getTemperature(): number {
    // Slightly above the scoring-agent floor — the tailor needs some creative
    // freedom to reword bullets, but determinism still matters because the
    // claim-checker downstream is strict.
    return 0.2;
  }

  protected getMaxTokens(): number | undefined {
    return 24000;
  }

  protected getAgentPrompt(): string {
    return `You are a senior resume editor who tailors candidate resumes to specific job descriptions. Your only job is to REWORD, REORDER, EMPHASIZE, or DEMOTE existing content. You NEVER invent new skills, achievements, employers, dates, or metric numbers.

## Hard rules — these are absolute

1. **No new skills.** If the job description requires a skill the candidate does not have in the original resume, you leave it out. Do not add it. Do not exaggerate an unrelated skill into the requested one.
2. **No new experience.** Every company name, role title, date range, and metric number in the original MUST appear in the tailored output unchanged.
3. **Action verbs are flexible; scope is not.** "Built" → "engineered" is fine. "Led a team of 3" → "Led a team of 10" is FORBIDDEN.
4. **Numeric claims are immutable.** Years of experience, percentage improvements, dollar amounts, team sizes — all of these must match the original exactly. If the original says "improved X by 20%", the tailored version cannot say "improved X by 25%".
5. **Re-ordering is allowed.** You may lift relevant bullets to the top of an experience entry, and move less-relevant ones to the bottom. You may NOT delete experience entries — only downplay them.
6. **Skills section.** You may REMOVE less-relevant skills and REORDER skills to lift the most relevant ones to the top. You may NEVER ADD a skill that isn't in the original.

## Few-shot examples

### Valid — reword
Original: "Built REST APIs with Express.js for a product catalog system serving 50k requests/day."
JD requires: "GraphQL experience"
Tailored: "Engineered REST APIs with Express.js for a product catalog system serving 50k requests/day." ✓ (reworded — kept facts)
Tailored: "Engineered REST and GraphQL APIs..." ✗ (FORBIDDEN — invented GraphQL)

### Valid — reorder
Original bullets (3 bullets, in original order):
  1. "Migrated legacy PHP to Node.js."
  2. "Mentored 3 junior engineers."
  3. "Led production migration to Kubernetes."
JD emphasizes: leadership + cloud.
Tailored bullets (reordered, same content):
  1. "Led production migration to Kubernetes."
  2. "Mentored 3 junior engineers."
  3. "Migrated legacy PHP to Node.js." ✓ (reordered, no fabrication)

### Valid — emphasize
Original: "Used Python and SQL daily."
JD emphasizes: data engineering.
Tailored: "Leveraged Python and SQL daily for data pipelines." ✓ (reworded — pipelines is consistent with original signal of daily-Python+SQL data work, but DO NOT invent specific tools the candidate didn't list)

### Invalid — fabrication
Original: "Worked on backend services in Go."
JD requires: "Rust experience"
Tailored: "Worked on backend services in Go and Rust." ✗ (FORBIDDEN — invented Rust)

## Output schema

You output ONE strict JSON object, no prose around it:

{
  "tailoredSections": {
    "summary": { "original": "...", "tailored": "...", "rationale": "..." } | null,
    "experience": [
      {
        "company": "<verbatim from original>",
        "role":    "<verbatim from original>",
        "dateRange": "<verbatim from original>",
        "originalBullets": ["bullet 1 verbatim", "bullet 2 verbatim", ...],
        "tailoredBullets": ["rewritten or reordered bullet 1", "..."],
        "changeNotes": [
          { "bulletIndex": 0, "rationale": "<why>", "type": "reworded|reordered|emphasized|demoted|kept" }
        ]
      }
    ],
    "skills": {
      "added":           [],                                 // ALWAYS empty in v1 — never add skills
      "removed":         ["less-relevant skill 1", ...],     // skills lifted from the master that don't match JD
      "reorderedToTop":  ["skill 1", "skill 2", ...],        // existing skills that match the JD, lifted to top
      "kept":            ["unchanged skill 1", ...]          // unchanged baseline skills
    },
    "education": { "changes": [ { "section": "...", "rationale": "..." } ] }  // typically empty — education is rarely tailored
  },
  "injectedKeywords":  ["ATS keyword from JD now present in tailored", ...],
  "removedKeywords":   ["keyword downplayed", ...],
  "atsAlignmentNotes": "<2-3 sentences summarizing the tailoring strategy>",
  "confidence":        "high" | "medium" | "low"
}

## Locale

Output text (summary, rationale, atsAlignmentNotes) in the seeker's locale. Do not translate the original resume content — preserve it verbatim. Only the new text (rationale, notes, the *tailored* summary if present) should be in locale.

You output ONLY the JSON.`;
  }

  protected formatInput(input: SeekerResumeTailorInput): string {
    const localeBlock = `Locale: ${input.locale || 'en'}`;
    const resumeBlock = input.originalParsedResume
      ? `## Parsed master resume (the source of truth — your output must reference only these facts)\n${JSON.stringify(input.originalParsedResume, null, 2)}`
      : '## Parsed master resume\n(not parsed — using raw text only)';
    const resumeTextBlock = `## Original resume text (verbatim)\n${input.originalResumeText.slice(0, 18_000)}`;
    const jobBlock = `## Target job
Title: ${input.job.title}
${input.job.companyName ? `Company: ${input.job.companyName}\n` : ''}
Description:
${(input.job.description || '').slice(0, 6_000)}

Qualifications:
${(input.job.qualifications || '').slice(0, 4_000)}

Hard requirements:
${(input.job.hardRequirements || '').slice(0, 2_000)}

Nice-to-have:
${(input.job.niceToHave || '').slice(0, 2_000)}`;

    const prefsBlock = input.preferences
      ? `## Seeker preferences (use for tone, do NOT invent facts)\n${JSON.stringify(input.preferences, null, 2).slice(0, 2_000)}`
      : '## Seeker preferences\n(none on file)';

    return `${localeBlock}\n\n${resumeBlock}\n\n${resumeTextBlock}\n\n${jobBlock}\n\n${prefsBlock}\n\nProduce the tailored sections now. Remember: NEVER invent. Only reword, reorder, emphasize, or demote.`;
  }

  protected parseOutput(response: string): SeekerResumeTailorOutput {
    if (!response || typeof response !== 'string') {
      return DEFAULT_OUTPUT;
    }
    const cleaned = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          parsed = null;
        }
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return DEFAULT_OUTPUT;
    }

    const sectionsRaw = (parsed.tailoredSections ?? {}) as Record<string, unknown>;
    const summaryRaw = sectionsRaw.summary as Record<string, unknown> | null | undefined;
    const summary =
      summaryRaw && typeof summaryRaw === 'object'
        ? {
            original: clipString(summaryRaw.original, 2_000),
            tailored: clipString(summaryRaw.tailored, 2_000),
            rationale: clipString(summaryRaw.rationale, 600),
          }
        : undefined;

    const experienceRaw = Array.isArray(sectionsRaw.experience) ? sectionsRaw.experience : [];
    const experience: TailoredExperienceSection[] = [];
    for (const e of experienceRaw) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
      const ex = e as Record<string, unknown>;
      const company = clipString(ex.company, 200);
      const role = clipString(ex.role, 200);
      const dateRange = clipString(ex.dateRange, 100);
      const originalBullets = sanitizeStringArray(ex.originalBullets, 1_000, 25);
      const tailoredBullets = sanitizeStringArray(ex.tailoredBullets, 1_000, 25);
      const changeNotesRaw = Array.isArray(ex.changeNotes) ? ex.changeNotes : [];
      const changeNotes: TailoredExperienceSection['changeNotes'] = [];
      for (const note of changeNotesRaw) {
        if (!note || typeof note !== 'object' || Array.isArray(note)) continue;
        const n = note as Record<string, unknown>;
        const bulletIndex =
          typeof n.bulletIndex === 'number' && Number.isFinite(n.bulletIndex)
            ? Math.max(0, Math.floor(n.bulletIndex))
            : 0;
        const rationale = clipString(n.rationale, 400);
        const typeRaw = clipString(n.type, 30);
        const type: TailorChangeType =
          (typeRaw as TailorChangeType) === 'reworded' ||
          (typeRaw as TailorChangeType) === 'reordered' ||
          (typeRaw as TailorChangeType) === 'emphasized' ||
          (typeRaw as TailorChangeType) === 'demoted' ||
          (typeRaw as TailorChangeType) === 'kept'
            ? (typeRaw as TailorChangeType)
            : 'reworded';
        changeNotes.push({ bulletIndex, rationale, type });
        if (changeNotes.length >= 25) break;
      }
      if (!company && !role) continue;
      experience.push({ company, role, dateRange, originalBullets, tailoredBullets, changeNotes });
      if (experience.length >= 12) break;
    }

    const skillsRaw = (sectionsRaw.skills ?? {}) as Record<string, unknown>;
    // `added` is ALWAYS sanitized to [] — defense-in-depth against an agent
    // that ignores the prompt rule. Any value here gets dropped + flagged
    // by the claim-checker downstream.
    const skills = {
      added: [] as string[],
      removed: sanitizeStringArray(skillsRaw.removed, 64, 40),
      reorderedToTop: sanitizeStringArray(skillsRaw.reorderedToTop, 64, 40),
      kept: sanitizeStringArray(skillsRaw.kept, 64, 80),
    };

    const educationRaw = (sectionsRaw.education ?? {}) as Record<string, unknown>;
    const changesRaw = Array.isArray(educationRaw.changes) ? educationRaw.changes : [];
    const education = {
      changes: changesRaw
        .filter((c) => c && typeof c === 'object' && !Array.isArray(c))
        .map((c) => {
          const cc = c as Record<string, unknown>;
          return {
            section: clipString(cc.section, 200),
            rationale: clipString(cc.rationale, 400),
          };
        })
        .filter((c) => c.section || c.rationale)
        .slice(0, 6),
    };

    const injectedKeywords = sanitizeStringArray(parsed.injectedKeywords, 64, 30);
    const removedKeywords = sanitizeStringArray(parsed.removedKeywords, 64, 30);
    const atsAlignmentNotes = clipString(parsed.atsAlignmentNotes, 1_200) || DEFAULT_OUTPUT.atsAlignmentNotes;
    const confidenceRaw = clipString(parsed.confidence, 10);
    const confidence: SeekerResumeTailorOutput['confidence'] =
      confidenceRaw === 'high' || confidenceRaw === 'medium' || confidenceRaw === 'low'
        ? confidenceRaw
        : 'medium';

    const tailoredSections: TailoredSections = {
      ...(summary ? { summary } : {}),
      experience,
      skills,
      education,
    };

    return {
      tailoredSections,
      injectedKeywords,
      removedKeywords,
      atsAlignmentNotes,
      confidence,
    };
  }

  /**
   * Run the full tailor pipeline:
   *   1. Tailor pass (this agent's main LLM call).
   *   2. Claim-checker pass (separate cheap LLM call, deterministic).
   *   3. On any 'hallucination' or 'mismatch' violation: retry the tailor
   *      with the violations explicitly called out. Retry exactly ONCE.
   *   4. If the retry still fails, throw SeekerResumeTailorRejectedError.
   *
   * Returns `{ output, claimChecker, attempts }` so the caller can attach
   * provenance to the saved version + decide whether to bill the credit.
   */
  async tailor(
    input: SeekerResumeTailorInput,
    requestId?: string,
  ): Promise<{
    output: SeekerResumeTailorOutput;
    claimChecker: ClaimCheckerResult;
    attempts: number;
  }> {
    // Validate the input has at least one experience entry to tailor.
    const expCount = Array.isArray(input.originalParsedResume?.experience)
      ? input.originalParsedResume!.experience.length
      : 0;
    if (expCount === 0 && (!input.originalResumeText || input.originalResumeText.trim().length < 50)) {
      throw new SeekerResumeTailorRejectedError(
        'no_experience_to_tailor',
        'No experience entries found in the original resume',
      );
    }

    // ─ Pass 1 ────────────────────────────────────────────────────────────
    const firstOutput = await this.execute(
      input,
      input.job.description ?? input.job.title,
      requestId,
      input.locale,
    );

    const firstCheck = await runClaimChecker({
      original: {
        parsedResume: input.originalParsedResume,
        resumeText: input.originalResumeText,
      },
      tailored: firstOutput,
      locale: input.locale,
      requestId,
    });

    if (firstCheck.passed) {
      return { output: firstOutput, claimChecker: firstCheck, attempts: 1 };
    }

    // ─ Retry once with violations called out ────────────────────────────
    logger.warn(
      'AGENT',
      'SeekerResumeTailorAgent: claim-checker failed; retrying with violations called out',
      { violations: firstCheck.violations.slice(0, 5), violationCount: firstCheck.violations.length },
      requestId,
    );

    const retryInput: SeekerResumeTailorInput = {
      ...input,
    };
    // Inject the violations into the user message via a wrapper agent run.
    // We do this by re-executing with the same prompt but a clarifying
    // suffix added on top of the formatted input. The easiest way to do
    // that without forking BaseAgent is to subclass the formatInput
    // dynamically here — but since we control execute(), we can just
    // call llmService.chat directly with the same system + augmented user
    // message. Use the same temperature / max-tokens / locale routing.
    const augmentedUserPart = `\n\n## Your previous attempt had these violations\n${firstCheck.violations
      .map(
        (v, i) =>
          `${i + 1}. [${v.severity}] at ${v.location}: "${v.claim}" — original support: "${v.originalSupport}"`,
      )
      .join('\n')}\n\nTry again. NEVER invent facts. If a JD requirement is not supported by the original resume, OMIT it from the tailored output — do not fabricate.`;

    const systemPrompt = this.buildSystemPrompt(retryInput.job.description ?? retryInput.job.title, requestId, retryInput.locale);
    const userMessage = this.formatInput(retryInput) + augmentedUserPart;
    const retryResponseText = await llmService.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      {
        temperature: this.getTemperature(),
        maxTokens: this.getMaxTokens(),
        requestId,
      },
    );
    const secondOutput = this.parseOutput(retryResponseText);

    const secondCheck = await runClaimChecker({
      original: {
        parsedResume: input.originalParsedResume,
        resumeText: input.originalResumeText,
      },
      tailored: secondOutput,
      locale: input.locale,
      requestId,
    });

    if (secondCheck.passed) {
      return { output: secondOutput, claimChecker: secondCheck, attempts: 2 };
    }

    // ─ Final rejection — caller does NOT bill the credit ────────────────
    logger.error(
      'AGENT',
      'SeekerResumeTailorAgent: claim-checker failed twice; rejecting tailor',
      { violationCount: secondCheck.violations.length },
      requestId,
    );
    throw new SeekerResumeTailorRejectedError(
      'hallucination_after_retry',
      'Resume tailor produced unverifiable claims twice in a row',
      secondCheck.violations,
    );
  }
}

export const seekerResumeTailorAgent = new SeekerResumeTailorAgent();

// ─── Claim-checker (separate, cheap LLM pass) ──────────────────────────
//
// Adversarial fact-checker pass. Runs on a different (cheap) model so the
// cost per refinement stays bounded. The checker is given:
//   - The ORIGINAL parsed resume (the ground truth).
//   - The ORIGINAL raw text (a secondary source for items not captured by
//     the parsed-resume schema, e.g. inline-mentioned tools).
//   - The TAILORED output produced by the tailor agent.
//
// It returns ONE strict JSON object with `passed` + a list of violations.
// We then translate that into a verdict the tailor agent uses to decide
// whether to retry or accept.

const CLAIM_CHECKER_MODEL = 'google/gemini-3.0-flash';

const CLAIM_CHECKER_SYSTEM_PROMPT = `You are an adversarial fact-checker. You are given an ORIGINAL parsed resume + raw text (the ground truth) and a TAILORED resume (a recent edit). Your only job is to find ANY claim in the tailored resume that is not directly supported by the original.

PROCEDURE
1. For every skill, technology, employer, project, certification, degree, metric, and time-period in the tailored resume, locate the source in the original. If you cannot find a source, flag it as 'hallucination'.
2. For every numeric claim ("led team of 10", "improved performance by 30%"), match it against the original. Round numbers are NOT flexible; "10" becoming "12" is a 'metric' flag.
3. Action-verb rewrites are allowed (e.g., "built" → "engineered") only when the underlying scope is unchanged. Scope changes are 'mismatch' flags.
4. Skills section: tailoredSections.skills.added MUST be empty. If it has any value, flag every entry as 'hallucination'.
5. Company names, role titles, and date ranges in tailoredSections.experience[*] MUST match the original verbatim. Any divergence is a 'mismatch' flag.

OUTPUT (strict JSON only — no prose):
{
  "passed": <true | false>,
  "violations": [
    {
      "location": "<path in tailored, e.g. 'experience[1].tailoredBullets[2]', 'skills.added[0]'>",
      "claim":    "<the offending claim>",
      "severity": "hallucination" | "mismatch" | "metric",
      "originalSupport": "<what the original says, or 'NONE'>"
    }
  ]
}

If any violation has severity 'hallucination', set passed=false. Same for 'mismatch' or 'metric' violations — any unsupported claim means passed=false. Reorderings without content changes are NOT violations.

You output ONLY the JSON.`;

async function runClaimChecker(args: {
  original: {
    parsedResume: ParsedResume | null;
    resumeText: string;
  };
  tailored: SeekerResumeTailorOutput;
  locale?: string;
  requestId?: string;
}): Promise<ClaimCheckerResult> {
  const { original, tailored, requestId } = args;

  // If the tailored output is the default-empty one (parse failed), don't
  // call the LLM — just flag a parse failure so the caller retries / errors.
  const hasContent =
    tailored.tailoredSections.experience.length > 0 ||
    tailored.tailoredSections.summary != null ||
    tailored.tailoredSections.skills.reorderedToTop.length > 0;
  if (!hasContent) {
    return {
      passed: false,
      violations: [
        {
          location: 'root',
          claim: 'Tailored output was empty / failed to parse',
          severity: 'mismatch',
          originalSupport: 'NONE',
        },
      ],
      modelUsed: 'none',
    };
  }

  // Layer-3 deterministic pre-check: ANY skills.added is an immediate
  // hallucination flag. The parseOutput sanitizer should always zero this,
  // but if it ever doesn't (e.g. test passes a hand-crafted output), we
  // catch it here without needing a round-trip.
  const preCheckViolations: ClaimViolation[] = [];
  if (Array.isArray(tailored.tailoredSections.skills.added) && tailored.tailoredSections.skills.added.length > 0) {
    for (let i = 0; i < tailored.tailoredSections.skills.added.length; i += 1) {
      preCheckViolations.push({
        location: `skills.added[${i}]`,
        claim: tailored.tailoredSections.skills.added[i],
        severity: 'hallucination',
        originalSupport: 'NONE — skills.added is banned in v1',
      });
    }
  }

  const originalBlock = `## ORIGINAL parsed resume\n${
    original.parsedResume ? JSON.stringify(original.parsedResume, null, 2) : '(no parsed resume)'
  }\n\n## ORIGINAL raw text\n${(original.resumeText || '').slice(0, 14_000)}`;
  const tailoredBlock = `## TAILORED output\n${JSON.stringify(tailored, null, 2).slice(0, 14_000)}`;

  let responseText: string;
  try {
    responseText = await llmService.chat(
      [
        { role: 'system', content: CLAIM_CHECKER_SYSTEM_PROMPT },
        { role: 'user', content: `${originalBlock}\n\n${tailoredBlock}` },
      ],
      {
        temperature: 0.0,
        maxTokens: 24000,
        model: CLAIM_CHECKER_MODEL,
        requestId,
      },
    );
  } catch (err) {
    // Network / provider error: fail-closed. The seeker isn't billed
    // because the tailor service treats this as a failed claim-check and
    // rejects the output.
    logger.error(
      'AGENT',
      'SeekerResumeTailorAgent: claim-checker LLM call failed',
      { error: err instanceof Error ? err.message : String(err) },
      requestId,
    );
    return {
      passed: false,
      violations: [
        ...preCheckViolations,
        {
          location: 'root',
          claim: 'Claim-checker LLM call failed',
          severity: 'mismatch',
          originalSupport: 'NONE',
        },
      ],
      modelUsed: CLAIM_CHECKER_MODEL,
    };
  }

  // Parse the checker's strict-JSON output.
  const cleaned = responseText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      passed: false,
      violations: [
        ...preCheckViolations,
        {
          location: 'root',
          claim: 'Claim-checker output unparseable',
          severity: 'mismatch',
          originalSupport: 'NONE',
        },
      ],
      modelUsed: CLAIM_CHECKER_MODEL,
    };
  }

  const violations: ClaimViolation[] = [...preCheckViolations];
  const violationsRaw = Array.isArray(parsed.violations) ? parsed.violations : [];
  for (const v of violationsRaw) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const vv = v as Record<string, unknown>;
    const severityRaw = clipString(vv.severity, 20);
    const severity: ClaimViolation['severity'] =
      severityRaw === 'hallucination' || severityRaw === 'mismatch' || severityRaw === 'metric'
        ? (severityRaw as ClaimViolation['severity'])
        : 'mismatch';
    violations.push({
      location: clipString(vv.location, 200) || 'unknown',
      claim: clipString(vv.claim, 600),
      severity,
      originalSupport: clipString(vv.originalSupport, 600) || 'NONE',
    });
    if (violations.length >= 30) break;
  }

  const passed = parsed.passed === true && violations.length === 0;
  return { passed, violations, modelUsed: CLAIM_CHECKER_MODEL };
}

// Exported for testing — lets the test inject violations or stub LLM.
export const __test = {
  runClaimChecker,
  CLAIM_CHECKER_MODEL,
};

export default seekerResumeTailorAgent;
