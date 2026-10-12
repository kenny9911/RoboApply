// server/src/features/copilot/proposals.ts — apply / dismiss Assistant proposals (ARCH §5.5; WP-50).
//
// Every mutation the Assistant suggests is a proposal the user applies with a
// click. Applying:
//   - claims the proposal first (pending → applied, compare-and-set), so a
//     double click runs it once; a failure puts it back to pending;
//   - expires it after 24 h (409 conflict, reason proposal_expired);
//   - refuses a suggestion whose reply was never stored (the turn's save
//     failed): the service closes those when the save fails, this process
//     remembers them (`turnUnsaved`), and a suggestion still pending after
//     UNSAVED_TURN_GRACE_MS whose message does not exist is closed here;
//   - filter_change: applies the patch at `baseVersion`; when the saved
//     search changed meanwhile, marks it `conflict` and answers 409
//     version_conflict with a fresh `filter_diff` card (a new proposal);
//   - credit_action: runs the area service with the Idempotency-Key
//     `copilot:<proposalId>`; the area spends its own credit (tailor,
//     cover_letter, job_import, rewrite, outreach) only now;
//   - memory_add: GoApply needs a live `copilot_memory` consent (403), at
//     most 50 facts (409 memory_full; counted and stored under one lock).
// The reply to the click never waits long on the bookkeeping: the count shown
// after a filter change and the update of the stored card are each given
// COUNT_AFTER_WAIT_MS, then the click is answered and the card update finishes
// on its own.
// A proposal that is no longer pending answers 409 proposal_closed with what
// became of it in `details.status`. `applied` is said only when the apply
// FINISHED. A proposal is claimed (pending → applied) before its work runs, so
// while that work is still running in this process a second click is told
// `applying` instead: the work may still fail and put the proposal back.
// The card in the stored message gets the new status, and a result card
// (tailor_ready, cover_letter, job_imported, rewrite_ready; for an outreach
// draft a link to the job's People tab, where the draft is kept) is appended,
// both under a row lock on the message (store.updateCards). The update is
// safe to run twice: a result card is appended once, by its id.

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
  /** True when this process knows the reply `messageId` could not be stored (CopilotService). */
  turnUnsaved?: (messageId: string) => boolean;
}

/**
 * A turn is stored within minutes of its first card. A suggestion still
 * pending after this long whose message is not in the thread came from a
 * reply that was never stored.
 */
export const UNSAVED_TURN_GRACE_MS = 10 * 60_000;
/**
 * How long a click waits for bookkeeping before it is answered without it: the
 * new job count after a filter change, and the update of the stored card.
 */
export const COUNT_AFTER_WAIT_MS = 4_000;
/** `details.status` of a 409 proposal_closed while the claimed apply is still running (it may still fail). */
export const PROPOSAL_APPLYING = 'applying';

export interface ProposalService {
  apply(userId: string, proposalId: string, options?: { baseVersion?: number; locale?: string }): Promise<ApplyProposalResponse>;
  dismiss(userId: string, proposalId: string): Promise<void>;
  /** True while a claimed apply of this proposal is still running in this process (its row already says `applied`). */
  isApplying(proposalId: string): boolean;
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

/**
 * Where a `tailor_ready` card opens: the session the proposal just created and
 * paid for (`tailorSession`), on its base resume. Without `tailorSession` the
 * web route starts a NEW tailor run (components/features/tailor/TailorLaunchHost),
 * which would reserve a second credit and skip this session's Verify-details step.
 */
export function tailorSessionHref(baseVariantId: string, jobId: string, sessionId: string): string {
  return `/resume/${encodeURIComponent(baseVariantId)}?tailor=${encodeURIComponent(jobId)}&tailorSession=${encodeURIComponent(sessionId)}`;
}

const isVersionConflict = (err: unknown) => (err as { code?: unknown } | null)?.code === 'version_conflict';

/** `work`, or null when it takes longer than `ms`. `work` keeps running; its failure is the caller's to handle. */
function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([work, late]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function createProposalService(deps: ProposalServiceDeps): ProposalService {
  const { store, areas } = deps;
  /** Proposals claimed here whose work has not finished (this process). */
  const inFlight = new Set<string>();
  /** What a closed proposal became, as a second click is told: never `applied` before the apply finished. */
  const closedStatus = (id: string, status: string): string => (status === 'applied' && inFlight.has(id) ? PROPOSAL_APPLYING : status);

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
        // Appended once: a try that was stored but whose answer was lost is tried again (store.retryTransient).
        ...extra.filter((e) => !cards.some((c) => c && c.id === e.id)),
      ]);
    } catch (err) {
      logger.warn('COPILOT', 'could not update the proposal card', { proposalId: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** A pending suggestion whose reply is not in the thread (the turn's save failed) is closed, never applied. */
  async function refuseUnsaved(row: ProposalRow): Promise<void> {
    if (row.status !== 'pending') return;
    const messageId = messageIdOf(row.payload);
    if (!messageId) return;
    let unsaved = deps.turnUnsaved?.(messageId) === true;
    if (!unsaved && deps.now().getTime() - row.createdAt.getTime() > UNSAVED_TURN_GRACE_MS) {
      unsaved = !(await store.getMessage(messageId));
    }
    if (!unsaved) return;
    await store.transitionProposal(row.id, 'pending', 'expired', deps.now()).catch(() => false);
    throw new HttpError('conflict', 'This suggestion was not saved. Ask again for a fresh one.', { reason: COPILOT_ERROR_CODES.proposalExpired, cause: 'turn_not_saved' });
  }

  async function claim(row: ProposalRow): Promise<void> {
    const now = deps.now();
    if (row.status === 'expired') {
      throw new HttpError('conflict', 'This suggestion expired. Ask again for a fresh one.', { reason: COPILOT_ERROR_CODES.proposalExpired });
    }
    if (row.status !== 'pending') {
      throw new HttpError('conflict', 'This suggestion was already used or dismissed.', { reason: COPILOT_ERROR_CODES.proposalClosed, status: closedStatus(row.id, row.status) });
    }
    if (row.expiresAt.getTime() <= now.getTime()) {
      await store.transitionProposal(row.id, 'pending', 'expired', now);
      await syncCards(row, 'expired');
      throw new HttpError('conflict', 'This suggestion expired. Ask again for a fresh one.', { reason: COPILOT_ERROR_CODES.proposalExpired });
    }
    if (!(await store.transitionProposal(row.id, 'pending', 'applied', now))) {
      // Lost the race to another click: say what became of it, so that card can show it.
      const current = await store.getProposal(row.id).catch(() => null);
      throw new HttpError('conflict', 'This suggestion was already used or dismissed.', { reason: COPILOT_ERROR_CODES.proposalClosed, ...(current ? { status: closedStatus(row.id, current.status) } : {}) });
    }
  }

  /** The stored card's update, given COUNT_AFTER_WAIT_MS; after that it finishes on its own (syncCards logs its own failure). */
  const syncCardsSoon = (row: ProposalRow, status: ProposalStatus, extra: CopilotCard[] = []): Promise<void | null> =>
    within(syncCards(row, status, extra), COUNT_AFTER_WAIT_MS);

  async function unclaim(row: ProposalRow, to: ProposalStatus = 'pending'): Promise<void> {
    await store.transitionProposal(row.id, 'applied', to, deps.now());
  }

  /** The job count for the new filters, or null when it fails or takes longer than COUNT_AFTER_WAIT_MS. */
  async function countWithin(userId: string, filters: Parameters<CopilotAreas['countForFilters']>[1]): Promise<CountView | null> {
    try {
      return await within(areas.countForFilters(userId, filters).then((res) => countView(res, deps.now())), COUNT_AFTER_WAIT_MS);
    } catch {
      return null;
    }
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
    // The change went through. The card update and the new count are bookkeeping:
    // they run together and neither holds the answer back for long.
    const [, countAfter] = await Promise.all([syncCardsSoon(row, 'applied'), countWithin(userId, updated.filters)]);
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
            data: { sessionId: session.id, sessionStatus: session.status, jobId, baseVariantId, resultVariantId: session.resultVariantId, href: tailorSessionHref(baseVariantId, jobId, session.id), aiWritten: true },
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
    await syncCardsSoon(row, 'applied', [card]);
    return { applied: true, result: { card, ...extra } };
  }

  async function applyMemory(userId: string, row: ProposalRow): Promise<ApplyProposalResponse> {
    const payload = MemoryAddPayloadSchema.parse(row.payload);
    // Count and create are one locked step, so concurrent applies cannot pass the cap together.
    const memory = await store.createMemoryCapped({ userId, fact: payload.fact, source: 'user_confirmed' }, COPILOT_MEMORY_MAX);
    if (!memory) throw memoryFull();
    await syncCardsSoon(row, 'applied');
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
      await refuseUnsaved(row);
      await claim(row);
      // Claimed: until the work below ends (done, or failed and put back), a second click is told `applying`.
      inFlight.add(row.id);
      try {
        switch (row.kind) {
          case 'filter_change':
            return await applyFilter(userId, row, market);
          case 'credit_action':
            return await applyCreditAction(userId, row, options.locale);
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
      } finally {
        inFlight.delete(row.id);
      }
    },

    isApplying: (proposalId) => inFlight.has(proposalId),

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
