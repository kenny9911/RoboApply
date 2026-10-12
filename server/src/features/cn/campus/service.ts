// server/src/features/cn/campus/service.ts — GoApply 校招日历 business logic
// (WP-58; TASK_PLAN.md R-14; CN_TW_LAUNCH_PLAN.md CN-E-08).
//
// Public read: published AND verified programmes of the brand's market only;
// each one carries its official URL, source and last verification date, and
// shows "待核实" 14 days after it (needsReverify). Seeker: deadline reminders
// (kind 'event') and follow-a-company (kind 'company', per 届别).
// Admin curation: paste an official URL → single-page fetch → the model proposes
// → a person checks and saves a draft → verifies → publishes. There is no
// path that publishes without `verifiedAt` + `verifiedBy`, and editing a
// verified entry's facts clears its verification (a published entry goes
// back to draft until checked again). No crawler, no aggregator source.

import { HttpError } from '../../../platform/http.js';
import type { EnvSource } from '../../../platform/brand/index.js';
import { logger } from '../../../services/LoggerService.js';
import {
  CAMPUS_ERROR_CODES,
  CAMPUS_PAGE_SIZE,
  campusCompanySlug,
  normalizeCampusCompany,
  type AdminCampusDeleteResponse,
  type AdminCampusEventList,
  type AdminCampusEventView,
  type CampusCompanyResponse,
  type CampusEventList,
  type CampusEventView,
  type CampusExtractResponse,
  type CampusSubscriptionList,
  type CampusSubscriptionView,
  type CampusEventDraftBodySchema,
  type CreateCampusSubscriptionBodySchema,
  type PatchCampusEventBodySchema,
} from './contract.js';
import type { z } from 'zod';
import { defaultCampusRepository, type CampusEventWrite, type CampusRepository } from './repository.js';
import { CampusSourceError, checkCampusSourceUrl, fetchOfficialPage, htmlToText, pageTitleOf, type FetchedPage } from './source.js';
import { defaultCampusLlm, resolveCampusModel, runCampusExtract, type CampusLlm, type CampusModelRoute } from './extract.js';
import { compareByClose, decodeCursor, encodeCursor, eventMatches, toAdminView, toEventView, toSubscriptionView, type CampusEventRow, type CampusListFilter } from './views.js';

type DraftBody = z.infer<typeof CampusEventDraftBodySchema>;
type PatchBody = z.infer<typeof PatchCampusEventBodySchema>;
type SubscribeBody = z.infer<typeof CreateCampusSubscriptionBodySchema>;

export interface CampusServiceDeps {
  repo: CampusRepository;
  now: () => Date;
  env: EnvSource;
  llm: CampusLlm;
  fetchPage: (url: string) => Promise<FetchedPage>;
  resolveModel: (env: EnvSource) => CampusModelRoute;
  /** Called after a publish (follow-a-company notices). Errors are logged, never thrown. */
  onPublished?: (event: CampusEventRow) => Promise<unknown>;
}

export function defaultCampusDeps(over: Partial<CampusServiceDeps> = {}): CampusServiceDeps {
  const env = over.env ?? process.env;
  return {
    repo: over.repo ?? defaultCampusRepository(),
    now: over.now ?? (() => new Date()),
    env,
    llm: over.llm ?? defaultCampusLlm,
    fetchPage: over.fetchPage ?? ((url) => fetchOfficialPage(url, { env })),
    resolveModel: over.resolveModel ?? resolveCampusModel,
    ...(over.onPublished ? { onPublished: over.onPublished } : {}),
  };
}

const invalid = (reason: string, message: string) => new HttpError('invalid_request', message, { reason });
const notFound = () => new HttpError('not_found', 'No such campus programme.');

/** Query → filter (the contract's string enums to booleans). */
export function filterOf(q: { class?: number; company?: string; role?: string; city?: string; openNow?: 'true' | 'false' }): CampusListFilter {
  return {
    ...(q.class ? { class: q.class } : {}),
    ...(q.company ? { company: q.company } : {}),
    ...(q.role ? { role: q.role } : {}),
    ...(q.city ? { city: q.city } : {}),
    ...(q.openNow === 'true' ? { openNow: true } : {}),
  };
}

// ── Public / seeker reads ──

export async function listEvents(
  deps: CampusServiceDeps,
  market: string,
  filter: CampusListFilter,
  cursor: string | undefined,
  userId: string | null,
): Promise<CampusEventList> {
  const now = deps.now();
  const skip = decodeCursor(cursor);
  const rows = await deps.repo.listPublished(market, filter, now, skip, CAMPUS_PAGE_SIZE + 1);
  const page = rows.slice(0, CAMPUS_PAGE_SIZE);
  const subscribed = userId ? await deps.repo.subscribedEventIds(userId, page.map((r) => r.id)) : new Set<string>();
  const items = page.map((r) => toEventView(r, now, subscribed.has(r.id))).filter((v): v is CampusEventView => v !== null);
  return { items, cursor: rows.length > CAMPUS_PAGE_SIZE ? encodeCursor(skip + CAMPUS_PAGE_SIZE) : null, asOf: now.toISOString() };
}

export async function getEvent(deps: CampusServiceDeps, market: string, id: string, userId: string | null): Promise<CampusEventView> {
  const now = deps.now();
  const row = await deps.repo.findEvent(id);
  if (!row || row.market !== market) throw notFound();
  const subscribed = userId ? (await deps.repo.subscribedEventIds(userId, [id])).has(id) : false;
  const view = toEventView(row, now, subscribed);
  if (!view) throw notFound();
  return view;
}

/** `/campus/[company]`: the slug is `campusCompanySlug(companyName)`. 404 when the company has no published programme. */
export async function companyEvents(deps: CampusServiceDeps, market: string, slug: string): Promise<CampusCompanyResponse> {
  const now = deps.now();
  const wanted = slug.normalize('NFKC').trim();
  if (!wanted) throw notFound();
  // The database resolves the slug ('-' may be a space or a hyphen of the name); the check here keeps one rule.
  const rows = (await deps.repo.listPublishedByCompanySlug(market, wanted, now, 200)).filter((r) => campusCompanySlug(r.companyName).toLowerCase() === wanted.toLowerCase());
  const items = rows.map((r) => toEventView(r, now)).filter((v): v is CampusEventView => v !== null);
  if (!items.length) throw notFound();
  return { companyName: items[0]!.companyName, companySlug: items[0]!.companySlug, items, cursor: null, asOf: now.toISOString() };
}

/**
 * The Assistant's campus_deadlines tool (GoApply): the user's reminded
 * programmes still ahead, then open programmes of their 届别, closing
 * soonest first, without duplicates.
 */
export async function upcomingForUser(deps: CampusServiceDeps, market: string, userId: string, limit = 10): Promise<CampusEventView[]> {
  const now = deps.now();
  const subs = await deps.repo.listSubscriptions(userId);
  const subscribedIds = subs.filter((s) => s.kind === 'event' && s.eventId).map((s) => s.eventId!);
  const mine = (await deps.repo.eventsByIds(subscribedIds)).filter((r) => eventMatches(r, market, {}, now));
  const cls = await deps.repo.graduationClassOf(userId);
  const open = cls ? await deps.repo.listPublished(market, { class: cls, openNow: true }, now, 0, limit) : [];
  const seen = new Set<string>();
  const out: CampusEventView[] = [];
  for (const r of [...mine.sort(compareByClose), ...open]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const v = toEventView(r, now, subscribedIds.includes(r.id));
    if (v) out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

// ── Subscriptions ──

export async function listSubscriptions(deps: CampusServiceDeps, market: string, userId: string): Promise<CampusSubscriptionList> {
  const now = deps.now();
  const subs = await deps.repo.listSubscriptions(userId);
  const events = await deps.repo.eventsByIds(subs.map((s) => s.eventId).filter((x): x is string => !!x));
  const byId = new Map(events.filter((e) => e.market === market).map((e) => [e.id, e]));
  return {
    items: subs.map((s) => {
      const ev = s.eventId ? byId.get(s.eventId) : undefined;
      return toSubscriptionView(s, ev ? toEventView(ev, now, true) : null);
    }),
  };
}

export async function subscribe(deps: CampusServiceDeps, market: string, userId: string, body: SubscribeBody): Promise<CampusSubscriptionView> {
  const now = deps.now();
  if (body.kind === 'event') {
    const row = await deps.repo.findEvent(body.eventId);
    const view = row && row.market === market ? toEventView(row, now, true) : null;
    if (!row || !view) throw notFound();
    // A reminder needs a stated close date that is still ahead (D3: no invented date to remind about).
    if (!row.applyClosesAt) throw new HttpError('conflict', 'This programme states no close date.', { reason: CAMPUS_ERROR_CODES.noCloseDate });
    if (row.applyClosesAt.getTime() <= now.getTime()) throw new HttpError('conflict', 'Applications for this programme have closed.', { reason: CAMPUS_ERROR_CODES.eventClosed });
    const sub = await deps.repo.upsertEventSubscription(userId, row.id, body.channel);
    return toSubscriptionView(sub, view);
  }
  const normalized = normalizeCampusCompany(body.companyName);
  if (!normalized) throw invalid('company_required', 'A company name is required.');
  const sub = await deps.repo.upsertCompanySubscription(userId, normalized, body.graduationClass, body.channel);
  return toSubscriptionView(sub, null);
}

export async function unsubscribe(deps: CampusServiceDeps, userId: string, id: string): Promise<{ id: string }> {
  if (!(await deps.repo.deleteSubscription(userId, id))) throw new HttpError('not_found', 'No such subscription.');
  return { id };
}

// ── Admin curation ──

function assertSourceUrl(raw: string | undefined | null, env: EnvSource, field: 'officialUrl' | 'sourceUrl'): void {
  if (!raw) return;
  const check = checkCampusSourceUrl(raw, env);
  if (!check.ok) throw new HttpError('invalid_request', `${field} is not allowed: ${check.reason}`, { reason: check.reason, field });
}

function parseDate(value: string | undefined | null): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return new Date(value);
}

function assertWindow(opens: Date | null | undefined, closes: Date | null | undefined): void {
  if (opens && closes && opens.getTime() > closes.getTime()) {
    throw invalid(CAMPUS_ERROR_CODES.windowInverted, 'The application window closes before it opens.');
  }
}

function writeOf(body: Partial<DraftBody> | PatchBody): CampusEventWrite {
  const w: CampusEventWrite = {};
  const opt = (v: string | null | undefined): string | null | undefined => (v === undefined ? undefined : v === null ? null : v.trim() || null);
  if (body.companyName !== undefined) w.companyName = body.companyName.trim();
  if (body.companyId !== undefined) w.companyId = body.companyId;
  if (body.title !== undefined) w.title = body.title.trim();
  if (body.graduationClass !== undefined) w.graduationClass = body.graduationClass;
  if (body.kind !== undefined) w.kind = body.kind;
  const opens = parseDate(body.applyOpensAt);
  const closes = parseDate(body.applyClosesAt);
  if (opens !== undefined) w.applyOpensAt = opens;
  if (closes !== undefined) w.applyClosesAt = closes;
  if (body.stages !== undefined) w.stages = body.stages;
  if (body.cities !== undefined) w.cities = [...new Set(body.cities.map((c) => c.trim()).filter(Boolean))];
  if (body.roles !== undefined) w.roles = [...new Set(body.roles.map((c) => c.trim()).filter(Boolean))];
  if (body.officialUrl !== undefined) w.officialUrl = body.officialUrl.trim();
  const sourceUrl = opt(body.sourceUrl);
  const sourceName = opt(body.sourceName);
  const sourceNote = opt(body.sourceNote);
  if (sourceUrl !== undefined) w.sourceUrl = sourceUrl;
  if (sourceName !== undefined) w.sourceName = sourceName;
  if (sourceNote !== undefined) w.sourceNote = sourceNote;
  return w;
}

/** Fields whose change voids a verification (everything a reader relies on). */
const FACT_FIELDS: readonly (keyof CampusEventWrite)[] = [
  'companyName',
  'title',
  'graduationClass',
  'kind',
  'applyOpensAt',
  'applyClosesAt',
  'stages',
  'cities',
  'roles',
  'officialUrl',
  'sourceUrl',
  'sourceName',
];

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return (a instanceof Date ? a.getTime() : a) === (b instanceof Date ? b.getTime() : b);
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

async function adminViews(deps: CampusServiceDeps, rows: CampusEventRow[]): Promise<AdminCampusEventView[]> {
  const now = deps.now();
  const labels = await deps.repo.userLabels([...new Set(rows.map((r) => r.verifiedByUserId).filter((x): x is string => !!x))]);
  return rows.map((r) => toAdminView(r, now, r.verifiedByUserId ? (labels.get(r.verifiedByUserId) ?? null) : null));
}

export async function adminList(deps: CampusServiceDeps, market: string, status: string | undefined, cursor: string | undefined): Promise<AdminCampusEventList> {
  const skip = decodeCursor(cursor);
  const rows = await deps.repo.adminList(market, status, skip, CAMPUS_PAGE_SIZE + 1);
  const items = await adminViews(deps, rows.slice(0, CAMPUS_PAGE_SIZE));
  return { items, cursor: rows.length > CAMPUS_PAGE_SIZE ? encodeCursor(skip + CAMPUS_PAGE_SIZE) : null };
}

async function loadForAdmin(deps: CampusServiceDeps, market: string, id: string): Promise<CampusEventRow> {
  const row = await deps.repo.findEvent(id);
  if (!row || row.market !== market) throw notFound();
  return row;
}

export async function adminCreate(deps: CampusServiceDeps, market: string, adminId: string, body: DraftBody): Promise<AdminCampusEventView> {
  assertSourceUrl(body.officialUrl, deps.env, 'officialUrl');
  assertSourceUrl(body.sourceUrl, deps.env, 'sourceUrl');
  const w = writeOf(body);
  assertWindow(w.applyOpensAt, w.applyClosesAt);
  const row = await deps.repo.createEvent({
    ...w,
    market,
    createdBy: adminId,
    companyName: w.companyName!,
    title: w.title!,
    graduationClass: w.graduationClass!,
    officialUrl: w.officialUrl!,
    // Always a draft: publishing is a separate, verified step.
    status: 'draft',
    verifiedAt: null,
    verifiedByUserId: null,
  });
  return (await adminViews(deps, [row]))[0]!;
}

export async function adminUpdate(deps: CampusServiceDeps, market: string, id: string, body: PatchBody): Promise<AdminCampusEventView> {
  const row = await loadForAdmin(deps, market, id);
  assertSourceUrl(body.officialUrl, deps.env, 'officialUrl');
  assertSourceUrl(body.sourceUrl, deps.env, 'sourceUrl');
  const w = writeOf(body);
  assertWindow(w.applyOpensAt === undefined ? row.applyOpensAt : w.applyOpensAt, w.applyClosesAt === undefined ? row.applyClosesAt : w.applyClosesAt);
  const factChanged = FACT_FIELDS.some((f) => w[f] !== undefined && !sameValue(w[f], (row as unknown as Record<string, unknown>)[f]));
  if (factChanged && row.verifiedAt) {
    // A changed fact was not checked by anyone: clear the verification; a live entry goes back to draft.
    w.verifiedAt = null;
    w.verifiedByUserId = null;
    if (row.status === 'published') w.status = 'draft';
  }
  const updated = await deps.repo.updateEvent(id, w);
  return (await adminViews(deps, [updated]))[0]!;
}

/** "I checked this against the official page": stamps verifiedAt + verifiedBy (also the 14-day re-verification). */
export async function adminVerify(deps: CampusServiceDeps, market: string, id: string, adminId: string): Promise<AdminCampusEventView> {
  const row = await loadForAdmin(deps, market, id);
  if (row.status === 'archived') throw new HttpError('conflict', 'Archived programmes cannot be verified.', { reason: 'archived' });
  assertSourceUrl(row.officialUrl, deps.env, 'officialUrl');
  const updated = await deps.repo.updateEvent(id, { verifiedAt: deps.now(), verifiedByUserId: adminId });
  return (await adminViews(deps, [updated]))[0]!;
}

export async function adminPublish(deps: CampusServiceDeps, market: string, id: string): Promise<AdminCampusEventView> {
  const row = await loadForAdmin(deps, market, id);
  // Archived usually means wrong or withdrawn: it never goes back on the calendar on its old verification.
  if (row.status === 'archived') throw new HttpError('conflict', 'Archived programmes cannot be published.', { reason: 'archived' });
  if (!row.officialUrl) throw new HttpError('conflict', 'An official URL is required.', { reason: CAMPUS_ERROR_CODES.officialUrlRequired });
  assertSourceUrl(row.officialUrl, deps.env, 'officialUrl');
  assertSourceUrl(row.sourceUrl, deps.env, 'sourceUrl');
  if (!row.verifiedAt || !row.verifiedByUserId) {
    throw new HttpError('conflict', 'Check this entry against the official page before publishing.', { reason: CAMPUS_ERROR_CODES.notVerified });
  }
  const updated = row.status === 'published' ? row : await deps.repo.updateEvent(id, { status: 'published' });
  if (deps.onPublished) {
    try {
      await deps.onPublished(updated);
    } catch (err) {
      logger.warn('CAMPUS', 'follow notices after publish failed; the hourly producer retries', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  return (await adminViews(deps, [updated]))[0]!;
}

export async function adminDelete(deps: CampusServiceDeps, market: string, id: string): Promise<AdminCampusDeleteResponse> {
  const row = await loadForAdmin(deps, market, id);
  if (row.status === 'draft' && !row.verifiedAt) {
    await deps.repo.deleteEvent(id);
    return { id, result: 'deleted' };
  }
  await deps.repo.updateEvent(id, { status: 'archived' });
  return { id, result: 'archived' };
}

/** Paste an official URL → one fetch → a proposal. Writes nothing. */
export async function adminExtract(deps: CampusServiceDeps, officialUrl: string, requestId?: string): Promise<CampusExtractResponse> {
  assertSourceUrl(officialUrl, deps.env, 'officialUrl');
  const route = deps.resolveModel(deps.env);
  if (!route.available || !route.model) {
    throw new HttpError('ai_unavailable', 'No model is configured for reading pages; fill the form by hand.', { reason: 'no_model' });
  }
  let page: FetchedPage;
  try {
    page = await deps.fetchPage(officialUrl);
  } catch (err) {
    if (err instanceof CampusSourceError) throw new HttpError('invalid_request', `The page could not be read: ${err.message}`, { reason: err.reason });
    throw err;
  }
  const text = htmlToText(page.html);
  if (text.length < 20) throw invalid(CAMPUS_ERROR_CODES.pageUnreachable, 'The page has no readable text (it may need a browser).');
  const pageTitle = pageTitleOf(page.html);
  let extracted: Awaited<ReturnType<typeof runCampusExtract>>;
  try {
    extracted = await runCampusExtract({ url: page.finalUrl, pageTitle, text, route, ...(requestId ? { requestId } : {}) }, deps.llm);
  } catch (err) {
    // A transport error or a reply that is not the expected JSON: the AI path failed, staff fill the form by hand (R-04: 503 ai_unavailable).
    logger.warn('CAMPUS', 'campus extract failed', { error: err instanceof Error ? err.message : String(err) });
    throw new HttpError('ai_unavailable', 'The page could not be read automatically; fill the form by hand.', { reason: 'extract_failed' });
  }
  const { proposal, model } = extracted;
  return {
    draft: { ...proposal.draft, officialUrl, ...(pageTitle ? { sourceName: pageTitle.slice(0, 120) } : {}) },
    evidence: proposal.evidence,
    dropped: proposal.dropped,
    pageTitle,
    fetchedAt: page.fetchedAt.toISOString(),
    finalUrl: page.finalUrl,
    aiGenerated: true,
    model,
  };
}
