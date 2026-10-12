// server/src/interview-engine/prep/planner.ts
//
// The interview plan for one target — a job of ours, a posting found on the
// web, a pasted post, or just a role title — with an optional company:
//
//   1. Load the post (our job: market-checked like every practice), else take
//      the posting text or the pasted post; else research the role on the web.
//   2. In parallel: the company's interview style (companyStyle.ts, cached),
//      the field's expert lens (domainExperts.ts), the candidate's redacted
//      resume (to aim the prep tips at their gaps).
//   3. InterviewPlannerAgent writes the requirements, a panel of interviewers
//      this loop would really use, the focuses the job is tested on (each a
//      format + patterns from the skill index) and the strategy.
//   4. Everything is cleaned (contract.ts): ids checked against the skill
//      registry, each interviewer mapped onto the catalog persona the engine
//      runs on, keys made unique, the recommendation made valid.
//
// Without the model the plan still comes back (`fallback: true`): catalog
// interviewers and formats the screen labels from its own bundles, so Start
// is never blocked by a planning failure.

import { logger } from '../../services/LoggerService.js';
import { INTERVIEW_PERSONAS } from '../catalog/interviewCatalog.js';
import { getFormat, type FormatMarket } from '../catalog/interviewFormats.js';
import { resolveDomainExpert, type DomainExpertPlaybook } from '../catalog/domainExperts.js';
import { inferRoleFromJd } from '../prompt/InterviewBlueprintAgent.js';
import { renderMarketSummary, renderSkillIndex } from '../skills/index.js';
import {
  clip,
  clipBlock,
  cleanFocuses,
  cleanInterviewers,
  cleanRequirements,
  cleanStrategy,
  describeCompanyStyle,
  type PrepCompanyStyle,
  type PrepFocus,
  type PrepInterviewer,
  type PrepPlan,
  type PrepPlanBody,
  type PrepSource,
} from './contract.js';
import { interviewPlannerAgent, type InterviewPlannerInput } from './agents.js';
import { researchCompanyStyle } from './companyStyle.js';
import { countryFromLocation, resolvePrepMarket, type PrepMarketContext } from './marketContext.js';
import { formatResults, searchWeb } from './webSearch.js';
import type { ProductBrand } from '../../platform/brand/registry.js';

const PLANNER_TIMEOUT_MS = 70_000;
/** A post shorter than this is not enough to plan from; the role is researched too. */
const THIN_POST_CHARS = 600;

export class PrepJobNotFoundError extends Error {
  readonly code = 'job_not_found';
  constructor() {
    super('The job was not found.');
    this.name = 'PrepJobNotFoundError';
  }
}

export interface PlannerTarget {
  role: string;
  company: string | null;
  industry: string | null;
  jobId: string | null;
  jdText: string | null;
  posting: PrepPlan['posting'];
  countryHint: string | null;
}

export interface PlannerDeps {
  loadJob: (userId: string, jobId: string, market: FormatMarket) => Promise<{ id: string; title: string; companyName: string | null; location: string | null; jdText: string } | null>;
  loadResume: (userId: string, jobId: string | null, knownValues: string[]) => Promise<string | null>;
  marketContext: (input: { userId: string; brand: ProductBrand; locale: string; countryHint: string | null }) => Promise<PrepMarketContext>;
  companyStyle: typeof researchCompanyStyle;
  roleEvidence: (role: string, ctx: PrepMarketContext) => Promise<{ text: string; sources: PrepSource[] }>;
  plan: (input: InterviewPlannerInput, requestId?: string) => Promise<Record<string, unknown>>;
}

export const defaultPlannerDeps: PlannerDeps = {
  async loadJob(userId, jobId, market) {
    const { loadPracticeJob } = await import('../sessions/InterviewSessionService.js');
    return loadPracticeJob(userId, jobId, market);
  },
  async loadResume(userId, jobId, knownValues) {
    const { loadPracticeResume } = await import('../sessions/InterviewSessionService.js');
    const resume = await loadPracticeResume(userId, { jobId, knownValues }).catch(() => null);
    return resume?.context || null;
  },
  marketContext: (input) => resolvePrepMarket(input),
  companyStyle: researchCompanyStyle,
  async roleEvidence(role, ctx) {
    const results = await searchWeb(ctx.brand, `${clip(role, 100)} job description responsibilities requirements qualifications`, { maxResults: 5 });
    if (!results?.length) return { text: '', sources: [] };
    return { text: formatResults(results, 2600), sources: results.slice(0, 5).map((r) => ({ title: r.title, url: r.url })) };
  },
  plan: (input, requestId) => interviewPlannerAgent.run(input, { requestId, signal: AbortSignal.timeout(PLANNER_TIMEOUT_MS) }),
};

function domainBrief(domain: DomainExpertPlaybook | null): string | null {
  if (!domain) return null;
  return `${domain.labelEn}: ${domain.summary}${domain.deepDiveTopics.length ? ` Sub-areas worth probing: ${domain.deepDiveTopics.slice(0, 8).join('; ')}.` : ''}`;
}

/** The catalog fallback: three interviewers and four formats the screen labels itself. */
export function fallbackPanel(domain: DomainExpertPlaybook | null, market: FormatMarket): { interviewers: PrepInterviewer[]; focuses: PrepFocus[] } {
  const technical = domain && ['software', 'ai-ml', 'data', 'hardware'].includes(domain.key);
  const commercial = domain && ['sales', 'marketing', 'consumer', 'media'].includes(domain.key);
  const formats = ['behavioral', technical ? 'technical' : commercial ? 'sales_roleplay' : 'case', 'screening', 'culture'];
  if (market === 'cn') formats.splice(2, 1, 'cn_ai_interview');
  const focuses: PrepFocus[] = formats
    .filter((id) => getFormat(id))
    .map((id, index) => {
      const format = getFormat(id)!;
      return { key: `f${index + 1}`, label: format.labelEn, description: format.subEn, format: id, patterns: [], topics: format.focusAreas.slice(0, 4) };
    });
  const personaIds = ['priya', technical ? 'kai' : 'okonkwo', 'maya'];
  const interviewers: PrepInterviewer[] = personaIds
    .map((id) => INTERVIEW_PERSONAS.find((persona) => persona.id === id))
    .filter((persona): persona is NonNullable<typeof persona> => Boolean(persona))
    .map((persona, index) => ({
      key: `i${index + 1}`,
      name: persona.name,
      title: persona.role,
      background: persona.blurb,
      style: persona.style,
      archetype: persona.archetype,
      difficulty: (Math.min(3, Math.max(1, persona.difficulty)) as 1 | 2 | 3),
      voiceGender: persona.voiceGender === 'male' ? 'male' : 'female',
      baseId: persona.id,
      focusKeys: [],
      patterns: [],
    }));
  return { interviewers, focuses };
}

/** Make sure every interviewer has focuses and the recommendation points at real keys. */
function settle(interviewers: PrepInterviewer[], focuses: PrepFocus[], recommended: unknown): PrepPlan['recommended'] {
  const focusKeys = new Set(focuses.map((focus) => focus.key));
  for (const interviewer of interviewers) {
    interviewer.focusKeys = interviewer.focusKeys.filter((key) => focusKeys.has(key));
  }
  const rec = (recommended && typeof recommended === 'object' ? recommended : {}) as Record<string, unknown>;
  const focusKey = focuses.find((focus) => focus.key === rec.focusKey)?.key ?? focuses[0].key;
  const interviewerKey =
    interviewers.find((interviewer) => interviewer.key === rec.interviewerKey)?.key ??
    interviewers.find((interviewer) => interviewer.focusKeys.includes(focusKey))?.key ??
    interviewers[0].key;
  return { interviewerKey, focusKey };
}

export async function resolvePlannerTarget(
  input: { userId: string; body: PrepPlanBody; market: FormatMarket },
  deps: Pick<PlannerDeps, 'loadJob'> = defaultPlannerDeps,
): Promise<PlannerTarget> {
  const body = input.body;
  if (body.jobId) {
    const job = await deps.loadJob(input.userId, body.jobId, input.market);
    if (!job) throw new PrepJobNotFoundError();
    return {
      role: clip(body.role, 200) || job.title,
      company: clip(body.company, 120) || job.companyName || null,
      industry: clip(body.industry, 80) || null,
      jobId: job.id,
      jdText: clipBlock(job.jdText, 8000) || null,
      posting: { title: job.title, company: job.companyName, location: job.location, url: null },
      countryHint: countryFromLocation(job.location),
    };
  }
  const jdText = clipBlock(body.jdText, 8000) || null;
  const posting = body.posting
    ? {
        title: clip(body.posting.title, 200),
        company: clip(body.posting.company, 120) || null,
        location: clip(body.posting.location, 160) || null,
        // A link is kept whole or not at all (a cut URL is a broken one).
        url: body.posting.url && body.posting.url.length <= 2048 && /^https?:\/\//i.test(body.posting.url.trim()) ? body.posting.url.trim() : null,
      }
    : null;
  const role = clip(body.role, 200) || posting?.title || (jdText ? inferRoleFromJd(jdText) : '');
  return {
    role,
    company: clip(body.company, 120) || posting?.company || null,
    industry: clip(body.industry, 80) || null,
    jobId: null,
    jdText,
    posting,
    countryHint: countryFromLocation(posting?.location),
  };
}

export async function planInterview(
  input: { userId: string; userName?: string | null; brand: ProductBrand; locale: string; body: PrepPlanBody; requestId?: string },
  deps: PlannerDeps = defaultPlannerDeps,
): Promise<PrepPlan> {
  const market: FormatMarket = input.brand.market === 'cn' ? 'cn' : 'intl';
  const target = await resolvePlannerTarget({ userId: input.userId, body: input.body, market }, deps);
  const ctx = await deps.marketContext({ userId: input.userId, brand: input.brand, locale: input.locale, countryHint: target.countryHint });
  const durationMinutes = input.body.durationMinutes ?? 20;
  const sessionLanguage = clip(input.body.language, 10) || input.locale;
  const domain = resolveDomainExpert(undefined, target.role, target.jdText);
  const thinPost = (target.jdText ?? '').length < THIN_POST_CHARS;

  const [companyStyle, evidence, resumeContext]: [PrepCompanyStyle | null, { text: string; sources: PrepSource[] }, string | null] = await Promise.all([
    target.company
      ? deps.companyStyle({ company: target.company, role: target.role, locale: input.locale, ctx, requestId: input.requestId })
      : Promise.resolve(null),
    thinPost && target.role
      ? deps.roleEvidence(target.role, ctx).catch(() => ({ text: '', sources: [] }))
      : Promise.resolve({ text: '', sources: [] }),
    deps.loadResume(input.userId, target.jobId, [input.userName ?? ''].filter(Boolean)).catch(() => null),
  ]);

  const base = {
    v: 1 as const,
    role: target.role,
    company: target.company,
    industry: target.industry,
    market: ctx.marketKey,
    language: input.locale,
    jobId: target.jobId,
    posting: target.posting,
    companyStyle,
    domain: domain ? { key: domain.key, label: domain.labelEn } : null,
    sources: [...(companyStyle?.sources ?? []), ...evidence.sources].slice(0, 8),
    generatedAt: new Date().toISOString(),
  };

  try {
    const raw = await deps.plan(
      {
        role: target.role,
        company: target.company,
        industry: target.industry,
        locale: input.locale,
        sessionLanguage,
        durationMinutes,
        marketSummary: renderMarketSummary(ctx.marketKey),
        jdText: target.jdText,
        webEvidence: evidence.text || null,
        companyStyle: companyStyle ? describeCompanyStyle(companyStyle) : null,
        domain: domainBrief(domain),
        resumeContext,
        skillIndex: renderSkillIndex(ctx.formatMarket),
      },
      input.requestId,
    );
    const interviewers = cleanInterviewers(raw.interviewers);
    const focuses = cleanFocuses(raw.focuses, ctx.formatMarket);
    if (interviewers.length < 2 || focuses.length < 2) throw new Error('planner returned too few interviewers or focuses');
    const recommended = settle(interviewers, focuses, raw.recommended);
    const requirements = cleanRequirements(raw.requirements);
    logger.info('INTERVIEW_PREP', 'interview plan ready', {
      requestId: input.requestId,
      market: ctx.marketKey,
      company: Boolean(target.company),
      companyBasis: companyStyle?.basis ?? null,
      fromPost: Boolean(target.jdText),
      interviewers: interviewers.length,
      focuses: focuses.length,
    });
    return { ...base, requirements, interviewers, focuses, recommended, strategy: cleanStrategy(raw.strategy) };
  } catch (err) {
    logger.warn('INTERVIEW_PREP', 'interview planner failed; catalog fallback', {
      requestId: input.requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    const panel = fallbackPanel(domain, ctx.formatMarket);
    return {
      ...base,
      // Nothing model-written: the brief shows no requirements rather than untranslated catalog text.
      requirements: cleanRequirements(null),
      interviewers: panel.interviewers,
      focuses: panel.focuses,
      recommended: settle(panel.interviewers, panel.focuses, null),
      strategy: cleanStrategy(null),
      fallback: true,
    };
  }
}
