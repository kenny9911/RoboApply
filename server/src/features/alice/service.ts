// server/src/features/alice/service.ts — Alice's orchestrator (docs/alice/ALICE.md §2).
//
// One turn per action. A turn checks what it must before anything runs (AI
// allowed for the user, the per-user limits, one running turn per thread),
// stores the person's side of the turn, runs the subagents and workers it
// needs in order (each one announced as a `progress` step while it really
// runs), stores Alice's reply, and ends with the whole thread view.
//
// Stages: intake → (drafting, inside a turn) → choosing → refining → saved.
//
// Rules this file keeps:
//   - D1: nothing here submits an application or contacts an employer.
//   - D3: every count is the person's own rows; the diff between versions is
//     computed (contract.diffProfiles); the Reporter's words are checked and
//     replaced by the facts block when a number in them is not a fact.
//   - Profiles are stored as the person approved them; the search filters are
//     derived from the profile on every save (skills/profileFilters.ts).
//   - Replacing a saved search keeps its old filters on the profile for Undo.

import { HttpError } from '../../platform/http.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { logger } from '../../services/LoggerService.js';
import { INTERVIEW_STATUSES, OFFER_STATUSES, TERMINAL_STATUSES, AWAITING_REPLY_STATUSES, ladderFor } from '../tracker/index.js';
import type { FilterSet } from '../search/contract.js';
import {
  ALICE_ERROR_REASONS,
  ALICE_LIMITS,
  ALICE_TOPIC_IDS,
  EMPTY_BRIEF,
  cleanAnalysis,
  cleanBrief,
  cleanPending,
  cleanProfile,
  clip,
  clipList,
  diffProfiles,
  mergeBrief,
  type AliceAgentId,
  type AliceAnalysis,
  type AliceApplicationsView,
  type AliceBlock,
  type AliceBrief,
  type AliceJobProfile,
  type AliceMatchView,
  type AliceMatchesResponse,
  type AliceMessageView,
  type AliceNoticeCode,
  type AlicePatchProfileBody,
  type AlicePending,
  type AliceProfileField,
  type AliceProfilesResponse,
  type AliceReminderView,
  type AliceReportFacts,
  type AliceRevision,
  type AliceSaveTarget,
  type AliceSavedProfileView,
  type AliceSearchRef,
  type AliceStage,
  type AliceStep,
  type AliceStreamEvent,
  type AliceThreadView,
  type AliceTopicId,
  type AliceTurnBody,
} from './contract.js';
import type { AliceDeps, ResumeDigest, SearchRef, TrackerEntryLite } from './deps.js';
import type { RouterOutput } from './agents.js';
import type { JobProfileRow, MessageRow, NewMessage, ThreadRow } from './store.js';
import {
  REQUIRED_TOPICS,
  axisDirective,
  coveredTopics,
  filtersFromProfile,
  marketNorms,
  needsYou,
  nextTopic,
  readiness,
  relevanceText,
  renderAxisIndex,
  renderTopicIndex,
  topicsFor,
  voiceDirective,
  type AliceMarket,
} from './skills/index.js';

export interface AliceContext {
  /** The person's interface language. */
  locale: string;
  /** ISO country from the request, when known. */
  country: string | null;
  requestId?: string;
  signal?: AbortSignal;
}

export interface TurnContext extends AliceContext {
  emit(event: AliceStreamEvent): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** English wording that would break D1 (the product never applies or submits). */
const D1_PATTERNS = [/\b(appl(y|ied|ying)|submit(ted|ting)?|send(ing)?|sent)\b[^.]{0,30}\b(for|on behalf of) you\b/i, /\bon your behalf\b/i, /\bauto-?appl/i];

export function breaksD1(text: string): boolean {
  return D1_PATTERNS.some((re) => re.test(text));
}

/** Every number written in `text` is one of `allowed` (the Reporter's check; D3). */
export function numbersAreFacts(text: string, allowed: ReadonlySet<number>): boolean {
  const found = text.match(/\d+/g) ?? [];
  return found.every((n) => allowed.has(Number(n)));
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function topicsOf(row: ThreadRow): { covered: AliceTopicId[]; declined: AliceTopicId[] } {
  const t = (row.topics && typeof row.topics === 'object' ? row.topics : {}) as Record<string, unknown>;
  const pick = (v: unknown) => (Array.isArray(v) ? (ALICE_TOPIC_IDS as readonly string[]).filter((id) => v.includes(id)) : []) as AliceTopicId[];
  return { covered: pick(t.covered), declined: pick(t.declined) };
}

/** Stored drafts and versions were cleaned when written: they keep their company labels. */
function draftsOf(row: ThreadRow): AliceJobProfile[] {
  const list = Array.isArray(row.drafts) ? row.drafts : [];
  return list.map((d, i) => cleanProfile(d, i === 0 ? 'a' : 'b', 'stored')).filter((p): p is AliceJobProfile => p !== null).slice(0, 2);
}

function revisionsOf(row: ThreadRow): AliceRevision[] {
  const list = Array.isArray(row.revisions) ? row.revisions : [];
  const out: AliceRevision[] = [];
  for (const raw of list) {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const profile = cleanProfile(r.profile, 'p', 'stored');
    if (!profile || typeof r.version !== 'number') continue;
    out.push({
      version: r.version,
      profile,
      comment: typeof r.comment === 'string' ? r.comment : null,
      notes: clipList(r.notes, 6, 200),
      changed: (Array.isArray(r.changed) ? r.changed : []).filter((f): f is AliceProfileField => typeof f === 'string') as AliceProfileField[],
      origin: r.origin === 'edit' || r.origin === 'restore' || r.origin === 'saved_profile' ? r.origin : 'pick',
      ...(typeof r.restoredFrom === 'number' ? { restoredFrom: r.restoredFrom } : {}),
      at: typeof r.at === 'string' ? r.at : new Date(0).toISOString(),
    });
  }
  return out;
}

function messageView(row: MessageRow): AliceMessageView {
  return {
    id: row.id,
    role: row.role,
    text: row.content,
    blocks: (Array.isArray(row.blocks) ? row.blocks : []) as AliceBlock[],
    agent: (row.agent as AliceAgentId | null) ?? null,
    at: row.createdAt.toISOString(),
  };
}

export function createAliceService(deps: AliceDeps) {
  const running = new Set<string>();

  // ── Reading ──────────────────────────────────────────────────────────────

  function marketOf(brand: ProductBrand): AliceMarket {
    return brand.market === 'cn' ? 'cn' : 'intl';
  }

  async function ensureThread(userId: string, ctx: AliceContext): Promise<ThreadRow> {
    const existing = await deps.store.activeThread(userId);
    if (existing) return existing;
    const brand = deps.brand();
    const row = await deps.store.createThread({ userId, brand: brand.id, locale: ctx.locale });
    const resume = await deps.primaryResume(userId).catch(() => null);
    await deps.store.addMessages(row.id, [
      { role: 'alice', content: '', blocks: [{ type: 'greeting', hasResume: resume !== null, resumeName: resume?.name ?? null }], agent: 'system' },
    ]);
    return row;
  }

  async function saveTargetFor(userId: string, row: ThreadRow): Promise<AliceSaveTarget | null> {
    try {
      const { items, cap } = await deps.searches(userId);
      const saved = row.savedProfileId ? await deps.store.getProfile(userId, row.savedProfileId) : null;
      const linked = saved?.searchProfileId ? items.find((s) => s.id === saved.searchProfileId) : undefined;
      if (linked) return { mode: 'update', search: { id: linked.id, name: linked.name } };
      if (items.length < cap) return { mode: 'create', search: null };
      const target = items.find((s) => s.isActive) ?? items.find((s) => s.isDefault) ?? items[0];
      return { mode: 'choose', search: target ? { id: target.id, name: target.name } : null };
    } catch (err) {
      logger.warn('ALICE', 'save target could not be read', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  async function savedView(userId: string, row: JobProfileRow, searches?: SearchRef[]): Promise<AliceSavedProfileView | null> {
    const profile = cleanProfile(row.profile, row.id, 'stored');
    if (!profile) return null;
    let list = searches;
    if (!list && row.searchProfileId) list = (await deps.searches(userId).catch(() => ({ items: [] as SearchRef[], cap: 0 }))).items;
    const search = row.searchProfileId ? (list ?? []).find((s) => s.id === row.searchProfileId) : undefined;
    return {
      id: row.id,
      name: row.name,
      profile,
      version: row.version,
      status: row.status === 'archived' ? 'archived' : 'active',
      search: search ? { id: search.id, name: search.name, isActive: search.isActive } : null,
      canUndoReplace: row.previousFilters !== null && row.previousFilters !== undefined && !!search,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function view(userId: string, row: ThreadRow): Promise<AliceThreadView> {
    const brand = deps.brand();
    const market = marketOf(brand);
    const brief = cleanBrief(row.brief);
    const topics = topicsOf(row);
    const [messages, resume, saved] = await Promise.all([
      deps.store.recentMessages(row.id, ALICE_LIMITS.messagesShown),
      row.resumeVariantId ? deps.resume(userId, row.resumeVariantId).catch(() => null) : Promise.resolve(null),
      row.savedProfileId ? deps.store.getProfile(userId, row.savedProfileId) : Promise.resolve(null),
    ]);
    const all = topicsFor(market).map((t) => t.id);
    const covered = coveredTopics(brief, market);
    return {
      id: row.id,
      stage: row.stage,
      locale: row.locale,
      resume: resume ? { id: resume.id, name: resume.name, updatedAt: resume.updatedAt.toISOString() } : null,
      resumeSkipped: row.resumeSkipped,
      brief,
      topics: {
        all,
        required: REQUIRED_TOPICS.filter((t) => all.includes(t)),
        covered,
        declined: topics.declined.filter((t) => all.includes(t) && !covered.includes(t)),
      },
      ready: readiness(brief, topics.declined, market).ready,
      pending: cleanPending(row.pending),
      analysis: cleanAnalysis(row.analysis),
      drafts: row.stage === 'choosing' ? draftsOf(row) : [],
      revisions: revisionsOf(row),
      currentVersion: row.currentVersion,
      savedProfile: saved ? await savedView(userId, saved) : null,
      saveTarget: row.stage === 'refining' ? await saveTargetFor(userId, row) : null,
      messages: messages.map(messageView),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function getThread(userId: string, ctx: AliceContext): Promise<AliceThreadView> {
    return view(userId, await ensureThread(userId, ctx));
  }

  // ── Turn plumbing ────────────────────────────────────────────────────────

  class Turn {
    row: ThreadRow;
    readonly userId: string;
    readonly ctx: TurnContext;
    readonly brand: ProductBrand;
    readonly market: AliceMarket;
    /** A message of this turn was stored. */
    spoke = false;
    constructor(userId: string, row: ThreadRow, ctx: TurnContext) {
      this.userId = userId;
      this.row = row;
      this.ctx = ctx;
      this.brand = deps.brand();
      this.market = marketOf(this.brand);
    }
    get brief(): AliceBrief {
      return cleanBrief(this.row.brief);
    }
    get voice(): string {
      return voiceDirective(this.brand.name);
    }
    get norms(): string {
      return marketNorms(this.market, this.ctx.country).directive;
    }
    async patch(patch: Parameters<AliceDeps['store']['updateThread']>[2]): Promise<void> {
      this.row = await deps.store.updateThread(this.userId, this.row.id, patch);
    }
    async say(messages: readonly NewMessage[]): Promise<void> {
      const rows = await deps.store.addMessages(this.row.id, messages);
      this.spoke = true;
      for (const r of rows) this.ctx.emit({ event: 'message', data: { message: messageView(r) } });
    }
    async user(content: string, blocks: AliceBlock[] = []): Promise<void> {
      await this.say([{ role: 'user', content: content.trim().slice(0, ALICE_LIMITS.messageChars), blocks, agent: null }]);
    }
    async alice(content: string, blocks: AliceBlock[], agent: AliceAgentId): Promise<void> {
      const text = breaksD1(content) ? '' : content.trim().slice(0, 1600);
      if (text !== content.trim().slice(0, 1600)) logger.warn('ALICE', 'reply dropped: D1 wording', { agent });
      await this.say([{ role: 'alice', content: text, blocks, agent }]);
    }
    async notice(code: AliceNoticeCode, extra: AliceBlock[] = []): Promise<void> {
      await this.alice('', [...extra, { type: 'notice', code }], 'system');
    }
    async step<T>(step: AliceStep, fn: () => Promise<T>): Promise<T> {
      this.ctx.emit({ event: 'progress', data: { step, state: 'running' } });
      try {
        return await fn();
      } finally {
        this.ctx.emit({ event: 'progress', data: { step, state: 'done' } });
      }
    }
    opts() {
      return { requestId: this.ctx.requestId, locale: this.ctx.locale, signal: this.ctx.signal };
    }
    async resumeDigest(): Promise<ResumeDigest | null> {
      if (!this.row.resumeVariantId) return null;
      return deps.resumeDigest(this.userId, this.row.resumeVariantId).catch(() => null);
    }
  }

  function wrongStage(): HttpError {
    return new HttpError('conflict', 'That is not something Alice can do at this step.', { reason: ALICE_ERROR_REASONS.wrongStage });
  }

  function agentFailed(err: unknown, agent: string): HttpError {
    if (err instanceof HttpError) return err;
    logger.warn('ALICE', 'subagent failed', { agent, error: err instanceof Error ? err.message : String(err) });
    return new HttpError('ai_unavailable', 'Alice could not finish that. Try again.', { reason: ALICE_ERROR_REASONS.agentFailed });
  }

  /** The kinds that run a model (the AI gate applies to them). */
  const MODEL_KINDS = new Set<AliceTurnBody['kind']>(['message', 'replies', 'resume', 'skip_resume', 'draft_now', 'choose', 'regenerate', 'refine', 'report']);
  /** The costly kinds (profile writes and revisions). */
  const DRAFT_KINDS = new Set<AliceTurnBody['kind']>(['draft_now', 'regenerate', 'refine']);

  async function turn(userId: string, body: AliceTurnBody, ctx: TurnContext): Promise<void> {
    let row = await ensureThread(userId, ctx);
    if (MODEL_KINDS.has(body.kind) && !(await deps.aiAllowed(userId))) {
      throw new HttpError('ai_unavailable', 'Alice needs your consent to use AI. Turn it on in Settings.', { reason: ALICE_ERROR_REASONS.aiOff });
    }
    await deps.rateLimit('aliceTurn', userId);
    if (DRAFT_KINDS.has(body.kind) || (body.kind === 'choose' && body.comment)) await deps.rateLimit('aliceDraft', userId);
    if (running.has(row.id)) throw new HttpError('conflict', 'Alice is still answering your last message.', { reason: ALICE_ERROR_REASONS.busy });
    running.add(row.id);
    try {
      if (body.kind === 'restart') {
        await deps.store.archiveThread(userId, row.id);
        row = await ensureThread(userId, ctx);
        ctx.emit({ event: 'thread', data: { thread: await view(userId, row) } });
        return;
      }
      if (row.turnCount >= ALICE_LIMITS.turnsPerThread) {
        const t = new Turn(userId, row, ctx);
        await t.notice('turn_limit');
        ctx.emit({ event: 'thread', data: { thread: await view(userId, t.row) } });
        return;
      }
      const t = new Turn(userId, row, ctx);
      await t.patch({ turnCount: row.turnCount + 1, ...(row.locale !== ctx.locale ? { locale: ctx.locale } : {}) });
      try {
        await dispatch(t, body);
      } catch (err) {
        // Once the person's side is stored, the thread says what happened, so a reload shows the same thing.
        if (t.spoke) {
          try {
            await t.notice('agent_failed');
            ctx.emit({ event: 'thread', data: { thread: await view(userId, t.row) } });
          } catch {
            // The error event that follows still tells the client; the next load shows the stored thread.
          }
        }
        throw err;
      }
      ctx.emit({ event: 'thread', data: { thread: await view(userId, t.row) } });
    } finally {
      running.delete(row.id);
    }
  }

  async function dispatch(t: Turn, body: AliceTurnBody): Promise<void> {
    const stage = t.row.stage;
    switch (body.kind) {
      case 'resume':
        return chooseResume(t, body.resumeVariantId);
      case 'skip_resume':
        if (stage !== 'intake') throw wrongStage();
        await t.patch({ resumeSkipped: true, resumeVariantId: null });
        await t.user('', [{ type: 'action', action: 'skip_resume' }]);
        return ask(t, null);
      case 'message':
      case 'replies': {
        const text = body.kind === 'message' ? body.text : [body.replies.join(', '), body.text ?? ''].filter(Boolean).join('. ');
        await t.user(text);
        if (stage === 'intake') return ask(t, text);
        return route(t, text);
      }
      case 'draft_now': {
        if (stage !== 'intake') throw wrongStage();
        await t.user('', [{ type: 'action', action: 'draft_now' }]);
        const brand = t.brief;
        if (brand.roles.length === 0) return ask(t, null);
        return draftPair(t, null);
      }
      case 'choose':
        if (stage !== 'choosing') throw wrongStage();
        return choose(t, body.draftId, body.comment ?? null, true);
      case 'regenerate':
        if (stage !== 'choosing' && stage !== 'refining') throw wrongStage();
        await t.user(body.comment ?? '', [{ type: 'action', action: 'regenerate' }]);
        return draftPair(t, body.comment ?? null);
      case 'refine':
        if (stage !== 'refining') throw wrongStage();
        await t.user(body.comment);
        return refine(t, body.comment);
      case 'restore':
        if (stage !== 'refining') throw wrongStage();
        return restore(t, body.version);
      case 'save':
        if (stage !== 'refining') throw wrongStage();
        return save(t, body.name ?? null, body.search);
      case 'find_jobs':
        await t.user('', [{ type: 'action', action: 'find_jobs' }]);
        return findJobs(t);
      case 'report':
        await t.user('', [{ type: 'action', action: 'report' }]);
        return report(t, null);
      case 'edit_profile':
        return editSaved(t, body.profileId);
      default:
        throw wrongStage();
    }
  }

  // ── Intake ───────────────────────────────────────────────────────────────

  async function chooseResume(t: Turn, resumeVariantId: string): Promise<void> {
    if (t.row.stage !== 'intake') throw wrongStage();
    const ref = await deps.resume(t.userId, resumeVariantId);
    if (!ref) throw new HttpError('not_found', 'That resume is not in your account.', { reason: ALICE_ERROR_REASONS.resumeNotFound });
    await t.patch({ resumeVariantId: ref.id, resumeSkipped: false });
    await t.user('', [{ type: 'action', action: 'resume', label: ref.name }]);
    const digest = await t.step('reading_resume', () => t.resumeDigest());
    if (!digest || !digest.text) {
      await t.patch({ resumeVariantId: null });
      await t.notice('resume_unreadable');
    } else {
      await t.alice('', [{ type: 'resume', resumeName: digest.name, roles: digest.roles, years: digest.years }], 'intake');
    }
    return ask(t, null);
  }

  /** Fold an answer into the brief and ask the next question, or write the two profiles when there is enough. */
  async function ask(t: Turn, answer: string | null): Promise<void> {
    const market = t.market;
    const before = t.brief;
    const topics = topicsOf(t.row);
    const pending = cleanPending(t.row.pending);
    const history = (await deps.store.recentMessages(t.row.id, 9))
      .slice(0, -1)
      .filter((m) => m.content.trim())
      .map((m) => ({ role: m.role, text: m.content.slice(0, 600) }));
    const digest = await t.resumeDigest();
    let out;
    try {
      out = await t.step('thinking', () =>
        deps.agents.intake.run(
          {
            locale: t.ctx.locale,
            voice: t.voice,
            norms: t.norms,
            topicIndex: renderTopicIndex(market),
            resume: digest?.text || null,
            brief: before,
            covered: coveredTopics(before, market),
            declined: topics.declined,
            suggestedTopic: nextTopic(before, topics.declined, market),
            answeringTopic: pending?.topic ?? null,
            history,
            answer,
          },
          t.opts(),
        ),
      );
    } catch (err) {
      throw agentFailed(err, 'intake');
    }
    const cleared = out.cleared.filter((f) => typeof f === 'string');
    const brief = answer === null ? before : mergeBrief(before, out.learned as Partial<AliceBrief>, cleared);
    const declined = [...new Set([...topics.declined, ...out.declined.filter((d): d is AliceTopicId => (ALICE_TOPIC_IDS as readonly string[]).includes(d))])];
    const covered = coveredTopics(brief, market);
    const learnedTopics = covered.filter((id) => !coveredTopics(before, market).includes(id));
    const ready = readiness(brief, declined, market).ready;
    const answers = (await deps.store.recentMessages(t.row.id, ALICE_LIMITS.messagesShown)).filter((m) => m.role === 'user' && m.content.trim()).length;
    const optionalLeft = nextTopic(brief, declined, market) !== null;
    // Enough: the needed groups are covered and the person asked, nothing useful is left, or the answers ran out.
    const draftNow = brief.roles.length > 0 && ready && (out.wantsProfiles || !optionalLeft || answers >= ALICE_LIMITS.intakeMaxAnswers || !out.question.trim());
    await t.patch({ brief, topics: { covered, declined } });
    if (draftNow) {
      await t.patch({ pending: null });
      const ack = clip(out.ack, 600);
      await t.alice(ack, learnedTopics.length ? [{ type: 'learned', topics: learnedTopics }, { type: 'notice', code: 'enough_questions' }] : [{ type: 'notice', code: 'enough_questions' }], 'intake');
      return draftPair(t, null);
    }
    const nextPending: AlicePending | null = cleanPending({ topic: out.topic, quickReplies: out.quickReplies, multiSelect: out.multiSelect });
    await t.patch({ pending: nextPending });
    const text = [clip(out.ack, 600), clip(out.question, 600)].filter(Boolean).join('\n\n');
    await t.alice(text, learnedTopics.length ? [{ type: 'learned', topics: learnedTopics }] : [], 'intake');
  }

  // ── Drafting ─────────────────────────────────────────────────────────────

  async function draftPair(t: Turn, comment: string | null): Promise<void> {
    const brief = t.brief;
    const digest = await t.resumeDigest();
    const previous = cleanAnalysis(t.row.analysis);
    const oldDrafts = draftsOf(t.row);
    let analysis: AliceAnalysis | null;
    try {
      analysis = await t.step('reading_goals', async () =>
        cleanAnalysis(
          await deps.agents.analyst.run(
            {
              locale: t.ctx.locale,
              voice: t.voice,
              norms: t.norms,
              axisIndex: renderAxisIndex(),
              resume: digest?.text || null,
              brief,
              comment,
              previousAxis: comment ? (previous?.axis ?? null) : null,
            },
            t.opts(),
          ),
        ),
      );
    } catch (err) {
      throw agentFailed(err, 'analyst');
    }
    if (!analysis) throw agentFailed(new Error('analysis without two directions'), 'analyst');
    const settled = analysis;
    let pair: AliceJobProfile[];
    let message = '';
    try {
      pair = await t.step('writing_profiles', async () => {
        const out = await deps.agents.writer.run(
          {
            locale: t.ctx.locale,
            voice: t.voice,
            norms: t.norms,
            resume: digest?.text || null,
            brief,
            analysis: settled,
            axis: axisDirective(settled.axis),
            comment,
            avoid: oldDrafts.map((d) => `${d.label}: ${d.headline}`),
          },
          t.opts(),
        );
        message = out.message;
        return [cleanProfile(out.profiles[0], 'a', brief.companies), cleanProfile(out.profiles[1], 'b', brief.companies)].filter((p): p is AliceJobProfile => p !== null);
      });
    } catch (err) {
      throw agentFailed(err, 'writer');
    }
    if (pair.length < 2) throw agentFailed(new Error('fewer than two profiles'), 'writer');
    await t.patch({ stage: 'choosing', analysis: settled, drafts: pair, pending: null, draftCount: t.row.draftCount + 1 });
    await t.alice(clip(message, 600), [{ type: 'profiles', labels: [pair[0].label, pair[1].label] }], 'writer');
  }

  // ── Choosing and refining ────────────────────────────────────────────────

  function revision(version: number, profile: AliceJobProfile, before: AliceJobProfile | null, extra: Partial<AliceRevision>): AliceRevision {
    return {
      version,
      profile: { ...profile, id: 'p' },
      comment: null,
      notes: [],
      changed: diffProfiles(before, profile),
      origin: 'pick',
      at: deps.now().toISOString(),
      ...extra,
    };
  }

  /** Keeps the first version and the newest ones, at most ALICE_LIMITS.revisions. */
  function capRevisions(list: AliceRevision[]): AliceRevision[] {
    if (list.length <= ALICE_LIMITS.revisions) return list;
    return [list[0], ...list.slice(list.length - (ALICE_LIMITS.revisions - 1))];
  }

  async function choose(t: Turn, draftId: 'a' | 'b', comment: string | null, withLine: boolean): Promise<void> {
    const brief = t.brief;
    const drafts = draftsOf(t.row);
    const picked = drafts.find((d) => d.id === draftId);
    if (!picked) throw wrongStage();
    if (withLine) await t.user(comment ?? '', [{ type: 'action', action: 'choose', label: picked.label }]);
    const first = revision(1, picked, null, { origin: 'pick' });
    await t.patch({ stage: 'refining', revisions: [first], currentVersion: 1, pending: null });
    if (!comment) {
      await t.alice('', [{ type: 'revision', version: 1, changed: [] }], 'editor');
      return;
    }
    const other = drafts.find((d) => d.id !== draftId) ?? null;
    return refine(t, comment, other);
  }

  async function refine(t: Turn, comment: string, otherDraft?: AliceJobProfile | null): Promise<void> {
    const brief = t.brief;
    const revisions = revisionsOf(t.row);
    const current = revisions.find((r) => r.version === t.row.currentVersion) ?? revisions[revisions.length - 1];
    if (!current) throw wrongStage();
    const digest = await t.resumeDigest();
    const other = otherDraft === undefined ? (draftsOf(t.row).find((d) => d.label !== current.profile.label) ?? null) : otherDraft;
    let out;
    try {
      out = await t.step('revising', () =>
        deps.agents.editor.run({ locale: t.ctx.locale, voice: t.voice, norms: t.norms, resume: digest?.text || null, brief, profile: current.profile, comment, other }, t.opts()),
      );
    } catch (err) {
      throw agentFailed(err, 'editor');
    }
    const learnedBrief = mergeBrief(brief, out.learned as Partial<AliceBrief>);
    const next = cleanProfile(out.profile, 'p', learnedBrief.companies);
    const changed = next ? diffProfiles(current.profile, next) : [];
    if (!next || changed.length === 0) {
      await t.patch({ brief: learnedBrief });
      await t.alice(clip(out.message, 600), [{ type: 'notice', code: 'nothing_changed' }], 'editor');
      return;
    }
    const version = (revisions[revisions.length - 1]?.version ?? 0) + 1;
    const rev = revision(version, next, current.profile, { origin: 'edit', comment: comment.slice(0, ALICE_LIMITS.commentChars), notes: clipList(out.notes, 6, 200) });
    await t.patch({ brief: learnedBrief, revisions: capRevisions([...revisions, rev]), currentVersion: version });
    await t.alice(clip(out.message, 600), [{ type: 'revision', version, changed }], 'editor');
  }

  async function restore(t: Turn, version: number): Promise<void> {
    const brief = t.brief;
    const revisions = revisionsOf(t.row);
    const target = revisions.find((r) => r.version === version);
    const current = revisions.find((r) => r.version === t.row.currentVersion) ?? revisions[revisions.length - 1];
    if (!target || !current) throw new HttpError('not_found', 'That version is gone.');
    await t.user('', [{ type: 'action', action: 'restore', version }]);
    if (target.version === current.version) {
      await t.notice('nothing_changed');
      return;
    }
    const next = (revisions[revisions.length - 1]?.version ?? 0) + 1;
    const rev = revision(next, target.profile, current.profile, { origin: 'restore', restoredFrom: version });
    await t.patch({ revisions: capRevisions([...revisions, rev]), currentVersion: next });
    await t.alice('', [{ type: 'restored', version }], 'editor');
  }

  // ── Saving ───────────────────────────────────────────────────────────────

  async function save(t: Turn, name: string | null, mode: 'auto' | 'replace' | 'none'): Promise<void> {
    const brief = t.brief;
    const revisions = revisionsOf(t.row);
    const current = revisions.find((r) => r.version === t.row.currentVersion) ?? revisions[revisions.length - 1];
    if (!current) throw wrongStage();
    await t.user('', [{ type: 'action', action: 'save', label: clip(name ?? current.profile.label, 60) }]);
    const result = await t.step('saving', () => persistProfile(t.userId, t.row.savedProfileId, current.profile, brief, clip(name ?? current.profile.label, 60), mode, t.market));
    await t.patch({ stage: 'saved', savedProfileId: result.row.id, pending: null });
    await t.alice('', [{ type: 'saved', profileId: result.row.id, name: result.row.name, search: result.search }], 'system');
    await findJobs(t, true);
  }

  /**
   * Store the profile and point a saved search at it (ALICE.md §2 "Saving a profile").
   * Returns the stored row and what happened to the search.
   */
  async function persistProfile(
    userId: string,
    savedId: string | null,
    profile: AliceJobProfile,
    brief: AliceBrief,
    name: string,
    mode: 'auto' | 'replace' | 'none',
    market: AliceMarket,
  ): Promise<{ row: JobProfileRow; search: AliceSearchRef | null }> {
    const existing = savedId ? await deps.store.getProfile(userId, savedId) : null;
    if (!existing) {
      const all = await deps.store.listProfiles(userId);
      if (all.length >= ALICE_LIMITS.savedProfiles) {
        throw new HttpError('conflict', 'You have saved as many job profiles as Alice keeps. Delete one first.', { reason: ALICE_ERROR_REASONS.profileLimit });
      }
    }
    const filters = filtersFromProfile(profile, brief, market);
    let searchId: string | null = existing?.searchProfileId ?? null;
    let previousFilters: unknown = existing?.previousFilters ?? null;
    let search: AliceSearchRef | null = null;
    if (mode !== 'none') {
      const { items, cap } = await deps.searches(userId);
      const linked = searchId ? items.find((s) => s.id === searchId) : undefined;
      if (linked && mode === 'auto') {
        const updated = await deps.replaceSearch(userId, linked.id, { version: linked.version, filters });
        if (!updated.isActive) await deps.activateSearch(userId, linked.id);
        search = { id: updated.id, name: updated.name, mode: 'updated' };
      } else if (mode === 'replace') {
        const target = items.find((s) => s.isActive) ?? items.find((s) => s.isDefault) ?? items[0];
        if (!target) throw new HttpError('conflict', 'There is no saved search to use.', { reason: ALICE_ERROR_REASONS.searchFull });
        if (target.id !== linked?.id) previousFilters = target.filters;
        const updated = await deps.replaceSearch(userId, target.id, { version: target.version, filters });
        if (!updated.isActive) await deps.activateSearch(userId, target.id);
        searchId = target.id;
        search = { id: updated.id, name: updated.name, mode: target.id === linked?.id ? 'updated' : 'replaced' };
      } else if (items.length < cap) {
        const created = await deps.createSearch(userId, { name, filters, activate: true });
        searchId = created.id;
        previousFilters = null;
        search = { id: created.id, name: created.name, mode: 'created' };
      } else {
        throw new HttpError('conflict', 'There is no room for another saved search.', { reason: ALICE_ERROR_REASONS.searchFull });
      }
    } else if (searchId) {
      const linked = (await deps.searches(userId)).items.find((s) => s.id === searchId);
      search = linked ? { id: linked.id, name: linked.name, mode: 'kept' } : null;
      if (!linked) searchId = null;
    }
    const stored = { ...profile, id: existing?.id ?? 'p' };
    const row = existing
      ? await deps.store.updateProfile(userId, existing.id, { name, profile: stored, searchProfileId: searchId, previousFilters: previousFilters ?? null, version: existing.version + 1, status: 'active' })
      : await deps.store.createProfile({ userId, name, profile: stored, searchProfileId: searchId, previousFilters: previousFilters ?? null, status: 'active', version: 1 });
    if (!existing) {
      // The stored profile carries its own id once it has one.
      return { row: await deps.store.updateProfile(userId, row.id, { profile: { ...stored, id: row.id } }), search };
    }
    return { row, search };
  }

  async function editSaved(t: Turn, profileId: string): Promise<void> {
    const saved = await deps.store.getProfile(t.userId, profileId);
    const profile = saved ? cleanProfile(saved.profile, 'p', 'stored') : null;
    if (!saved || !profile) throw new HttpError('not_found', 'That job profile is gone.', { reason: ALICE_ERROR_REASONS.profileNotFound });
    await t.user('', [{ type: 'action', action: 'edit_profile', label: saved.name }]);
    const first = revision(1, profile, null, { origin: 'saved_profile' });
    await t.patch({ stage: 'refining', revisions: [first], currentVersion: 1, savedProfileId: saved.id, drafts: [], pending: null });
    await t.alice('', [{ type: 'revision', version: 1, changed: [] }], 'editor');
  }

  // ── Jobs ─────────────────────────────────────────────────────────────────

  async function scout(userId: string, profile: AliceJobProfile, brief: AliceBrief, market: AliceMarket, locale: string, limit: number): Promise<AliceMatchView[]> {
    const filters = filtersFromProfile(profile, brief, market);
    const items = await deps.matches(userId, { filters, relevance: relevanceText(profile), limit, locale });
    const named = new Set(profile.companies.filter((c) => c.source === 'you').map((c) => c.name.toLocaleLowerCase()));
    return items.slice(0, limit).map((job) => ({ job, meets: meetsOf(job, profile, filters), atNamedCompany: named.has(job.company.name.toLocaleLowerCase()) }));
  }

  /** The profile fields a job meets, from the job's own fields (never a guess). */
  function meetsOf(job: AliceMatchView['job'], profile: AliceJobProfile, filters: FilterSet): AliceProfileField[] {
    const out: AliceProfileField[] = [];
    const title = job.title.toLocaleLowerCase();
    if ([...profile.titles, ...profile.searchTitles].some((t) => title.includes(t.toLocaleLowerCase()) || t.toLocaleLowerCase().includes(title))) out.push('titles');
    if (job.seniority && (profile.levels as string[]).includes(job.seniority)) out.push('levels');
    if (job.workModel && (filters.workModels ?? []).includes(job.workModel)) out.push('workModels');
    if (job.location && profile.places.some((p) => p.city && job.location!.toLocaleLowerCase().includes(p.city.toLocaleLowerCase()))) out.push('places');
    if (profile.pay && job.pay && job.pay.currency === profile.pay.currency && job.pay.period === profile.pay.period && (job.pay.max ?? job.pay.min ?? 0) >= profile.pay.amount) out.push('pay');
    if (job.atTargetCompany || profile.companies.some((c) => c.name.toLocaleLowerCase() === job.company.name.toLocaleLowerCase())) out.push('companies');
    return out;
  }

  async function profileForJobs(t: Turn): Promise<AliceJobProfile | null> {
    if (t.row.savedProfileId) {
      const saved = await deps.store.getProfile(t.userId, t.row.savedProfileId);
      const p = saved ? cleanProfile(saved.profile, saved.id, 'stored') : null;
      if (p) return p;
    }
    const revisions = revisionsOf(t.row);
    return (revisions.find((r) => r.version === t.row.currentVersion) ?? revisions[revisions.length - 1])?.profile ?? null;
  }

  async function findJobs(t: Turn, afterSave = false): Promise<void> {
    const profile = await profileForJobs(t);
    if (!profile) {
      await t.notice('no_profile');
      return;
    }
    let count = 0;
    try {
      const matches = await t.step('finding_jobs', () => scout(t.userId, profile, t.brief, t.market, t.ctx.locale, ALICE_LIMITS.matches));
      count = matches.length;
    } catch (err) {
      logger.warn('ALICE', 'job scout failed', { error: err instanceof Error ? err.message : String(err) });
      if (afterSave) return;
      throw err;
    }
    await t.alice('', [{ type: 'matches', profileId: t.row.savedProfileId ?? 'current', count }], 'scout');
  }

  async function matches(userId: string, profileId: string, limit: number, ctx: AliceContext): Promise<AliceMatchesResponse> {
    const saved = await deps.store.getProfile(userId, profileId);
    const profile = saved ? cleanProfile(saved.profile, saved.id, 'stored') : null;
    if (!saved || !profile) throw new HttpError('not_found', 'That job profile is gone.', { reason: ALICE_ERROR_REASONS.profileNotFound });
    const thread = await deps.store.activeThread(userId);
    const brief = thread ? cleanBrief(thread.brief) : EMPTY_BRIEF;
    const items = await scout(userId, profile, brief, marketOf(deps.brand()), ctx.locale, limit);
    return { profileId, items, searchId: saved.searchProfileId };
  }

  // ── Applications ─────────────────────────────────────────────────────────

  async function applications(userId: string): Promise<AliceApplicationsView> {
    const market = marketOf(deps.brand());
    const now = deps.now();
    const today = isoDay(now);
    const [{ entries, statusCounts }, facts, agentOn] = await Promise.all([deps.trackerEntries(userId), deps.trackerFacts(userId).catch(() => []), deps.flag('agent', userId).catch(() => false)]);
    const ready = agentOn ? await deps.readyToCheck(userId).catch(() => null) : null;
    const sum = (statuses: readonly string[]) => statuses.reduce((n, s) => n + (statusCounts[s] ?? 0), 0);
    const terminal = new Set<string>(TERMINAL_STATUSES);
    const open = entries.filter((e) => !terminal.has(e.status));
    const reminders: AliceReminderView[] = open
      .filter((e): e is TrackerEntryLite & { followUpAt: string } => !!e.followUpAt)
      .map((e) => ({ entryId: e.id, company: e.company, title: e.title, status: e.status, date: e.followUpAt.slice(0, 10), due: e.followUpAt.slice(0, 10) <= today }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 10);
    const needs = needsYou(facts, ready ?? []);
    const activeTotal = Object.entries(statusCounts).reduce((n, [s, c]) => n + (terminal.has(s) ? 0 : c), 0);
    const weekAgo = now.getTime() - 7 * DAY_MS;
    const reportFacts: AliceReportFacts = {
      active: activeTotal,
      waiting: sum(AWAITING_REPLY_STATUSES),
      interviewing: sum(INTERVIEW_STATUSES),
      offers: sum(OFFER_STATUSES),
      needsYou: needs.length,
      noReply: facts.filter((f) => f.reason === 'no_reply_10d').length,
      remindersDue: reminders.filter((r) => r.due).length,
      readyToCheck: ready ? ready.length : null,
      appliedThisWeek: entries.filter((e) => e.dateApplied && Date.parse(e.dateApplied) >= weekAgo).length,
    };
    return {
      market,
      stages: ladderFor(market).map((status) => ({ status, count: statusCounts[status] ?? 0 })),
      facts: reportFacts,
      needsYou: needs,
      reminders,
      open: open.slice(0, 50).map((e) => ({ entryId: e.id, company: e.company, title: e.title, status: e.status, followUpAt: e.followUpAt })),
      asOf: now.toISOString(),
    };
  }

  async function report(t: Turn, question: string | null): Promise<void> {
    const board = await t.step('checking_applications', () => applications(t.userId));
    const facts = board.facts;
    if (facts.active === 0 && (facts.readyToCheck ?? 0) === 0) {
      await t.alice('', [{ type: 'report', facts }, { type: 'notice', code: 'no_applications' }], 'reporter');
      return;
    }
    const allowed = new Set<number>([...Object.values(facts).filter((v): v is number => typeof v === 'number'), ...board.needsYou.map((n) => n.days ?? -1), ...board.stages.map((s) => s.count)]);
    let text = '';
    try {
      const out = await deps.agents.reporter.run(
        {
          locale: t.ctx.locale,
          voice: t.voice,
          facts,
          needs: board.needsYou.map((n) => `${n.kind}: ${n.company ?? '?'}, ${n.title ?? '?'}${n.days !== null ? ` (${n.days} days)` : ''}`),
          question,
        },
        t.opts(),
      );
      text = clip(out.message, 700);
      if (text && !numbersAreFacts(text, allowed)) {
        logger.warn('ALICE', 'report wording dropped: a number is not a fact');
        text = '';
      }
    } catch (err) {
      logger.warn('ALICE', 'reporter failed; facts shown alone', { error: err instanceof Error ? err.message : String(err) });
    }
    await t.alice(text, [{ type: 'report', facts }], 'reporter');
  }

  async function setReminder(userId: string, entryId: string, date: string | null): Promise<AliceReminderView | null> {
    const entry = await deps.setFollowUp(userId, entryId, date);
    if (!entry.followUpAt) return null;
    const day = entry.followUpAt.slice(0, 10);
    return { entryId: entry.id, company: entry.company, title: entry.title, status: entry.status, date: day, due: day <= isoDay(deps.now()) };
  }

  // ── Routing free text after the intake ───────────────────────────────────

  async function route(t: Turn, text: string): Promise<void> {
    const brief = t.brief;
    const stage = t.row.stage;
    const drafts = stage === 'choosing' ? draftsOf(t.row) : [];
    const current = await profileForJobs(t);
    const board = stage === 'saved' ? await applications(t.userId).catch(() => null) : null;
    let decision: RouterOutput;
    try {
      decision = await t.step('thinking', () =>
        deps.agents.router.run(
          {
            locale: t.ctx.locale,
            voice: t.voice,
            stage,
            today: isoDay(deps.now()),
            message: text,
            drafts: drafts.map((d) => ({ id: d.id, label: d.label, headline: d.headline })),
            profile: current ? `${current.label}: ${current.headline}` : null,
            applications: (board?.open ?? []).slice(0, 30).map((o) => ({ entryId: o.entryId, company: o.company, title: o.title, status: o.status })),
          },
          t.opts(),
        ),
      );
    } catch (err) {
      throw agentFailed(err, 'router');
    }
    return act(t, decision, text, stage, board);
  }

  async function act(t: Turn, d: RouterOutput, text: string, stage: AliceStage, board: AliceApplicationsView | null): Promise<void> {
    const comment = clip(d.comment, ALICE_LIMITS.commentChars) || text.slice(0, ALICE_LIMITS.commentChars);
    switch (d.action) {
      case 'choose':
        if (stage === 'choosing' && d.draftId) return choose(t, d.draftId, clip(d.comment, ALICE_LIMITS.commentChars) || null, false);
        break;
      case 'regenerate':
        if (stage === 'choosing' || stage === 'refining') {
          await deps.rateLimit('aliceDraft', t.userId);
          return draftPair(t, comment);
        }
        break;
      case 'refine':
        if (stage === 'refining') {
          await deps.rateLimit('aliceDraft', t.userId);
          return refine(t, comment);
        }
        if (stage === 'saved' && t.row.savedProfileId) {
          await deps.rateLimit('aliceDraft', t.userId);
          await editSavedQuiet(t, t.row.savedProfileId);
          return refine(t, comment);
        }
        break;
      case 'save':
        if (stage === 'refining') {
          const target = await saveTargetFor(t.userId, t.row);
          if (target?.mode === 'choose') {
            await t.notice('search_full');
            return;
          }
          return save(t, null, 'auto');
        }
        break;
      case 'find_jobs':
        return findJobs(t);
      case 'report':
        return report(t, text);
      case 'set_reminder':
      case 'clear_reminder':
        return remind(t, d, board);
      case 'new_profile': {
        const brief = t.brief;
        const resumeVariantId = t.row.resumeVariantId;
        await deps.store.archiveThread(t.userId, t.row.id);
        const fresh = await deps.store.createThread({ userId: t.userId, brand: t.brand.id, locale: t.ctx.locale });
        t.row = await deps.store.updateThread(t.userId, fresh.id, { brief: { ...brief, roles: [], levels: [] }, resumeVariantId, resumeSkipped: !resumeVariantId });
        await t.user(text);
        return ask(t, null);
      }
      case 'answer':
      default:
        break;
    }
    await t.alice(clip(d.reply, 900), [], 'router');
  }

  /** Back to refining on the saved profile, without a line in the conversation (the comment that follows is the line). */
  async function editSavedQuiet(t: Turn, profileId: string): Promise<void> {
    const saved = await deps.store.getProfile(t.userId, profileId);
    const profile = saved ? cleanProfile(saved.profile, 'p', 'stored') : null;
    if (!saved || !profile) throw new HttpError('not_found', 'That job profile is gone.', { reason: ALICE_ERROR_REASONS.profileNotFound });
    await t.patch({ stage: 'refining', revisions: [revision(1, profile, null, { origin: 'saved_profile' })], currentVersion: 1, drafts: [] });
  }

  async function remind(t: Turn, d: RouterOutput, board: AliceApplicationsView | null): Promise<void> {
    const open = board?.open ?? (await applications(t.userId)).open;
    const ids = d.entryIds.filter((id) => open.some((o) => o.entryId === id));
    if (ids.length === 0) {
      await t.alice(clip(d.reply, 400), [{ type: 'notice', code: 'reminder_unknown' }], 'reminders');
      return;
    }
    const today = isoDay(deps.now());
    const date = d.action === 'clear_reminder' ? null : d.date && d.date >= today ? d.date : null;
    if (d.action === 'set_reminder' && !date) {
      await t.alice(clip(d.reply, 400), [{ type: 'notice', code: 'reminder_unknown' }], 'reminders');
      return;
    }
    if (ids.length > 1) {
      const options = ids.map((id) => open.find((o) => o.entryId === id)!).map((o) => ({ entryId: o.entryId, company: o.company, title: o.title }));
      await t.alice('', [{ type: 'choice', date, options }, { type: 'notice', code: 'reminder_ambiguous' }], 'reminders');
      return;
    }
    const entry = await t.step('checking_applications', () => deps.setFollowUp(t.userId, ids[0], date));
    await t.alice('', [{ type: 'reminder', entryId: entry.id, company: entry.company, title: entry.title, date: entry.followUpAt ? entry.followUpAt.slice(0, 10) : null }], 'reminders');
  }

  // ── Saved profiles (REST) ────────────────────────────────────────────────

  async function listProfiles(userId: string): Promise<AliceProfilesResponse> {
    const rows = await deps.store.listProfiles(userId);
    const searches = rows.some((r) => r.searchProfileId) ? (await deps.searches(userId).catch(() => ({ items: [] as SearchRef[], cap: 0 }))).items : [];
    const items = (await Promise.all(rows.map((r) => savedView(userId, r, searches)))).filter((v): v is AliceSavedProfileView => v !== null);
    return { items };
  }

  async function patchProfile(userId: string, id: string, body: AlicePatchProfileBody): Promise<AliceSavedProfileView> {
    const row = await deps.store.getProfile(userId, id);
    if (!row) throw new HttpError('not_found', 'That job profile is gone.', { reason: ALICE_ERROR_REASONS.profileNotFound });
    let previousFilters = row.previousFilters;
    if (body.undoReplace) {
      const search = row.searchProfileId ? (await deps.searches(userId)).items.find((s) => s.id === row.searchProfileId) : undefined;
      if (!search || previousFilters === null || previousFilters === undefined) throw new HttpError('conflict', 'There is nothing to undo.');
      await deps.replaceSearch(userId, search.id, { version: search.version, filters: previousFilters as FilterSet });
      previousFilters = null;
    }
    const updated = await deps.store.updateProfile(userId, id, {
      ...(body.name ? { name: body.name } : {}),
      ...(body.status ? { status: body.status } : {}),
      ...(body.undoReplace ? { previousFilters: null, searchProfileId: null } : {}),
    });
    const v = await savedView(userId, updated);
    if (!v) throw new HttpError('internal_error', 'The job profile could not be read.');
    return v;
  }

  async function deleteProfile(userId: string, id: string): Promise<void> {
    await deps.store.deleteProfile(userId, id);
    const thread = await deps.store.activeThread(userId);
    if (thread?.savedProfileId === id) await deps.store.updateThread(userId, thread.id, { savedProfileId: null, ...(thread.stage === 'saved' ? { stage: 'refining' as const } : {}) });
  }

  return {
    getThread,
    turn,
    listProfiles,
    patchProfile,
    deleteProfile,
    matches,
    applications,
    setReminder,
  };
}

export type AliceService = ReturnType<typeof createAliceService>;

let impl: AliceService | null = null;

/** The process-wide service (default deps). */
export async function getAliceService(): Promise<AliceService> {
  if (!impl) {
    const { defaultAliceDeps } = await import('./deps.js');
    impl = createAliceService(defaultAliceDeps());
  }
  return impl;
}
