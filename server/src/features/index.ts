// server/src/features/index.ts — mounts every feature area (FND-5; TASK_PLAN.md §4.1.a).
//
// `server/src/app.ts` calls `mountFeatures(app)` ONCE, AFTER the legacy
// routers (/auth, /missions, /runs, /digest, /settings, /billing, /account,
// /v2, job-search, interview-engine), so every live legacy path keeps its
// handler. Rules every area router follows:
//   - declare only paths that do not exist today (never shadow a live path);
//   - capability checks per route (`requireFlag(key)` after auth), never
//     `router.use(requireFlag)` on a shared prefix;
//   - stub handlers parse input with the area's contract and answer
//     501 not_implemented until the owner fills them; they are tagged with
//     `markStub` (platform/http.ts), so the route-harness guard
//     (features.test.ts) checks 501 only while a handler is still a stub —
//     a filled route drops out of that check with no edit here;
//   - admin routers sit at /api/v1/roboapply/admin/<area> behind
//     requireAuth + requireAdmin.
// `/api/v1/public/brand` (FND-2a) is mounted by app.ts itself and is not here.
//
// FEATURE_MOUNTS is the single mount table; tests iterate it (one
// route-harness check per router). `FeatureRouterDeps` lets tests inject the
// auth chains and the env used by the capability checks.

import type { Express, RequestHandler, Router } from 'express';
import type { EnvSource } from '../platform/brand/brandEnv.js';
import { createUiStateRouter } from './uistate/routes.js';
import { createAccountRouter, createAuthRouter } from './auth/routes.js';
import { createAuthCnAdminRouter, createPhoneAuthRouter, createWechatAuthRouter } from './auth-cn/routes.js';
import { createComplianceAdminRouter, createComplianceRouter, createLegalPublicRouter } from './compliance/routes.js';
import { createOnboardingRouter } from './onboarding/routes.js';
import { createOnboardingCnRouter } from './onboarding-cn/routes.js';
import { createProfileRouter } from './profile/routes.js';
import { createSearchProfilesRouter, createTaxonomyRouter } from './search/routes.js';
import { createFeedRouter } from './feed/routes.js';
import { createPublicFeedRouter } from './feed/publicRoutes.js';
import { createJobImportRouter } from './jobs/import/routes.js';
import { createJobDetailRouter } from './jobs/detail/routes.js';
import { createCompaniesRouter } from './jobs/companies/routes.js';
import { createCareerSourcesAdminRouter } from './jobs/sources/atsPublic/routes.js';
import { createMatchRouter } from './match/routes.js';
import { createCopilotRouter } from './copilot/routes.js';
import { createResumeSuiteRouter } from './resume/routes.js';
import { createCoverLetterRouter } from './coverletter/routes.js';
import { createTrackerRouter } from './tracker/routes.js';
import { createOffersRouter } from './offers/routes.js';
import { createNetworkRouter } from './network/routes.js';
import { createCnReferralsAdminRouter, createCnReferralsRouter } from './cn/referrals/routes.js';
import { createAgentRouter } from './agent/routes.js';
import { createExtensionPublicRouter, createExtensionRouter } from './extension/routes.js';
import { createBillingPlansRouter, createCreditsRouter, createPublicCancelRouter } from './credits/routes.js';
import { createCreditsAdminRouter } from './credits/adminRoutes.js';
import { createWechatPayNotifyRouter, createWechatPayRouter } from './billing-cn/routes.js';
import { createEmailPublicRouter, createNotificationsRouter } from './notifications/routes.js';
import { createPushRouter } from './push/routes.js';
import { createAnnouncementsRouter } from './announcements/routes.js';
import { createAnnouncementsAdminRouter } from './announcements/adminRoutes.js';
import { createGrowthRouter, createInvitesRouter } from './growth/routes.js';
import { createEventsPublicRouter } from './growth/publicRoutes.js';
import { createInterviewBankRouter } from './prep/routes.js';
import { createPrepAdminRouter } from './prep/adminRoutes.js';
import { createCoachingRouter } from './coaching/routes.js';
import { createCoachingAdminRouter } from './coaching/adminRoutes.js';
import { createSeoPublicRouter } from './seo/routes.js';
import { createToolsPublicRouter } from './tools/routes.js';
import { createCnJobsAdminRouter, createCnJobsRouter } from './cn/jobs/routes.js';
import { createCampusAdminRouter, createCampusEventsRouter, createCampusPublicRouter } from './cn/campus/routes.js';
import { createNotifyCnRouter, createWechatMpWebhookRouter } from './notify-cn/routes.js';
import { createSupportRouter } from './support/routes.js';
import { createVisitorAlertsRouter, createVisitorCopilotRouter } from './visitor/routes.js';
import { createStudentRouter, createTwoFactorRouter } from './account-v2/routes.js';
import { createAdminConsoleRouter } from './admin/routes.js';

/** Injection points for feature routers (defaults are the production chains). */
export interface FeatureRouterDeps {
  /** Seeker session chain (default: requireAuth + requireSeekerProfile). */
  seekerAuth?: readonly RequestHandler[];
  /** Admin chain (default: requireAuth + requireAdmin). */
  adminAuth?: readonly RequestHandler[];
  /** S/P routes (default: optionalAuth). */
  optionalAuth?: readonly RequestHandler[];
  /** Extension device chain (default: extension/routes requireExtensionDevice). */
  extensionAuth?: readonly RequestHandler[];
  /** Env the capability checks read (default: process.env). */
  env?: EnvSource;
}

export const SEEKER_API = '/api/v1/roboapply';
export const ADMIN_API = '/api/v1/roboapply/admin';
export const PUBLIC_API = '/api/v1/public';
export const WEBHOOK_API = '/api/v1/webhooks';

export type FeatureMountKind = 'seeker' | 'public' | 'admin' | 'webhook';

export interface FeatureMount {
  /** Stable id: `<area>` or `<area>.<router>`. */
  id: string;
  /** Owning area folder under server/src/features/. */
  area: string;
  /** Full mount path. */
  path: string;
  kind: FeatureMountKind;
  /** Owner WP that fills the router (TASK_PLAN.md §4.1.a). */
  owner: string;
  build: (deps: FeatureRouterDeps) => Router;
}

const s = (p: string) => `${SEEKER_API}${p}`;
const a = (p: string) => `${ADMIN_API}${p}`;
const pub = (p: string) => `${PUBLIC_API}${p}`;
const hook = (p: string) => `${WEBHOOK_API}${p}`;

/**
 * The mount table, in mount order. Order matters only where prefixes nest:
 * `/jobs/import` precedes `/jobs`; `/auth` and `/account` precede their
 * `/auth/phone`, `/auth/wechat`, `/account/2fa`, `/account/student` children
 * (the parent routers declare none of those paths, so requests fall through).
 */
export const FEATURE_MOUNTS: readonly FeatureMount[] = [
  { id: 'uistate', area: 'uistate', path: s('/ui-state'), kind: 'seeker', owner: 'FND-3', build: (d) => createUiStateRouter({ auth: d.seekerAuth }) },

  { id: 'auth', area: 'auth', path: s('/auth'), kind: 'seeker', owner: 'WP-10', build: createAuthRouter },
  { id: 'auth.account', area: 'auth', path: s('/account'), kind: 'seeker', owner: 'WP-10', build: createAccountRouter },
  { id: 'auth-cn.phone', area: 'auth-cn', path: s('/auth/phone'), kind: 'seeker', owner: 'WP-11', build: createPhoneAuthRouter },
  { id: 'auth-cn.wechat', area: 'auth-cn', path: s('/auth/wechat'), kind: 'public', owner: 'WP-11', build: createWechatAuthRouter },
  { id: 'auth-cn.admin', area: 'auth-cn', path: a('/auth-cn'), kind: 'admin', owner: 'WP-11', build: createAuthCnAdminRouter },
  { id: 'account-v2.2fa', area: 'account-v2', path: s('/account/2fa'), kind: 'seeker', owner: 'WP-79', build: createTwoFactorRouter },
  { id: 'account-v2.student', area: 'account-v2', path: s('/account/student'), kind: 'seeker', owner: 'WP-79', build: createStudentRouter },

  { id: 'compliance', area: 'compliance', path: s('/compliance'), kind: 'seeker', owner: 'WP-13', build: createComplianceRouter },
  { id: 'compliance.legal', area: 'compliance', path: pub('/legal'), kind: 'public', owner: 'WP-13', build: createLegalPublicRouter },
  { id: 'compliance.admin', area: 'compliance', path: a('/compliance'), kind: 'admin', owner: 'WP-13', build: createComplianceAdminRouter },

  // GoApply G1–G7 data (schools, provinces, market snapshot, defaults); mounted at the Wave 3 gate (WP-31 request).
  { id: 'onboarding-cn', area: 'onboarding-cn', path: s('/onboarding/cn'), kind: 'seeker', owner: 'WP-31', build: createOnboardingCnRouter },
  { id: 'onboarding', area: 'onboarding', path: s('/onboarding'), kind: 'seeker', owner: 'WP-30', build: createOnboardingRouter },
  { id: 'profile', area: 'profile', path: s('/profile'), kind: 'seeker', owner: 'WP-19', build: createProfileRouter },
  { id: 'search.profiles', area: 'search', path: s('/search-profiles'), kind: 'seeker', owner: 'WP-20', build: createSearchProfilesRouter },
  { id: 'search.taxonomy', area: 'search', path: s('/taxonomy'), kind: 'seeker', owner: 'WP-20', build: createTaxonomyRouter },

  { id: 'feed', area: 'feed', path: s('/feed'), kind: 'seeker', owner: 'WP-32', build: createFeedRouter },
  { id: 'feed.public', area: 'feed', path: pub('/feed'), kind: 'public', owner: 'WP-78', build: createPublicFeedRouter },
  { id: 'jobs.import', area: 'jobs/import', path: s('/jobs/import'), kind: 'seeker', owner: 'WP-35', build: createJobImportRouter },
  { id: 'jobs.detail', area: 'jobs/detail', path: s('/jobs'), kind: 'seeker', owner: 'WP-34', build: createJobDetailRouter },
  { id: 'jobs.companies', area: 'jobs/companies', path: s('/companies'), kind: 'seeker', owner: 'WP-16b', build: createCompaniesRouter },
  { id: 'jobs.careerSources.admin', area: 'jobs/sources/atsPublic', path: a('/career-sources'), kind: 'admin', owner: 'WP-42', build: createCareerSourcesAdminRouter },
  { id: 'match', area: 'match', path: s('/match'), kind: 'seeker', owner: 'WP-18', build: createMatchRouter },

  { id: 'copilot', area: 'copilot', path: s('/copilot'), kind: 'seeker', owner: 'WP-50', build: createCopilotRouter },
  { id: 'resume', area: 'resume', path: s('/v2/resumes'), kind: 'seeker', owner: 'WP-22', build: createResumeSuiteRouter },
  { id: 'coverletter', area: 'coverletter', path: s('/cover-letters'), kind: 'seeker', owner: 'WP-37', build: createCoverLetterRouter },
  { id: 'tracker', area: 'tracker', path: s('/v2/tracker'), kind: 'seeker', owner: 'WP-38', build: createTrackerRouter },
  { id: 'offers', area: 'offers', path: s('/offers'), kind: 'seeker', owner: 'WP-64', build: createOffersRouter },
  { id: 'network', area: 'network', path: s('/network'), kind: 'seeker', owner: 'WP-54', build: createNetworkRouter },
  { id: 'cn.referrals', area: 'cn/referrals', path: s('/cn/referrals'), kind: 'seeker', owner: 'WP-54', build: createCnReferralsRouter },
  { id: 'agent', area: 'agent', path: s('/agent'), kind: 'seeker', owner: 'WP-52', build: createAgentRouter },
  { id: 'extension', area: 'extension', path: s('/ext'), kind: 'seeker', owner: 'WP-55a', build: createExtensionRouter },
  { id: 'extension.public', area: 'extension', path: pub('/ext'), kind: 'public', owner: 'WP-55a', build: createExtensionPublicRouter },

  { id: 'credits', area: 'credits', path: s('/credits'), kind: 'seeker', owner: 'WP-21a', build: createCreditsRouter },
  { id: 'credits.plans', area: 'credits', path: s('/billing/plans'), kind: 'public', owner: 'WP-21a', build: createBillingPlansRouter },
  { id: 'credits.cancel', area: 'credits', path: pub('/cancel'), kind: 'public', owner: 'WP-21a', build: createPublicCancelRouter },
  { id: 'credits.admin', area: 'credits', path: a('/credits'), kind: 'admin', owner: 'WP-21a', build: createCreditsAdminRouter },
  { id: 'billing-cn', area: 'billing-cn', path: s('/billing-cn/wechatpay'), kind: 'seeker', owner: 'WP-62', build: createWechatPayRouter },
  { id: 'billing-cn.notify', area: 'billing-cn', path: hook('/wechatpay'), kind: 'webhook', owner: 'WP-62', build: createWechatPayNotifyRouter },

  { id: 'notifications', area: 'notifications', path: s('/notifications'), kind: 'seeker', owner: 'WP-39b', build: createNotificationsRouter },
  { id: 'notifications.email', area: 'notifications', path: pub('/email'), kind: 'public', owner: 'WP-39b', build: createEmailPublicRouter },
  { id: 'push', area: 'push', path: s('/push'), kind: 'seeker', owner: 'WP-61', build: createPushRouter },
  { id: 'announcements', area: 'announcements', path: s('/announcements'), kind: 'seeker', owner: 'WP-61', build: createAnnouncementsRouter },
  { id: 'announcements.admin', area: 'announcements', path: a('/announcements'), kind: 'admin', owner: 'WP-61', build: createAnnouncementsAdminRouter },
  { id: 'growth.invites', area: 'growth', path: s('/invites'), kind: 'seeker', owner: 'WP-60', build: createInvitesRouter },
  { id: 'growth.events', area: 'growth', path: pub('/events'), kind: 'public', owner: 'WP-23', build: createEventsPublicRouter },
  { id: 'growth', area: 'growth', path: s('/growth'), kind: 'seeker', owner: 'WP-23', build: createGrowthRouter },
  { id: 'prep', area: 'prep', path: s('/interview-bank'), kind: 'seeker', owner: 'WP-59', build: createInterviewBankRouter },
  { id: 'prep.admin', area: 'prep', path: a('/prep'), kind: 'admin', owner: 'WP-59', build: createPrepAdminRouter },
  { id: 'coaching', area: 'coaching', path: s('/coaching'), kind: 'seeker', owner: 'WP-72', build: createCoachingRouter },
  { id: 'coaching.admin', area: 'coaching', path: a('/coaching'), kind: 'admin', owner: 'WP-72', build: createCoachingAdminRouter },
  { id: 'seo', area: 'seo', path: pub('/seo'), kind: 'public', owner: 'WP-56', build: createSeoPublicRouter },
  { id: 'tools', area: 'tools', path: pub('/tools'), kind: 'public', owner: 'WP-57', build: createToolsPublicRouter },

  { id: 'cn.jobs', area: 'cn/jobs', path: s('/cn/jobs'), kind: 'seeker', owner: 'WP-41', build: createCnJobsRouter },
  { id: 'cn.jobs.admin', area: 'cn/jobs', path: a('/cn/jobs'), kind: 'admin', owner: 'WP-41', build: createCnJobsAdminRouter },
  { id: 'cn.campus', area: 'cn/campus', path: s('/cn/campus-events'), kind: 'seeker', owner: 'WP-58', build: createCampusEventsRouter },
  { id: 'cn.campus.public', area: 'cn/campus', path: pub('/campus'), kind: 'public', owner: 'WP-58', build: createCampusPublicRouter },
  { id: 'cn.campus.admin', area: 'cn/campus', path: a('/cn/campus'), kind: 'admin', owner: 'WP-58', build: createCampusAdminRouter },
  // 内推码 moderation queue (WP-54 request, mounted at the Wave 4 gate; console UI is WP-74).
  { id: 'cn.referrals.admin', area: 'cn/referrals', path: a('/cn/referrals'), kind: 'admin', owner: 'WP-54', build: createCnReferralsAdminRouter },
  { id: 'notify-cn', area: 'notify-cn', path: s('/notify-cn'), kind: 'seeker', owner: 'WP-73', build: createNotifyCnRouter },
  { id: 'notify-cn.webhook', area: 'notify-cn', path: hook('/wechat-mp'), kind: 'webhook', owner: 'WP-73', build: createWechatMpWebhookRouter },

  { id: 'support', area: 'support', path: s('/support'), kind: 'public', owner: 'WP-40', build: createSupportRouter },
  { id: 'visitor.copilot', area: 'visitor', path: pub('/copilot'), kind: 'public', owner: 'WP-78', build: createVisitorCopilotRouter },
  { id: 'visitor.alerts', area: 'visitor', path: pub('/alerts'), kind: 'public', owner: 'WP-78', build: createVisitorAlertsRouter },

  { id: 'admin', area: 'admin', path: a(''), kind: 'admin', owner: 'WP-74', build: createAdminConsoleRouter },
];

/**
 * Mount every feature router on `app`. Call once, after the legacy routers.
 * Returns the mounted paths in order.
 */
export function mountFeatures(app: Express, deps: FeatureRouterDeps = {}): string[] {
  const mounted: string[] = [];
  for (const mount of FEATURE_MOUNTS) {
    app.use(mount.path, mount.build(deps));
    mounted.push(mount.path);
  }
  return mounted;
}
