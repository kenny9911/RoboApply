// server/src/features/network/index.ts — public surface of NET (FND-5; owner WP-54).
//
// Seams:
//   networkService.connectionsForJob(userId, jobId)   the Assistant's find_connections tool (WP-50)
//                                                     and the job page's People tab (PeoplePanel)
//   networkService.createOutreachDraft(userId, body, idempotencyKey)
//                                                     the Assistant's draft_outreach proposal: the same
//                                                     path as POST /outreach-drafts (GoApply phone gate,
//                                                     AI gate, one `outreach` credit, replay-safe on the key)
//   getNetworkService()                               the full service (imports, contacts, drafts)
//   runContactsSync                                   the contacts-sync cron (cron.ts)

import { creditService } from '../../platform/credits/index.js';
import { aiAllowed } from '../../platform/consent/aiAllowed.js';
import { hiringContactsMode, isEnabled, loadUserFlagOverrides } from '../../platform/flags.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import { LLM_PII_KINDS, redactPii } from '../../platform/pii/index.js';
import { getCurrentRequestId } from '../../lib/requestContext.js';
import { getTaskModel } from '../../lib/llm/llmTaskSettings.js';
import { normalizeCompanyName } from '../jobs/normalize/index.js';
import { peopleSearchLinks } from '../jobs/detail/index.js';
import { cnPostingVisible } from '../cn/jobs/index.js';
import { resumeForLlm } from '../resume/index.js';
import type { ConnectionsForJobResponse, OutreachChannel, OutreachDraftView } from './contract.js';
import { NetworkService, type NetworkDeps } from './service.js';
import { createPrismaNetworkStore } from './store.js';

export * from './contract.js';
export { createNetworkRouter, requireHiringContactsOn } from './routes.js';
export { NetworkService, hasOptInRecord, optedInAtOf } from './service.js';
export type { NetworkDeps } from './service.js';
export type { NetworkStore } from './store.js';
export { parseLinkedInConnections, type ParsedConnection } from './connectionsCsv.js';
export { runContactsSync } from './cron.js';

/** AI for outreach drafts: the user's AI consent AND the brand's text model (R-13). */
export async function outreachAiAvailable(userId: string): Promise<boolean> {
  if (!(await aiAllowed(userId))) return false;
  return isEnabled('ai.text', { userId });
}

export function defaultNetworkDeps(): NetworkDeps {
  return {
    store: createPrismaNetworkStore(),
    credits: creditService,
    brand: () => getCurrentBrandOrDefault(),
    mode: async (userId) => hiringContactsMode(getCurrentBrandOrDefault(), process.env, await loadUserFlagOverrides(userId)),
    aiAvailable: outreachAiAvailable,
    postingVisible: (job, userId) => cnPostingVisible(job, userId),
    peopleContext: async (userId) => {
      const { profileService } = await import('../profile/index.js');
      const p = await profileService.get(userId);
      return { pastCompanies: p.experience.map((e) => e.company), schools: p.education.map((e) => e.school) };
    },
    peopleSearchLinks: (job, ctx, market) => peopleSearchLinks(job, ctx, market),
    normalizeCompany: (name) => normalizeCompanyName(name),
    jobPoster: async (bank, externalId) => {
      const [{ bankClients }, { bankJobPosterReader }] = await Promise.all([import('../jobs/ingest/index.js'), import('./contactsSync.js')]);
      return bankJobPosterReader(bankClients)(bank, externalId);
    },
    profileText: async (userId) => {
      const { profileSnapshotForLlm } = await import('../profile/index.js');
      return (await profileSnapshotForLlm(userId)).text;
    },
    // resumeForLlm drops the name/contact header and sensitive lines; redactPii removes what is left.
    resumeForPrompt: (markdown) => redactPii(resumeForLlm(markdown), { kinds: LLM_PII_KINDS }).text,
    redact: (text) => redactPii(text, { kinds: LLM_PII_KINDS }).text,
    write: async (input) => {
      const { OutreachDraftAgent } = await import('./OutreachDraftAgent.js');
      return new OutreachDraftAgent().run(input, { requestId: getCurrentRequestId() ?? undefined });
    },
    modelId: () => {
      try {
        return getTaskModel('writing') ?? null;
      } catch {
        return null;
      }
    },
    logAiLabel: async ({ userId, draftId, model, brand }) => {
      const { logAiContentLabel, newAiContentId } = await import('../compliance/index.js');
      const parts = (model ?? '').split('/').filter(Boolean);
      const provider = parts.length > 1 ? parts[parts.length - 2]! : parts[0] ?? 'llm';
      await logAiContentLabel({ userId, contentId: newAiContentId(brand.id), kind: 'outreach_draft', provider, artifactId: draftId, brand: brand.id });
    },
  };
}

let singleton: NetworkService | null = null;

/** The process-wide network service (Prisma store, platform credits). */
export async function getNetworkService(): Promise<NetworkService> {
  singleton ??= new NetworkService(defaultNetworkDeps());
  return singleton;
}

/** Test seam: replace (or reset with null) the process-wide service. */
export function setNetworkServiceForTests(service: NetworkService | null): void {
  singleton = service;
}

/** What another area may ask for when it starts a draft (the Assistant's proposal). */
export interface CreateOutreachDraftInput {
  jobId: string;
  channel: OutreachChannel;
  contactId?: string;
  trackerEntryId?: string;
  locale?: string;
}

export interface NetworkServiceSeam {
  connectionsForJob(userId: string, jobId: string): Promise<ConnectionsForJobResponse>;
  /**
   * Write one outreach draft for the user to send themselves (D1: nothing is
   * sent). Same rules as the route: GoApply needs a bound phone, the AI gate
   * runs before any credit or model call (503 ai_unavailable), one `outreach`
   * credit, and a replayed `idempotencyKey` returns the first draft.
   */
  createOutreachDraft(userId: string, body: CreateOutreachDraftInput, idempotencyKey: string): Promise<OutreachDraftView>;
}

/** GoApply: AI actions need a bound phone (the route's `requirePhoneBound`). */
async function assertPhoneBoundOnCn(userId: string): Promise<void> {
  if (getCurrentBrandOrDefault().market !== 'cn') return;
  const { assertPhoneBound } = await import('../auth-cn/index.js');
  await assertPhoneBound(userId);
}

export const networkService: NetworkServiceSeam = {
  async connectionsForJob(userId, jobId) {
    return (await getNetworkService()).connectionsForJob(userId, jobId);
  },
  async createOutreachDraft(userId, body, idempotencyKey) {
    await assertPhoneBoundOnCn(userId);
    return (await getNetworkService()).createDraft(userId, body, { idempotencyKey, requestLocale: body.locale ?? null });
  },
};
