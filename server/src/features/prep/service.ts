// server/src/features/prep/service.ts — the question bank (WP-59; F-INT-01, F-INT-03).
//
// Seeker side:
//   listCompanies / companyQuestions   companies with MODERATED user reports only
//                                      (month and count; no AI or staff items)
//   curatedQuestions                   staff-written, generic practice questions
//   getQuestion / generateGuide        one question; the AI guide is written on
//                                      first view (30/day/user), always labelled
//   jobSet / generateJobSet            AI questions written from one job post
//                                      (+ titles of the company's other open posts),
//                                      never attributed to the company
//   planForJob                         the Assistant's `interview_prep` tool
//                                      (read only unless `write: true`)
//   report / contribute                moderated; 10/day each
// Staff side: moderation of contributions, reported/hidden questions, and
// staff-written questions.
//
// D3: every item carries sourceKind; `assertAttribution` (rules.ts) runs on
// every write, so a curated or AI item can never carry a company. Nothing here
// fabricates counts: company counts are counts of stored, moderated rows.

import { HttpError, type Sourced } from '../../platform/http.js';
import {
  AUTO_HIDE_REPORTS,
  JOB_SET_SIZE,
  PREP_ERROR_CODES,
  SOURCE_LABEL_KEYS,
  type AdminQuestionListResponse,
  type AdminQuestionView,
  type CompaniesResponse,
  type CompanyQuestionsResponse,
  type ContributionListResponse,
  type ContributionReceipt,
  type ContributionStatus,
  type ContributionView,
  type GuideStatus,
  type JobQuestionSetResponse,
  type PrepCompanyView,
  type QuestionDetail,
  type QuestionGuide,
  type QuestionListResponse,
  type QuestionView,
  type ReportQuestionResponse,
  type QuestionCategory,
  type QuestionDifficulty,
  type QuestionLocale,
  type RejectReason,
  QuestionGuideSchema,
  QUESTION_REPORT_REASONS,
} from './contract.js';
import { asCategory, asDifficulty, assertAttribution, claimsCompanyAsked, guessQuestionLocale, isValidPeriod, screenContribution } from './rules.js';
import type { CompanyKey, CompanyRecord, ContributionRow, NewQuestion, PrepStore, QuestionRow } from './store.js';
import type { GeneratedQuestion, GuideInput, QuestionSetInput } from './agents.js';
import { jobSetKey, type JobSetIndex } from './jobSetIndex.js';

export type BudgetKind = 'guide' | 'jobSet' | 'contribution' | 'report';

export interface PrepJob {
  id: string;
  title: string;
  companyName: string;
  companyId: string | null;
  companySlug: string | null;
  /** The posting text (verbatim sections). */
  text: string;
}

export interface PrepServiceDeps {
  store: PrepStore;
  jobSets: JobSetIndex;
  market(): 'intl' | 'cn';
  now(): Date;
  /** `aiAllowed(user)` AND the brand's `ai.text` capability. */
  aiAvailable(userId: string): Promise<boolean>;
  /** Daily per-user limits; `allowed: false` → 429. */
  budget(kind: BudgetKind, userId: string): Promise<{ allowed: boolean; retryAfterSec: number }>;
  /** Market- and visibility-checked job (404 when the user may not see it). */
  loadJob(userId: string, jobId: string): Promise<PrepJob>;
  /** Extra posting filter (GoApply recruitment-info mode); undefined = none. */
  postingWhere?(userId: string): Record<string, unknown> | undefined;
  normalizeCompany(name: string): string;
  generateSet(input: QuestionSetInput): Promise<GeneratedQuestion[]>;
  generateGuide(input: GuideInput): Promise<QuestionGuide | null>;
  modelId(): string | null;
}

const PAGE = 20;
const COMPANY_PAGE = 30;
const COMPANY_REPORTS_IN_SET = 5;

const notFound = () => new HttpError('not_found');

function rateLimited(reason: string, retryAfterSec: number): HttpError {
  const sec = Math.max(1, Math.ceil(retryAfterSec));
  return new HttpError('rate_limited', undefined, { reason, retryAfterSec: sec }, { 'Retry-After': String(sec) });
}

interface CompanyInfo {
  slug: string;
  name: string;
}

export class PrepService {
  constructor(private readonly deps: PrepServiceDeps) {}

  // ── Views ──────────────────────────────────────────────────────────────

  toView(row: QuestionRow, company: CompanyInfo | null = null): QuestionView {
    const isReport = row.sourceKind === 'user_report';
    const kind = isReport || row.sourceKind === 'curated' ? row.sourceKind : 'ai_practice';
    return {
      id: row.id,
      companySlug: isReport ? (company?.slug ?? null) : null,
      companyName: isReport ? (company?.name ?? null) : null,
      title: row.title,
      body: row.body,
      category: asCategory(row.category),
      difficulty: asDifficulty(row.difficulty),
      seniority: row.seniority,
      locale: row.locale,
      sourceKind: kind as QuestionView['sourceKind'],
      sourceLabelKey: SOURCE_LABEL_KEYS[kind as QuestionView['sourceKind']],
      reportedPeriod: isReport ? row.reportedPeriod : null,
      aiGenerated: kind === 'ai_practice',
    };
  }

  private guideOf(row: QuestionRow): QuestionGuide | null {
    if (!row.guide) return null;
    const parsed = QuestionGuideSchema.safeParse(row.guide);
    return parsed.success ? parsed.data : null;
  }

  /** Company names/slugs for user reports (record first, then the name a user typed). */
  private async companyInfo(rows: QuestionRow[]): Promise<Map<string, CompanyInfo>> {
    const reports = rows.filter((r) => r.sourceKind === 'user_report' && r.companyNameNormalized);
    const out = new Map<string, CompanyInfo>();
    if (!reports.length) return out;
    const ids = [...new Set(reports.map((r) => r.companyId).filter((v): v is string => Boolean(v)))];
    const records = new Map((await this.deps.store.companiesByIds(ids)).map((c) => [c.id, c]));
    const names = await this.deps.store.contributedNames(this.deps.market(), [...new Set(reports.map((r) => r.companyNameNormalized as string))]);
    for (const r of reports) {
      const rec = r.companyId ? records.get(r.companyId) : undefined;
      const typed = names.get(r.companyNameNormalized as string);
      if (rec) out.set(r.id, { slug: rec.slug, name: rec.displayName });
      else out.set(r.id, { slug: typed ?? (r.companyNameNormalized as string), name: typed ?? (r.companyNameNormalized as string) });
    }
    return out;
  }

  private async views(rows: QuestionRow[]): Promise<QuestionView[]> {
    const info = await this.companyInfo(rows);
    return rows.map((r) => this.toView(r, info.get(r.id) ?? null));
  }

  private countOf(count: number): Sourced<number> {
    return { value: count, source: 'user_reports', method: 'moderated_user_reports', asOf: this.deps.now().toISOString() };
  }

  /** A seeker may see a published question of their market. */
  private async visibleQuestion(id: string): Promise<QuestionRow> {
    const row = await this.deps.store.getQuestion(id);
    if (!row || row.market !== this.deps.market() || row.status !== 'published') throw notFound();
    return row;
  }

  // ── Writes (every write passes the attribution check) ──────────────────

  private checkQuestion(input: NewQuestion): void {
    assertAttribution(input);
    if (input.sourceKind === 'user_report' && !input.companyNameNormalized) {
      throw new HttpError('invalid_request', 'A shared question names the company it was asked at.', { reason: 'company_required' });
    }
  }

  async createQuestion(input: NewQuestion): Promise<QuestionRow> {
    this.checkQuestion(input);
    return this.deps.store.createQuestion(input);
  }

  // ── Companies ──────────────────────────────────────────────────────────

  async listCompanies(q: { q?: string; cursor?: string }): Promise<CompaniesResponse> {
    const market = this.deps.market();
    const offset = Math.max(0, Number.parseInt(q.cursor ?? '0', 10) || 0);
    const nameContains = q.q ? this.deps.normalizeCompany(q.q) || undefined : undefined;
    const groups = await this.deps.store.listCompanyGroups(market, { nameContains, offset, take: COMPANY_PAGE + 1 });
    const more = groups.length > COMPANY_PAGE;
    const page = more ? groups.slice(0, COMPANY_PAGE) : groups;
    const records = new Map(
      (await this.deps.store.companiesByIds([...new Set(page.map((g) => g.companyId).filter((v): v is string => Boolean(v)))])).map((c) => [c.id, c]),
    );
    const typed = await this.deps.store.contributedNames(
      market,
      page.filter((g) => !g.companyId || !records.has(g.companyId)).map((g) => g.nameNormalized),
    );
    // The store groups by normalized name, so one company is one group. Merging by
    // route segment only guards two names that resolve to the same record.
    const merged = new Map<string, PrepCompanyView>();
    for (const g of page) {
      const rec = g.companyId ? records.get(g.companyId) : undefined;
      const name = rec?.displayName ?? typed.get(g.nameNormalized) ?? g.nameNormalized;
      const slug = rec?.slug ?? name;
      const prev = merged.get(slug);
      const count = (prev?.questionCount.value ?? 0) + g.count;
      const latest = [prev?.latestPeriod, g.latestPeriod].filter((v): v is string => Boolean(v)).sort().pop() ?? null;
      merged.set(slug, { slug, name, hasCompanyRecord: Boolean(rec) || Boolean(prev?.hasCompanyRecord), questionCount: this.countOf(count), latestPeriod: latest });
    }
    return { items: [...merged.values()], cursor: more ? String(offset + COMPANY_PAGE) : null };
  }

  /** Resolve a route segment: a company slug, or the (decoded) company name. */
  private async resolveCompany(segment: string): Promise<{ key: CompanyKey; slug: string; name: string; record: CompanyRecord | null }> {
    const market = this.deps.market();
    const raw = segment.trim();
    const bySlug = await this.deps.store.companyBySlug(market, raw);
    if (bySlug) return { key: { companyId: bySlug.id, nameNormalized: bySlug.nameNormalized }, slug: bySlug.slug, name: bySlug.displayName, record: bySlug };
    const nameNormalized = this.deps.normalizeCompany(raw);
    if (!nameNormalized) throw notFound();
    const byName = await this.deps.store.companyByNormalizedName(market, nameNormalized);
    if (byName) return { key: { companyId: byName.id, nameNormalized }, slug: byName.slug, name: byName.displayName, record: byName };
    const typed = (await this.deps.store.contributedNames(market, [nameNormalized])).get(nameNormalized);
    return { key: { companyId: null, nameNormalized }, slug: raw, name: typed ?? raw, record: null };
  }

  async companyQuestions(segment: string, q: { category?: QuestionCategory; seniority?: string; cursor?: string }): Promise<CompanyQuestionsResponse> {
    const market = this.deps.market();
    const company = await this.resolveCompany(segment);
    const [stats, page] = await Promise.all([
      this.deps.store.companyStats(market, company.key),
      this.deps.store.listQuestions(
        { market, sourceKind: 'user_report', status: 'published', company: company.key, category: q.category, seniority: q.seniority },
        { cursor: q.cursor, take: PAGE },
      ),
    ]);
    const info: CompanyInfo = { slug: company.slug, name: company.name };
    return {
      company: { slug: company.slug, name: company.name, hasCompanyRecord: Boolean(company.record) },
      count: stats.count > 0 ? this.countOf(stats.count) : null,
      latestPeriod: stats.latestPeriod,
      items: page.rows.map((r) => this.toView(r, info)),
      cursor: page.cursor,
    };
  }

  /**
   * Staff questions in the reader's language; the site's main language (en, or
   * zh on GoApply) when there are none in it. Decided from the same filters on
   * every page, so paging stays consistent.
   */
  async curatedQuestions(q: { category?: QuestionCategory; cursor?: string }, locale?: string): Promise<QuestionListResponse> {
    const market = this.deps.market();
    const fallback = market === 'cn' ? 'zh' : 'en';
    const where = { market, sourceKind: 'curated', status: 'published' as const, category: q.category };
    let lang = locale || fallback;
    if (lang !== fallback) {
      const probe = await this.deps.store.listQuestions({ ...where, locale: lang }, { take: 1 });
      if (!probe.rows.length) lang = fallback;
    }
    const page = await this.deps.store.listQuestions({ ...where, locale: lang }, { cursor: q.cursor, take: PAGE });
    return { items: page.rows.map((r) => this.toView(r)), cursor: page.cursor };
  }

  // ── One question + its guide ───────────────────────────────────────────

  private async detail(row: QuestionRow, status: GuideStatus): Promise<QuestionDetail> {
    const [view] = await this.views([row]);
    const guide = this.guideOf(row);
    return { ...(view as QuestionView), guide, guideStatus: guide ? 'ready' : status };
  }

  async getQuestion(userId: string, id: string): Promise<QuestionDetail> {
    const row = await this.visibleQuestion(id);
    if (this.guideOf(row)) return this.detail(row, 'ready');
    return this.detail(row, (await this.deps.aiAvailable(userId)) ? 'not_generated' : 'ai_unavailable');
  }

  /** The guide is written once per question (on its first view) and kept. */
  async generateGuide(userId: string, id: string, locale: string): Promise<QuestionDetail> {
    const row = await this.visibleQuestion(id);
    if (this.guideOf(row)) return this.detail(row, 'ready');
    if (!(await this.deps.aiAvailable(userId))) throw new HttpError('ai_unavailable');
    const budget = await this.deps.budget('guide', userId);
    if (!budget.allowed) throw rateLimited(PREP_ERROR_CODES.guideLimit, budget.retryAfterSec);
    const guide = await this.deps.generateGuide({ locale: row.locale || locale, question: { title: row.title, body: row.body, category: row.category } });
    if (!guide) throw new HttpError('ai_unavailable', 'The guide could not be written. Try again later.', { reason: 'empty_output' });
    const saved = await this.deps.store.updateQuestion(row.id, { guide, guideModel: this.deps.modelId() });
    return this.detail(saved, 'ready');
  }

  // ── Reports and contributions ──────────────────────────────────────────

  async report(userId: string, id: string, body: { reason: (typeof QUESTION_REPORT_REASONS)[number]; note?: string }): Promise<ReportQuestionResponse> {
    const row = await this.visibleQuestion(id);
    const budget = await this.deps.budget('report', userId);
    if (!budget.allowed) throw rateLimited('report_daily_limit', budget.retryAfterSec);
    // reportsCount counts reports since the last staff review (restore clears it).
    const { reportsCount } = await this.deps.store.addReport(row.id, userId, body.reason, body.note?.trim() || null);
    // Hide until staff look at it once enough different people reported it.
    const hide = reportsCount >= AUTO_HIDE_REPORTS;
    if (hide) await this.deps.store.updateQuestion(row.id, { status: 'hidden' });
    return { reported: true, hidden: hide };
  }

  async contribute(userId: string, body: { company: string; role?: string; question: string; period: string }): Promise<ContributionReceipt> {
    if (!isValidPeriod(body.period, this.deps.now())) {
      throw new HttpError('invalid_request', 'Pick the month you were asked (not in the future).', { reason: 'invalid_period' });
    }
    if (!this.deps.normalizeCompany(body.company)) throw new HttpError('invalid_request', 'Name the company.', { reason: 'company_required' });
    const budget = await this.deps.budget('contribution', userId);
    if (!budget.allowed) throw rateLimited('contribution_daily_limit', budget.retryAfterSec);
    const row = await this.deps.store.createContribution({
      userId,
      market: this.deps.market(),
      companyName: body.company.trim(),
      role: body.role?.trim() ?? '',
      interviewYm: body.period,
      body: body.question.trim(),
    });
    return { id: row.id, status: 'pending' };
  }

  // ── Job sets (AI, written from the job post) ───────────────────────────

  private companyKeyOf(job: PrepJob): CompanyKey | null {
    const nameNormalized = this.deps.normalizeCompany(job.companyName);
    if (!job.companyId && !nameNormalized) return null;
    return { companyId: job.companyId, nameNormalized };
  }

  private async companyReportsFor(job: PrepJob): Promise<QuestionView[]> {
    const key = this.companyKeyOf(job);
    if (!key) return [];
    const page = await this.deps.store.listQuestions(
      { market: this.deps.market(), sourceKind: 'user_report', status: 'published', company: key },
      { take: COMPANY_REPORTS_IN_SET },
    );
    const info: CompanyInfo = { slug: job.companySlug ?? job.companyName, name: job.companyName };
    return page.rows.map((r) => this.toView(r, info));
  }

  private async storedSet(job: PrepJob, locale: string): Promise<{ rows: QuestionRow[]; generatedAt: Date } | null> {
    const entry = await this.deps.jobSets.get(jobSetKey(this.deps.market(), job.id, locale));
    if (!entry) return null;
    const rows = (await this.deps.store.getQuestions(entry.questionIds)).filter((r) => r.status === 'published' && r.sourceKind === 'ai_practice');
    return rows.length ? { rows, generatedAt: entry.generatedAt } : null;
  }

  private setResponse(job: PrepJob, status: JobQuestionSetResponse['status'], set: { rows: QuestionRow[]; generatedAt: Date } | null, reports: QuestionView[]): JobQuestionSetResponse {
    const hasCompany = Boolean(job.companySlug || job.companyName.trim());
    return {
      jobId: job.id,
      jobTitle: job.title,
      companyName: job.companyName,
      companySlug: hasCompany ? (job.companySlug ?? job.companyName.trim()) : null,
      status,
      generatedAt: set ? set.generatedAt.toISOString() : null,
      aiQuestions: set ? set.rows.map((r) => this.toView(r)) : [],
      companyReports: reports,
    };
  }

  /** Read only: never calls a model. */
  async jobSet(userId: string, jobId: string, locale: string): Promise<JobQuestionSetResponse> {
    const job = await this.deps.loadJob(userId, jobId);
    const [set, reports] = await Promise.all([this.storedSet(job, locale), this.companyReportsFor(job)]);
    if (set) return this.setResponse(job, 'ready', set, reports);
    return this.setResponse(job, (await this.deps.aiAvailable(userId)) ? 'not_generated' : 'ai_unavailable', null, reports);
  }

  /** Writes the AI set for a job (once per job and language; the user asked for it). */
  async generateJobSet(userId: string, jobId: string, locale: string): Promise<JobQuestionSetResponse> {
    const job = await this.deps.loadJob(userId, jobId);
    const reports = await this.companyReportsFor(job);
    const existing = await this.storedSet(job, locale);
    if (existing) return this.setResponse(job, 'ready', existing, reports);
    if (!(await this.deps.aiAvailable(userId))) throw new HttpError('ai_unavailable');
    const budget = await this.deps.budget('jobSet', userId);
    if (!budget.allowed) throw rateLimited(PREP_ERROR_CODES.jobSetLimit, budget.retryAfterSec);

    const market = this.deps.market();
    const otherTitles = await this.deps.store.otherPostingTitles({
      jobId: job.id,
      companyId: job.companyId,
      companyNameNormalized: this.deps.normalizeCompany(job.companyName) || null,
      market,
      take: 8,
      where: this.deps.postingWhere?.(userId),
    });
    const generated = await this.deps.generateSet({
      locale,
      job: { title: job.title, company: job.companyName, text: job.text },
      otherTitles,
      includeHrRound: market === 'cn',
    });
    const kept = generated.filter((g) => !claimsCompanyAsked(`${g.title}\n${g.body}`, job.companyName)).slice(0, JOB_SET_SIZE);
    if (!kept.length) throw new HttpError('ai_unavailable', 'The questions could not be written. Try again later.', { reason: 'empty_output' });

    const rows: QuestionRow[] = [];
    for (const g of kept) {
      rows.push(
        await this.createQuestion({
          market,
          sourceKind: 'ai_practice',
          // Never attributed to a company (D3): no companyId, no company name.
          companyId: null,
          companyNameNormalized: null,
          taxonomyId: null,
          category: g.category,
          difficulty: g.difficulty,
          seniority: null,
          title: g.title,
          body: g.body,
          locale,
          reportedPeriod: null,
          contributionId: null,
        }),
      );
    }
    const generatedAt = this.deps.now();
    await this.deps.jobSets.put(jobSetKey(market, job.id, locale), { questionIds: rows.map((r) => r.id), generatedAt });
    return this.setResponse(job, 'ready', { rows, generatedAt }, reports);
  }

  /**
   * The Assistant's `interview_prep` tool: the AI set for the job followed by
   * moderated user reports about the company. Each item keeps its own sourceKind.
   *
   * Read only by default (never calls a model): the Assistant may call this on
   * every turn, and until SR-59-1 the job → set link is per process, so writing
   * on each miss would spend a model call and a unit of the daily limit each
   * time. `write: true` — only when the user asked for practice questions —
   * writes the set when it is missing and AI is available; when it cannot be
   * written (AI off, daily limit) the stored state is returned instead.
   */
  async planForJob(userId: string, jobId: string, locale: string, opts: { write?: boolean } = {}): Promise<{ questions: QuestionView[] } & JobQuestionSetResponse> {
    let set: JobQuestionSetResponse;
    if (opts.write) {
      try {
        set = await this.generateJobSet(userId, jobId, locale);
      } catch (err) {
        if (!(err instanceof HttpError) || (err.code !== 'ai_unavailable' && err.code !== 'rate_limited')) throw err;
        set = await this.jobSet(userId, jobId, locale);
      }
    } else {
      set = await this.jobSet(userId, jobId, locale);
    }
    return { ...set, questions: [...set.aiQuestions, ...set.companyReports] };
  }

  // ── Staff: contributions ───────────────────────────────────────────────

  private contributionView(row: ContributionRow): ContributionView {
    return {
      id: row.id,
      companyName: row.companyName,
      role: row.role,
      period: row.interviewYm,
      body: row.body,
      status: (['pending', 'approved', 'rejected'].includes(row.status) ? row.status : 'pending') as ContributionStatus,
      createdAt: row.createdAt.toISOString(),
      moderatedAt: row.moderatedAt ? row.moderatedAt.toISOString() : null,
      flags: screenContribution(row.body, { company: row.companyName, role: row.role }),
      locale: guessQuestionLocale(row.body, this.marketOf(row)),
    };
  }

  async listContributions(q: { status?: ContributionStatus; cursor?: string }): Promise<ContributionListResponse> {
    const page = await this.deps.store.listContributions(this.deps.market(), q.status ?? 'pending', { cursor: q.cursor, take: PAGE });
    return { items: page.rows.map((r) => this.contributionView(r)), cursor: page.cursor };
  }

  private marketOf(row: { market: string }): 'intl' | 'cn' {
    return row.market === 'cn' ? 'cn' : 'intl';
  }

  private async pendingContribution(id: string): Promise<ContributionRow> {
    const row = await this.deps.store.getContribution(id);
    if (!row || row.market !== this.deps.market()) throw notFound();
    if (row.status !== 'pending') throw new HttpError('conflict', 'This was already decided.', { reason: PREP_ERROR_CODES.alreadyModerated, status: row.status });
    return row;
  }

  async approve(
    adminId: string,
    id: string,
    body: {
      category: QuestionCategory;
      title: string;
      body: string;
      companyName?: string;
      difficulty?: QuestionDifficulty;
      seniority?: string;
      locale?: QuestionLocale;
      confirmScreened?: boolean;
    },
  ): Promise<QuestionView> {
    const row = await this.pendingContribution(id);
    // Screen everything that will be published: the title too (the console
    // prefills it from the shared text's first line).
    const published = `${body.title}\n${body.body}`;
    const flags = screenContribution(published, { company: body.companyName ?? row.companyName, role: row.role });
    if (flags.length && !body.confirmScreened) {
      throw new HttpError('conflict', 'Check the flagged text first.', { reason: PREP_ERROR_CODES.screenNotConfirmed, flags });
    }
    const companyName = (body.companyName ?? row.companyName).trim();
    const nameNormalized = this.deps.normalizeCompany(companyName);
    if (!nameNormalized) throw new HttpError('invalid_request', 'Name the company.', { reason: 'company_required' });
    const company = await this.deps.store.companyByNormalizedName(row.market, nameNormalized);

    const newQuestion: NewQuestion = {
      market: row.market,
      sourceKind: 'user_report',
      companyId: company?.id ?? null,
      companyNameNormalized: nameNormalized,
      taxonomyId: null,
      category: body.category,
      difficulty: body.difficulty ?? null,
      seniority: body.seniority?.trim() || null,
      title: body.title,
      body: body.body,
      // Staff's choice (the console prefills the guess), else a guess from the script.
      locale: body.locale ?? guessQuestionLocale(published, this.marketOf(row)),
      reportedPeriod: row.interviewYm,
      contributionId: row.id,
    };
    this.checkQuestion(newQuestion);
    // One transaction: if the question can't be stored, the contribution stays pending.
    // The approved company name replaces the typed one on the contribution: pages
    // with no company record show it (contributedNames), so staff's edit must stick.
    const question = await this.deps.store.approveContribution(row.id, { moderatorId: adminId, moderatedAt: this.deps.now(), companyName }, newQuestion);
    if (!question) throw new HttpError('conflict', 'This was already decided.', { reason: PREP_ERROR_CODES.alreadyModerated });
    await this.audit(row.userId, {
      contributionId: row.id,
      decision: 'approved',
      questionId: question.id,
      moderatorId: adminId,
      // The contributor's own wording of the company, kept for the record when staff changed it.
      ...(companyName !== row.companyName ? { submittedCompanyName: row.companyName } : {}),
    });
    return this.toView(question, company ? { slug: company.slug, name: company.displayName } : { slug: companyName, name: companyName });
  }

  async reject(adminId: string, id: string, body: { reason: RejectReason; note?: string }): Promise<ContributionView> {
    const row = await this.pendingContribution(id);
    const moderatedAt = this.deps.now();
    if (!(await this.deps.store.moderateContribution(row.id, { status: 'rejected', moderatorId: adminId, moderatedAt }))) {
      throw new HttpError('conflict', 'This was already decided.', { reason: PREP_ERROR_CODES.alreadyModerated });
    }
    // SR-59-2: no rejectReason column yet; the audit row keeps it.
    await this.audit(row.userId, { contributionId: row.id, decision: 'rejected', reason: body.reason, note: body.note ?? null, moderatorId: adminId });
    return this.contributionView({ ...row, status: 'rejected', moderatorId: adminId, moderatedAt });
  }

  private async audit(userId: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.deps.store.audit(userId, 'question_contribution_moderated', payload);
    } catch {
      /* best effort: the decision itself is stored on the contribution */
    }
  }

  // ── Staff: questions ───────────────────────────────────────────────────

  async adminQuestions(q: { filter?: 'reported' | 'hidden' | 'curated'; cursor?: string }): Promise<AdminQuestionListResponse> {
    const market = this.deps.market();
    const filter = q.filter ?? 'reported';
    const where =
      filter === 'curated'
        ? { market, sourceKind: 'curated' }
        : filter === 'hidden'
          ? { market, status: 'hidden' as const }
          : { market, status: 'published' as const, reported: true };
    const page = await this.deps.store.listQuestions(where, { cursor: q.cursor, take: PAGE });
    const views = await this.views(page.rows);
    const items: AdminQuestionView[] = await Promise.all(
      page.rows.map(async (r, i) => ({
        ...(views[i] as QuestionView),
        status: r.status === 'hidden' ? ('hidden' as const) : ('published' as const),
        reportsCount: r.reportsCount,
        reports: (await this.deps.store.recentReports(r.id, 5)).map((rep) => ({
          reason: ((QUESTION_REPORT_REASONS as readonly string[]).includes(rep.reason) ? rep.reason : 'other') as AdminQuestionView['reports'][number]['reason'],
          note: rep.note,
          createdAt: rep.createdAt.toISOString(),
        })),
      })),
    );
    return { items, cursor: page.cursor };
  }

  async setQuestionStatus(id: string, status: 'published' | 'hidden'): Promise<QuestionView> {
    const row = await this.deps.store.getQuestion(id);
    if (!row || row.market !== this.deps.market()) throw notFound();
    // Showing a question again is a staff review of its reports: clear the count so
    // auto-hide and the "reported" list only consider reports made after it.
    const saved = await this.deps.store.updateQuestion(id, status === 'published' ? { status, reportsCount: 0 } : { status });
    const [view] = await this.views([saved]);
    return view as QuestionView;
  }

  async createCurated(body: { title: string; body: string; category: QuestionCategory; difficulty?: QuestionDifficulty; seniority?: string; locale: string }): Promise<QuestionView> {
    const row = await this.createQuestion({
      market: this.deps.market(),
      sourceKind: 'curated',
      companyId: null,
      companyNameNormalized: null,
      taxonomyId: null,
      category: body.category,
      difficulty: body.difficulty ?? null,
      seniority: body.seniority?.trim() || null,
      title: body.title,
      body: body.body,
      locale: body.locale,
      reportedPeriod: null,
      contributionId: null,
    });
    return this.toView(row);
  }
}
