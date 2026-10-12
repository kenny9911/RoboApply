// server/src/interview-engine/prep/companyStyle.ts
//
// How a company interviews, researched on demand: public searches (the role's
// interview process, the company's own hiring pages, and the job market's own
// language when it is not English), then CompanyStyleAgent
// writes the style ONLY from those results and expresses it in the interview
// patterns (skills/patterns.ts) the practice will run.
//
// Honesty rules (D3, no fabrication):
//   - "From public sources" (basis 'sources') is said only with sources to
//     show; the agent must cite the results it used, and an answer that cites
//     none is downgraded to 'general'.
//   - With nothing reliable found, the style is the usual practice for this
//     kind of company and role, labelled as such — never attributed to the
//     company.
//   - Queries carry the company name and a role title only.
//
// Cached per brand, company, field and language for a week: a company's loop
// changes slowly, and the next candidate for the same company gets it at once.

import { logger } from '../../services/LoggerService.js';
import { classifyDomain } from '../catalog/domainExperts.js';
import { INTERVIEW_PATTERN_KEYS, INTERVIEW_PATTERNS } from '../skills/index.js';
import { createTtlCache, keyPart } from './cache.js';
import { clip, cleanCompanyStyle, type PrepCompanyStyle } from './contract.js';
import { companyStyleAgent } from './agents.js';
import { formatResults, searchWeb, type WebResult } from './webSearch.js';
import type { PrepMarketContext } from './marketContext.js';

const STYLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STYLE_AGENT_TIMEOUT_MS = 45_000;

const styleCache = createTtlCache<PrepCompanyStyle | null>({ ttlMs: STYLE_TTL_MS, max: 1000 });

/** Test seam. */
export function clearCompanyStyleCache(): void {
  styleCache.clear();
}

/** The market-language query (the English one is always asked too). */
export function marketLanguageQuery(company: string, role: string, marketKey: string): string | null {
  const c = clip(company, 80);
  const r = clip(role, 80);
  switch (marketKey) {
    case 'cn':
      return `${c} ${r} 面试流程 面经 几轮`;
    case 'tw':
      return `${c} ${r} 面試 流程 心得`;
    case 'jp':
      return `${c} ${r} 面接 選考フロー 体験談`;
    case 'kr':
      return `${c} ${r} 면접 후기 전형`;
    case 'de':
      return `${c} ${r} Vorstellungsgespräch Ablauf Erfahrungen`;
    case 'fr':
      return `${c} ${r} entretien d'embauche déroulement`;
    case 'es':
      return `${c} ${r} entrevista de trabajo proceso de selección`;
    case 'br':
      return `${c} ${r} entrevista processo seletivo etapas`;
    default:
      return null;
  }
}

export function renderPatternIndex(): string {
  return INTERVIEW_PATTERN_KEYS.map((key) => `- ${key}: ${INTERVIEW_PATTERNS[key].labelEn} — ${INTERVIEW_PATTERNS[key].summary}`).join('\n');
}

export interface CompanyStyleDeps {
  search: (query: string, ctx: PrepMarketContext) => Promise<WebResult[] | null>;
  write: (input: Parameters<typeof companyStyleAgent.run>[0], requestId?: string) => Promise<Record<string, unknown>>;
}

export const defaultCompanyStyleDeps: CompanyStyleDeps = {
  // 'basic' depth: a few seconds per query; the two queries run side by side.
  search: (query, ctx) => searchWeb(ctx.brand, query, { maxResults: 6, depth: 'basic' }, { timeoutMs: 7000 }),
  write: (input, requestId) => companyStyleAgent.run(input, { requestId, signal: AbortSignal.timeout(STYLE_AGENT_TIMEOUT_MS) }),
};

/**
 * The researched style, or null when the company name is empty or the agent
 * could not answer (the plan then runs without a company style).
 */
export async function researchCompanyStyle(
  input: { company: string; role: string; locale: string; ctx: PrepMarketContext; requestId?: string },
  deps: CompanyStyleDeps = defaultCompanyStyleDeps,
): Promise<PrepCompanyStyle | null> {
  const company = clip(input.company, 120);
  if (!company) return null;
  const role = clip(input.role, 160);
  const field = classifyDomain(role)?.key ?? 'general';
  const key = [input.ctx.brand.id, keyPart(company), field, input.locale, input.ctx.marketKey].join('|');

  return styleCache.getOrCompute(
    key,
    async () => {
      const quoted = `"${company.replace(/"/g, '')}"`;
      const queries = [
        `${quoted} ${role || 'interview'} interview process rounds questions`,
        // Many employers publish their own hiring steps and interview advice.
        `${quoted} careers how we hire interview process tips for candidates`,
      ];
      const local = marketLanguageQuery(company, role, input.ctx.marketKey);
      if (local) queries.push(local);
      const answers = await Promise.all(queries.map((query) => deps.search(query, input.ctx).catch(() => null)));
      // Interleave the queries' results, so the company's own pages are not
      // crowded out by the first query's results.
      const seen = new Set<string>();
      const results: WebResult[] = [];
      const lists = answers.map((list) => list ?? []);
      for (let rank = 0; rank < Math.max(0, ...lists.map((list) => list.length)); rank += 1) {
        for (const list of lists) {
          const result = list[rank];
          if (!result || seen.has(result.url)) continue;
          seen.add(result.url);
          results.push(result);
        }
      }
      const evidenceResults = results.slice(0, 8);
      try {
        const raw = await deps.write(
          {
            company,
            role,
            marketLabel: input.ctx.marketLabel,
            locale: input.locale,
            evidence: formatResults(evidenceResults),
            patternIndex: renderPatternIndex(),
          },
          input.requestId,
        );
        const cited = (Array.isArray(raw.sourceIds) ? raw.sourceIds : [])
          .map((value) => (typeof value === 'number' ? value : Number.parseInt(String(value), 10)))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= evidenceResults.length)
          .map((n) => evidenceResults[n - 1]);
        const style = cleanCompanyStyle({
          ...raw,
          company,
          sources: cited.map((result) => ({ title: result.title, url: result.url })),
          basis: raw.basis === 'sources' && cited.length > 0 ? 'sources' : 'general',
          // A general style describes no company-specific stages or published values.
          ...(raw.basis === 'sources' && cited.length > 0 ? {} : { stages: [], values: [] }),
        });
        logger.info('INTERVIEW_PREP', 'company style researched', {
          requestId: input.requestId,
          results: evidenceResults.length,
          cited: cited.length,
          basis: style?.basis ?? 'none',
          patterns: style?.patterns.length ?? 0,
        });
        return style;
      } catch (err) {
        logger.warn('INTERVIEW_PREP', 'company style agent failed', {
          requestId: input.requestId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    // A failed or empty research is not remembered: the next setup tries again.
    { cacheIf: (value) => value !== null },
  ).catch(() => null);
}

export { describeCompanyStyle } from './contract.js';
