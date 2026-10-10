// server/src/features/copilot/proposals.ts — apply / dismiss Assistant proposals (ARCH §5.5; WP-50).
//
// Every mutation the Assistant suggests is a proposal the user applies with a
// click. Applying:
//   - claims the proposal first (pending → applied, compare-and-set), so a
//     double click runs it once; a failure puts it back to pending;
//   - expires it after 24 h (409 conflict, reason proposal_expired);
//   - filter_change: applies the patch at `baseVersion`; when the saved
//     search changed meanwhile, marks it `conflict` and answers 409
//     version_conflict with a fresh `filter_diff` card (a new proposal);
//   - credit_action: runs the area service with the Idempotency-Key
//     `copilot:<proposalId>`; the area spends its own credit (tailor,
//     cover_letter, job_import, rewrite, outreach) only now;
//   - memory_add: GoApply needs a live `copilot_memory` consent (403), at
//     most 50 facts (409 memory_full; counted and stored under one lock).
// The card in the stored message gets the new status, and a result card
// (tailor_ready, cover_letter, job_imported, rewrite_ready; for an outreach
// draft a link to the job's People tab, where the draft is kept) is appended,
// both under a row lock on the message (store.updateCards).

import { HttpError } from '../../platform/http.js';
import type { Market, ProductBrand } from '../../platform/brand/registry.js';
import { logger } from '../../services/LoggerService.js';
import type { ManualJob } from '../jobs/import/index.js';
import { OUTREACH_CHANNELS, type OutreachChannel, type OutreachDraftView } from '../network/contract.js';
import {
  COPILOT_ERROR_CODES,
  COPILOT_MEMORY_MAX,
  CreditActionPayloadSchema,
  FilterChangePayloadSchema,
  MemoryAddPayloadSchema,
  PROPOSAL_TTL_MS,
  type ApplyProposalResponse,
  type CopilotCard,
  type CountView,
  type JobImportedCardData,
  type MemoryFactView,
  type OutreachDraftResult,
  type ProposalStatus,
} from './contract.js';
import type { CopilotStore, ProposalRow } from './store.js';
import { diffForOps, filterDiffCard, type FilterOp } from './tools/filters.js';
import { countView } from './tools/util.js';
import type { CopilotAreas } from './types.js';

export interface ProposalServiceDeps {
  store: CopilotStore;
  areas: CopilotAreas;
  brand: () => ProductBrand;
  now: () => Date;
  hasConsent: (userId: string, type: 'copilot_memory') => Promise<boolean>;
  newCardId: () => string;
}

export interface ProposalService {
  apply(userId: string, proposalId: string, options?: { baseVersion?: number; locale?: string }): Promise<ApplyProposalResponse>;
  dismiss(userId: string, proposalId: string): Promise<void>;
}

/** Status as the user sees it (a pending proposal past its expiry is expired). */
export function effectiveStatus(row: Pick<ProposalRow, 'status' | 'expiresAt'>, now: Date): ProposalStatus {
  if (row.status === 'pending' && row.expiresAt.getTime() <= now.getTime()) return 'expired';
  return row.status as ProposalStatus;
}

function messageIdOf(payload: unknown): string | null {
  const id = (payload as { messageId?: unknown } | null)?.messageId;
  return typeof id === 'string' && id ? id : null;
}

const memoryFull = () =>
  new HttpError('conflict', `The Assistant keeps at most ${COPILOT_MEMORY_MAX} facts. Delete one in Settings first.`, { reason: COPILOT_ERROR_CODES.memoryFull, max: COPILOT_MEMORY_MAX });

const isVersionConflict = (err: unknown) => (err as { code?: unknown } | null)?.code === 'version_conflict';

export function createProposalService(deps: ProposalServiceDeps): ProposalService {
  const { store, areas } = deps;

  async function load(userId: string, id: string): Promise<ProposalRow> {
    const row = await store.getProposal(id);
    if (!row || row.userId !== userId) throw new HttpError('not_found', 'This suggestion was not found.');
    const thread = await store.getThread(row.threadId);
    if (!thread || thread.brand !== deps.brand().id) throw new HttpError('not_found', 'This suggestion was not found.');
    return row;
  }

  /** Update the proposal card's status in the stored message, and append a result card. */
  async function syncCards(row: ProposalRow, status: ProposalStatus, extra: CopilotCard[] = []): Promise<void> {
    const messageId = messageIdOf(row.payload);
    if (!messageId) return;
    try {
      await store.updateCards(messageId, (cards) => [
        ...cards.map((c) =>
          c && typeof c.data === 'object' && c.data !== null && (c.data as { proposalId?: unknown }).proposalId === row.id ? { ...c, data: { ...(c.data as object), status } } : c,
        ),
        ...extra,
      ]);
    } catch (err) {
      logger.warn('COPILOT', 'could not update the proposal card', { proposalId: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function claim(row: ProposalRow): Promise<void> {
    const now = deps.now();
    if (row.status !== 'pending') {
      throw new HttpError('conflict', 'This suggestion was already used or dismissed.', { reason: COPILOT_ERROR_CODES.proposalClosed, status: row.status });
    }
    if (row.expiresAt.getTime() <= now.getTime()) {
      await store.transitionProposal(row.id, 'pending', 'expired', now);
      await syncCards(row, 'expired');
      throw new HttpError('conflict', 'This suggestion expired. Ask again for a fresh one.', { reason: COPILOT_ERROR_CODES.proposalExpired });
    }
    if (!(await store.transitionProposal(row.id, 'pending', 'applied', now))) {
      throw new HttpError('conflict', 'This suggestion was already used or dismissed.', { reason: COPILOT_ERROR_CODES.proposalClosed });
    }
  }

  async function unclaim(row: ProposalRow, to: ProposalStatus = 'pending'): Promise<void> {
    await store.transitionProposal(row.id, 'applied', to, deps.now());
  }

  async function applyFilter(userId: string, row: ProposalRow, market: Market): Promise<ApplyProposalResponse> {
    const payload = FilterChangePayloadSchema.parse(row.payload);
    const conflict = async (): Promise<never> => {
      await unclaim(row, 'conflict');
      await syncCards(row, 'conflict');
      const fresh = await areas.searchProfile(userId, payload.searchProfileId);
      const res = await diffForOps(areas, userId, fresh, payload.ops as FilterOp[], market);
      let card: CopilotCard | null = null;
      if (res.ok && res.diff.changes.length) {
        const expiresAt = new Date(deps.now().getTime() + PROPOSAL_TTL_MS);
        const next = await store.createProposal({
          threadId: row.threadId,
          userId,
          kind: 'filter_change',
          payload: { ...payload, baseVersion: fresh.version },
          expiresAt,
        });
        card = { type: 'filter_diff', id: deps.newCardId(), data: filterDiffCard({ proposalId: next.id, expiresAt, profile: fresh, diff: res.diff, ops: payload.ops as FilterOp[], reason: payload.reason ?? null, now: deps.now() }) };
        const messageId = messageIdOf(row.payload);
        if (messageId) await store.appendCard(messageId, card).catch(() => undefined);
      }
      throw new HttpError('version_conflict', 'Your saved search changed since this suggestion. Review the updated change.', { currentVersion: fresh.version, card });
    };

    const profile = await areas.searchProfile(userId, payload.searchProfileId);
    if (profile.version !== payload.baseVersion) return conflict();
    const diff = await diffForOps(areas, userId, profile, payload.ops as FilterOp[], market);
    if (!diff.ok) {
      await unclaim(row, 'conflict');
      await syncCards(row, 'conflict');
      throw new HttpError('invalid_request', 'This change no longer fits your saved search.', { issues: diff.issues });
    }
    let updated;
    try {
      updated = await areas.patchFilters(userId, payload.searchProfileId, payload.baseVersion, diff.diff.patch as Record<string, unknown>);
    } catch (err) {
      if (isVersionConflict(err)) return conflict();
      await unclaim(row);
      throw err;
    }
    await syncCards(row, 'applied');
    let countAfter: CountView | null = null;
    try {
      countAfter = countView(await areas.countForFilters(userId, updated.filters), deps.now());
    } catch {
      countAfter = null;
    }
    return { applied: true, result: { searchProfileId: updated.id, version: updated.version, filters: updated.filters, countAfter, before: profile.filters } };
  }

  async function applyCreditAction(userId: string, row: ProposalRow, locale: string | undefined): Promise<ApplyProposalResponse> {
    const payload = CreditActionPayloadSchema.parse(row.payload);
    const key = `copilot:${row.id}`;
    const args = payload.args as Record<string, unknown>;
    const str = (k: string): string | undefined => (typeof args[k] === 'string' && args[k] ? (args[k] as string) : undefined);
    let card: CopilotCard;
    let extra: Record<string, unknown> = {};
    try {
      switch (payload.action) {
        case 'tailor': {
          const jobId = str('jobId')!;
          const baseVariantId = str('baseVariantId')!;
          const session = await areas.createTailorSession(userId, { baseVariantId, jobId, idempotencyKey: key, locale });
          card = {
            type: 'tailor_ready',
            id: deps.newCardId(),
            data: { sessionId: session.id, sessionStatus: session.status, jobId, baseVariantId, resultVariantId: session.resultVariantId, href: `/resume/${encodeURIComponent(baseVariantId)}?tailor=${encodeURIComponent(jobId)}`, aiWritten: true },
          };
          break;
        }
        case 'cover_letter': {
          const jobId = str('jobId')!;
          const letter = await areas.createCoverLetter(
            userId,
            { jobId, resumeVariantId: str('resumeVariantId')!, tone: str('tone') as never, length: str('length') as never },
            key,
          );
          card = { type: 'cover_letter', id: deps.newCardId(), data: { letterId: letter.id, jobId, title: letter.title, href: `/resume/letters/${encodeURIComponent(letter.id)}`, aiWritten: true } };
          break;
        }
        case 'job_import': {
          const url = str('url')!;
          let res = await areas.importJob(userId, { url }, `${key}:read`);
          const d = res.draft;
          if (res.status === 'needs_fields' && d && d.title && d.company && d.description) {
            const fields: ManualJob = {
              title: d.title,
              company: d.company,
              description: d.description,
              ...(d.applyUrl ? { applyUrl: d.applyUrl } : {}),
              ...(d.location ? { location: d.location } : {}),
            };
            try {
              res = await areas.saveImportedJob(userId, fields, { importId: res.importId, idempotencyKey: key });
            } catch (err) {
              if ((err as { code?: unknown } | null)?.code !== 'invalid_request') throw err;
            }
          }
          card = {
            type: 'job_imported',
            id: deps.newCardId(),
            data: {
              status: res.status,
              jobId: res.jobId,
              importId: res.importId,
              // The read draft's title/company (what was saved); null when the import did not read them.
              title: d?.title ?? res.draft?.title ?? null,
              company: d?.company ?? res.draft?.company ?? null,
              matched: res.matched,
              reason: res.reason,
              missingFields: res.missingFields,
              warnings: res.warnings,
              href: res.jobId ? `/jobs/${encodeURIComponent(res.jobId)}` : `/jobs/added?import=${encodeURIComponent(res.importId)}`,
            } satisfies JobImportedCardData,
          };
          break;
        }
        case 'rewrite': {
          const resumeId = str('resumeId')!;
          const issueId = str('issueId')!;
          const style = (str('style') ?? 'ai') as 'ai' | 'longer' | 'shorter' | 'stronger';
          const out = await areas.fixResumeIssue(userId, resumeId, issueId, { variant: style, instruction: str('instruction'), idempotencyKey: key, locale });
          card = {
            type: 'rewrite_ready',
            id: deps.newCardId(),
            data: { resumeId, issueId, suggestions: out.suggestions, blocked: out.blocked, href: `/resume/${encodeURIComponent(resumeId)}/check?issue=${encodeURIComponent(issueId)}`, aiWritten: true },
          };
          break;
        }
        case 'outreach': {
          // NET writes the draft: AI gate first (no credit, no model call when the
          // user's AI is off), then one `outreach` credit, replay-safe on `key`.
          const jobId = str('jobId')!;
          const asked = str('channel');
          const channel = (OUTREACH_CHANNELS as readonly string[]).includes(asked ?? '') ? (asked as OutreachChannel) : 'email';
          const draft: OutreachDraftView = await areas.createOutreachDraft(userId, { jobId, channel, ...(str('locale') ? { locale: str('locale') } : {}) }, key);
          // The stored message keeps a link to where the draft lives (the job's People tab);
          // the draft text itself goes back to this click only.
          card = { type: 'action', id: deps.newCardId(), data: { kind: 'open_link', href: `/jobs/${encodeURIComponent(jobId)}?tab=people`, label: 'people' } };
          extra = { draft: { id: draft.id, channel: draft.channel, subject: draft.subject, text: draft.body, jobId, aiWritten: true } satisfies OutreachDraftResult };
          break;
        }
        default:
          throw new HttpError('conflict', 'This action is not available from the Assistant.', { reason: 'action_unavailable' });
      }
    } catch (err) {
      await unclaim(row);
      throw err;
    }
    await syncCards(row, 'applied', [card]);
    return { applied: true, result: { card, ...extra } };
  }

  async function applyMemory(userId: string, row: ProposalRow): Promise<ApplyProposalResponse> {
    const payload = MemoryAddPayloadSchema.parse(row.payload);
    // Count and create are one locked step, so concurrent applies cannot pass the cap together.
    const memory = await store.createMemoryCapped({ userId, fact: payload.fact, source: 'user_confirmed' }, COPILOT_MEMORY_MAX);
    if (!memory) throw memoryFull();
    await syncCards(row, 'applied');
    const view: MemoryFactView = { id: memory.id, fact: memory.fact, createdAt: memory.createdAt.toISOString() };
    return { applied: true, result: { memory: view } };
  }

  return {
    async apply(userId, proposalId, options = {}) {
      const row = await load(userId, proposalId);
      const market = deps.brand().market;
      if (row.kind === 'memory_add' && row.status === 'pending') {
        // Checks that do not consume the proposal come first.
        if (market === 'cn' && !(await deps.hasConsent(userId, 'copilot_memory'))) {
          throw new HttpError('forbidden', 'Turn on "Remember what I tell the Assistant" first.', { reason: COPILOT_ERROR_CODES.memoryConsentRequired, consent: 'copilot_memory' });
        }
        // Fast path (the proposal stays pending); applyMemory re-checks atomically.
        if ((await store.countMemory(userId)) >= COPILOT_MEMORY_MAX) throw memoryFull();
      }
      if (row.kind === 'filter_change' && options.baseVersion !== undefined) {
        const payload = FilterChangePayloadSchema.safeParse(row.payload);
        if (payload.success && payload.data.baseVersion !== options.baseVersion) {
          throw new HttpError('invalid_request', 'baseVersion does not match this suggestion.', { reason: 'base_version_mismatch' });
        }
      }
      await claim(row);
      switch (row.kind) {
        case 'filter_change':
          return applyFilter(userId, row, market);
        case 'credit_action':
          return applyCreditAction(userId, row, options.locale);
        case 'memory_add':
          try {
            return await applyMemory(userId, row);
          } catch (err) {
            await unclaim(row);
            throw err;
          }
        default:
          await unclaim(row);
          throw new HttpError('conflict', 'Unknown suggestion.', { reason: 'unknown_kind' });
      }
    },

    async dismiss(userId, proposalId) {
      const row = await load(userId, proposalId);
      const status = effectiveStatus(row, deps.now());
      if (status === 'dismissed' || status === 'expired' || status === 'conflict') return;
      if (status !== 'pending' || !(await store.transitionProposal(row.id, 'pending', 'dismissed', deps.now()))) {
        throw new HttpError('conflict', 'This suggestion was already used.', { reason: COPILOT_ERROR_CODES.proposalClosed });
      }
      await syncCards(row, 'dismissed');
    },
  };
}
