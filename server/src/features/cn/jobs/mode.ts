// server/src/features/cn/jobs/mode.ts — GoApply recruitment-info mode (D5, GOAPPLY_PARITY_PLAN §3.2; CN L-4).
//
// `CN_RECRUITMENT_INFO_MODE = off | partner_deeplink | licensed`. The feed is
// ON by default: unset (and any unknown value) resolves to `licensed`; only
// the literal `off` closes it (the operator's kill switch). This supersedes
// TASK_PLAN R-14, whose default was `off`.
// The capability keys `jobs.feed`, `jobs.recommendations` and `jobs.alerts`
// already follow the mode in platform/flags.ts (one resolver, R-04); this
// module adds what the job readers need on top of the flags:
//
//   - `cnJobCapabilities(env)`   the mode, the three capabilities, how apply
//                                opens and the GoHire licence line (env-set only:
//                                no licence line unless CN_HR_LICENCE_HOLDER and
//                                CN_HR_LICENCE_NUMBER are both set, D3);
//   - `isThirdPartyPosting(job)` any posting that is not the user's own import;
//   - `cnPostingVisible(job, viewerId, env)` / `filterCnPostings(...)` /
//     `assertCnPostingVisible(...)` per-row checks for readers that are not
//     flag-gated as a whole (job detail, company jobs, tracker job cards);
//   - `cnPostingsWhere(viewerId, env)` the Prisma `where` fragment for list
//     queries over GoApply jobs;
//   - `requireCnRecruitmentInfo(env)` middleware: GoApply + mode off → 404
//     feature_disabled (RoboApply passes through).
// With the mode set to `off` GoApply is a seeker toolkit: the user's own
// imported jobs, resume, tracker, practice. No third-party posting reaches a
// GoApply user while the switch is off.

import type { RequestHandler } from 'express';
import { getCurrentBrandOrDefault, type EnvSource, type ProductBrand } from '../../../platform/brand/index.js';
import { cnRecruitmentInfoMode, type CnRecruitmentInfoMode } from '../../../platform/flags.js';
import { HttpError, fail } from '../../../platform/http.js';

export type { CnRecruitmentInfoMode };

/** The mode from env (default `licensed`; `off` only for the literal `off`). */
export function cnRecruitmentMode(env: EnvSource = process.env): CnRecruitmentInfoMode {
  return cnRecruitmentInfoMode(env);
}

export interface CnJobCapabilities {
  mode: CnRecruitmentInfoMode;
  /** Third-party postings (employer boards, GoHire bank, partner feeds) may be shown, recommended and alerted. */
  postings: boolean;
  feed: boolean;
  recommendations: boolean;
  alerts: boolean;
  /** partner_deeplink: apply opens the partner (GoHire) page; licensed / off: the posting's own apply link. */
  applyVia: 'partner' | 'source';
  /** GoHire's HR-service licence line; null unless both env values are set (D3: never a made-up licence). */
  licence: { holder: string; number: string } | null;
}

function envValue(env: EnvSource, key: string): string | null {
  const v = env[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** What the mode allows. On by default (D5); everything is false only with the mode set to `off`. */
export function cnJobCapabilities(env: EnvSource = process.env): CnJobCapabilities {
  const mode = cnRecruitmentMode(env);
  const on = mode !== 'off';
  const holder = envValue(env, 'CN_HR_LICENCE_HOLDER');
  const number = envValue(env, 'CN_HR_LICENCE_NUMBER');
  return {
    mode,
    postings: on,
    feed: on,
    recommendations: on,
    alerts: on,
    applyVia: mode === 'partner_deeplink' ? 'partner' : 'source',
    licence: on && holder && number ? { holder, number } : null,
  };
}

/** The fields the per-row checks read. */
export interface CnPostingLike {
  market?: unknown;
  visibility?: unknown;
  ownerUserId?: unknown;
  provider?: unknown;
  sourceBoard?: unknown;
}

/** True for every posting that is not a user's own import (GoHire bank, partner feeds, campus listings…). */
export function isThirdPartyPosting(job: CnPostingLike): boolean {
  if (job.provider === 'user_import') return false;
  return job.visibility !== 'private';
}

/**
 * May this viewer see this GoApply job? A user's own import: always, and only
 * its owner. A third-party posting: only when the mode allows postings.
 * Non-cn jobs are not this module's concern (true).
 */
export function cnPostingVisible(job: CnPostingLike, viewerId: string | null | undefined, env: EnvSource = process.env): boolean {
  if (job.market !== 'cn') return true;
  if (!isThirdPartyPosting(job)) return Boolean(viewerId) && job.ownerUserId === viewerId;
  return cnJobCapabilities(env).postings;
}

/** `cnPostingVisible` over a list (order kept). */
export function filterCnPostings<T extends CnPostingLike>(jobs: readonly T[], viewerId: string | null | undefined, env: EnvSource = process.env): T[] {
  return jobs.filter((j) => cnPostingVisible(j, viewerId, env));
}

/** Throws 404 not_found when the viewer may not see the job (same answer as a missing job: no existence leak). */
export function assertCnPostingVisible(job: CnPostingLike, viewerId: string | null | undefined, env: EnvSource = process.env): void {
  if (!cnPostingVisible(job, viewerId, env)) throw new HttpError('not_found');
}

/**
 * Prisma `where` fragment for list queries over GoApply (`market: 'cn'`)
 * jobs: mode off → only the viewer's own imports; otherwise public postings
 * plus the viewer's own imports. Combine with the caller's other filters via AND.
 */
export function cnPostingsWhere(
  viewerId: string | null | undefined,
  env: EnvSource = process.env,
): { OR: Array<Record<string, unknown>> } {
  const own = viewerId ? [{ visibility: 'private', ownerUserId: viewerId }] : [];
  if (!cnJobCapabilities(env).postings) return { OR: own.length ? own : [{ id: { in: [] as string[] } }] };
  return { OR: [{ visibility: 'public' }, ...own] };
}

/**
 * Middleware for routes that only ever return third-party postings (feed,
 * recommendations, alerts, public job pages): on GoApply with mode off it
 * answers 404 feature_disabled. Routes that also serve the user's own imports
 * use the per-row checks instead.
 */
export function requireCnRecruitmentInfo(options: { env?: EnvSource; brand?: () => ProductBrand } = {}): RequestHandler {
  return (req, res, next) => {
    const brand = options.brand ? options.brand() : ((req as typeof req & { brand?: ProductBrand }).brand ?? getCurrentBrandOrDefault());
    if (brand.market === 'cn' && !cnJobCapabilities(options.env ?? process.env).postings) {
      fail(res, 'feature_disabled');
      return;
    }
    next();
  };
}
