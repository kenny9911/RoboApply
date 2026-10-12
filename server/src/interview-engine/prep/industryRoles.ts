// server/src/interview-engine/prep/industryRoles.ts
//
// The roles an industry hires, for a candidate browsing by industry: a listed
// industry (industries.ts) or one they typed. Written by IndustryRolesAgent
// for the job market and the candidate's language, cached for a month (an
// industry's main roles do not change week to week).

import { logger } from '../../services/LoggerService.js';
import { createTtlCache, keyPart } from './cache.js';
import { industryRolesAgent } from './agents.js';
import { industryTextEn } from './industries.js';
import type { PrepRoleSuggestion } from './contract.js';
import type { PrepMarketContext } from './marketContext.js';

const ROLES_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ROLES_TIMEOUT_MS = 25_000;

const rolesCache = createTtlCache<PrepRoleSuggestion[]>({ ttlMs: ROLES_TTL_MS, max: 600 });

/** Test seam. */
export function clearIndustryRolesCache(): void {
  rolesCache.clear();
}

export type IndustryRolesWriter = (input: { industry: string; locale: string; marketLabel: string }, requestId?: string) => Promise<Array<{ title: string; titleEn: string; context: string }>>;

const defaultWriter: IndustryRolesWriter = async (input, requestId) =>
  (await industryRolesAgent.run(input, { requestId, signal: AbortSignal.timeout(ROLES_TIMEOUT_MS) })).roles;

/** Null when the industry text is empty or the agent could not answer. */
export async function rolesForIndustry(
  input: { industry: string; locale: string; ctx: PrepMarketContext; requestId?: string },
  write: IndustryRolesWriter = defaultWriter,
): Promise<PrepRoleSuggestion[] | null> {
  const industry = industryTextEn(input.industry);
  if (!industry) return null;
  const key = [keyPart(industry), input.locale, input.ctx.marketKey].join('|');
  try {
    return await rolesCache.getOrCompute(
      key,
      async () => {
        const roles = await write({ industry, locale: input.locale, marketLabel: input.ctx.marketLabel }, input.requestId);
        return roles.map((role) => ({
          title: role.title,
          titleEn: role.titleEn && role.titleEn !== role.title ? role.titleEn : null,
          source: 'ai' as const,
          context: role.context || null,
        }));
      },
      { cacheIf: (roles) => roles.length > 0 },
    );
  } catch (err) {
    logger.warn('INTERVIEW_PREP', 'industry roles failed', {
      requestId: input.requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
