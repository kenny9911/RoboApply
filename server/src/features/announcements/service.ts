// server/src/features/announcements/service.ts — "What's new" (F-NOTIF-09; WP-61).
//
//   next(userId, brand, locale)   at most one announcement for the person, or null
//   markSeen(userId, brand, id)   shown once: stored in RAUserUiState.announcementsSeen;
//                                 the first time, an inbox row keeps it findable
//   admin list/create/update/delete, with the publish rule: every brand locale
//   translated before `active: true` ("translated before publish").
//
// Pure helpers (exported for tests): missingLocales, statusOf, matchesCohort,
// pickAnnouncement, viewFor, validateDraft.

import { getBrand, isBrandId, clampLocaleToBrand, type ProductBrand } from '../../platform/brand/registry.js';
import { FLAG_KEYS, isEnabled, type FlagKey } from '../../platform/flags.js';
import { HttpError } from '../../platform/http.js';
import { logger } from '../../services/LoggerService.js';
import {
  ANNOUNCEMENT_DEFAULT_DAYS,
  ANNOUNCEMENT_DEFAULT_PRIORITY,
  ANNOUNCEMENT_ERROR_REASONS,
  ANNOUNCEMENT_POPUP_GAP_MS,
  isInternalHref,
  type AdminAnnouncementView,
  type AnnouncementCohort,
  type AnnouncementContent,
  type AnnouncementStatus,
  type AnnouncementView,
  type NextAnnouncementResponse,
  type PatchAnnouncementBodySchema,
  type UpsertAnnouncementBodySchema,
} from './contract.js';
import { createPrismaAnnouncementsRepo, type AnnouncementRecord, type AnnouncementsRepo } from './repo.js';
import type { z } from 'zod';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the cohort rules look at for one person. */
export interface AudienceFacts {
  /** The plan key that decided the profile ('free' with no live paid plan). */
  planKey: string;
  /** 'free' | 'pro' (credits plan profile). */
  planProfile: string;
  signedUpAt: Date | null;
  /** Is a capability / product flag on for this person (per-user overrides included)? */
  flagOn(key: FlagKey): Promise<boolean>;
}

export interface SeenState {
  announcementsSeen: string[];
  popupLastShownAt: string | null;
}

export interface AnnouncementsServiceDeps {
  repo?: AnnouncementsRepo;
  /** Read the person's UI state (seen list + popup budget). */
  uiState?: (userId: string) => Promise<SeenState>;
  /** Add an id to the person's seen list. */
  recordSeen?: (userId: string, id: string) => Promise<void>;
  facts?: (userId: string, brand: ProductBrand) => Promise<AudienceFacts>;
  /** Write the inbox row the first time an announcement is shown (best effort). */
  inbox?: (input: { userId: string; brand: ProductBrand; record: AnnouncementRecord; view: AnnouncementView }) => Promise<void>;
  now?: () => Date;
}

// ── Pure helpers ─────────────────────────────────────────────────────────

/** Brand locales with no content. */
export function missingLocales(brand: ProductBrand, content: AnnouncementContent): string[] {
  return brand.locales.filter((l) => !content[l]);
}

export function statusOf(rec: Pick<AnnouncementRecord, 'active' | 'startsAt' | 'endsAt'>, now: Date): AnnouncementStatus {
  if (!rec.active) return 'draft';
  if (rec.endsAt.getTime() <= now.getTime()) return 'ended';
  if (rec.startsAt.getTime() > now.getTime()) return 'scheduled';
  return 'live';
}

/** Every rule given must hold; an empty cohort is everyone. */
export async function matchesCohort(cohort: AnnouncementCohort, facts: AudienceFacts): Promise<boolean> {
  if (cohort.plans?.length && !cohort.plans.includes(facts.planKey) && !cohort.plans.includes(facts.planProfile)) return false;
  if (cohort.signedUpBefore) {
    if (!facts.signedUpAt || facts.signedUpAt.getTime() >= Date.parse(cohort.signedUpBefore)) return false;
  }
  for (const key of cohort.flags ?? []) {
    if (!(FLAG_KEYS as readonly string[]).includes(key)) return false;
    if (!(await facts.flagOn(key as FlagKey))) return false;
  }
  return true;
}

/** The seeker view in `locale` (the brand default when that one is missing), or null. */
export function viewFor(rec: AnnouncementRecord, locale: string, brand: ProductBrand): AnnouncementView | null {
  const c = rec.content[locale] ?? rec.content[brand.defaultLocale];
  if (!c) return null;
  return { id: rec.id, key: rec.key, title: c.title, body: c.body, ctaLabel: c.ctaLabel ?? null, ctaHref: c.ctaHref ?? null };
}

/**
 * The one announcement to show: published, inside its window, not seen, for
 * the person's language and cohort; lower priority first, then newest start.
 */
export async function pickAnnouncement(
  records: AnnouncementRecord[],
  opts: { brand: ProductBrand; locale: string; seen: ReadonlySet<string>; now: Date; facts: () => Promise<AudienceFacts> },
): Promise<AnnouncementView | null> {
  const eligible = records
    .filter((r) => r.brand === opts.brand.id && r.active && !opts.seen.has(r.id))
    .filter((r) => r.startsAt.getTime() <= opts.now.getTime() && r.endsAt.getTime() > opts.now.getTime())
    .filter((r) => r.locales.includes(opts.locale))
    .sort((a, b) => a.priority - b.priority || b.startsAt.getTime() - a.startsAt.getTime());
  if (!eligible.length) return null;
  let facts: AudienceFacts | null = null;
  for (const rec of eligible) {
    const hasCohort = Boolean(rec.cohort.plans?.length || rec.cohort.signedUpBefore || rec.cohort.flags?.length);
    if (hasCohort) {
      facts ??= await opts.facts();
      if (!(await matchesCohort(rec.cohort, facts))) continue;
    }
    const view = viewFor(rec, opts.locale, opts.brand);
    if (view) return view;
  }
  return null;
}

function invalid(reason: string, message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError('invalid_request', message, { reason, where: 'body', ...extra });
}

/**
 * Checks a full draft against its brand. Throws 422 with `details.reason`:
 * locale_not_served, invalid_window, unknown_flag, translations_missing (only when active).
 */
export function validateDraft(
  brand: ProductBrand,
  draft: Pick<AnnouncementRecord, 'locales' | 'content' | 'cohort' | 'active' | 'startsAt' | 'endsAt'>,
): void {
  const served = new Set<string>(brand.locales);
  const notServed = [...new Set([...draft.locales, ...Object.keys(draft.content)])].filter((l) => !served.has(l));
  if (notServed.length) {
    throw invalid(ANNOUNCEMENT_ERROR_REASONS.localeNotServed, `${brand.name} does not serve: ${notServed.join(', ')}.`, { locales: notServed });
  }
  if (draft.endsAt.getTime() <= draft.startsAt.getTime()) {
    throw invalid(ANNOUNCEMENT_ERROR_REASONS.invalidWindow, 'The end must be after the start.');
  }
  const unknown = (draft.cohort.flags ?? []).filter((f) => !(FLAG_KEYS as readonly string[]).includes(f));
  if (unknown.length) {
    throw invalid(ANNOUNCEMENT_ERROR_REASONS.unknownFlag, `Unknown feature switch: ${unknown.join(', ')}.`, { flags: unknown });
  }
  if (draft.active) {
    const missing = missingLocales(brand, draft.content);
    if (missing.length) {
      throw invalid(ANNOUNCEMENT_ERROR_REASONS.translationsMissing, `Add every language before publishing. Missing: ${missing.join(', ')}.`, {
        missing,
      });
    }
  }
}

export function toAdminView(rec: AnnouncementRecord, now: Date): AdminAnnouncementView {
  const brand = getBrand(isBrandId(rec.brand) ? rec.brand : 'roboapply');
  return {
    id: rec.id,
    key: rec.key,
    brand: brand.id,
    locales: rec.locales,
    content: rec.content,
    cohort: rec.cohort,
    priority: rec.priority,
    startsAt: rec.startsAt.toISOString(),
    endsAt: rec.endsAt.toISOString(),
    active: rec.active,
    createdAt: rec.createdAt.toISOString(),
    missingLocales: missingLocales(brand, rec.content),
    status: statusOf(rec, now),
  };
}

// ── Default dependencies (lazy, so importing opens no pool) ──────────────

async function defaultUiState(userId: string): Promise<SeenState> {
  const { uiStateService } = await import('../uistate/index.js');
  const res = await uiStateService.get(userId);
  return { announcementsSeen: res.state.announcementsSeen, popupLastShownAt: res.state.popupLastShownAt };
}

async function defaultRecordSeen(userId: string, id: string): Promise<void> {
  const { uiStateService } = await import('../uistate/index.js');
  await uiStateService.patch(userId, { announcementsSeen: [id] });
}

async function defaultFacts(userId: string, brand: ProductBrand): Promise<AudienceFacts> {
  const [{ entitlementService }, { default: prisma }] = await Promise.all([import('../../platform/credits/index.js'), import('../../lib/prisma.js')]);
  const [ent, user] = await Promise.all([
    entitlementService.resolve(userId, { brand: brand.id }),
    prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true } }),
  ]);
  return {
    planKey: ent.planKey,
    planProfile: ent.planProfile,
    signedUpAt: user?.createdAt ?? null,
    flagOn: (key) => isEnabled(key, { userId, brand }),
  };
}

async function defaultInbox(input: { userId: string; brand: ProductBrand; record: AnnouncementRecord; view: AnnouncementView }): Promise<void> {
  const { notificationCenterService } = await import('../notifications/index.js');
  await notificationCenterService.create({
    userId: input.userId,
    brand: input.brand.id,
    category: 'announcement',
    title: input.view.title,
    body: input.view.body,
    href: isInternalHref(input.view.ctaHref) ? input.view.ctaHref : null,
    relatedEntityType: 'announcement',
    relatedEntityId: input.record.id,
  });
}

// ── Service ──────────────────────────────────────────────────────────────

type UpsertBody = z.output<typeof UpsertAnnouncementBodySchema>;
type PatchBody = z.output<typeof PatchAnnouncementBodySchema>;

export class AnnouncementsService {
  private readonly repo: AnnouncementsRepo;
  private readonly uiState: (userId: string) => Promise<SeenState>;
  private readonly recordSeen: (userId: string, id: string) => Promise<void>;
  private readonly facts: (userId: string, brand: ProductBrand) => Promise<AudienceFacts>;
  private readonly inbox: NonNullable<AnnouncementsServiceDeps['inbox']>;
  private readonly now: () => Date;

  constructor(deps: AnnouncementsServiceDeps = {}) {
    this.repo = deps.repo ?? createPrismaAnnouncementsRepo();
    this.uiState = deps.uiState ?? defaultUiState;
    this.recordSeen = deps.recordSeen ?? defaultRecordSeen;
    this.facts = deps.facts ?? defaultFacts;
    this.inbox = deps.inbox ?? defaultInbox;
    this.now = deps.now ?? (() => new Date());
  }

  async next(userId: string, brand: ProductBrand, locale: string | null | undefined): Promise<NextAnnouncementResponse> {
    const now = this.now();
    const state = await this.uiState(userId);
    const last = state.popupLastShownAt ? Date.parse(state.popupLastShownAt) : NaN;
    if (Number.isFinite(last) && now.getTime() - last < ANNOUNCEMENT_POPUP_GAP_MS) return { announcement: null };
    // Seen ids are excluded in the query, so a long seen list never uses up
    // the row limit; `pickAnnouncement` re-checks them in memory.
    const records = await this.repo.listInWindow(brand.id, now, state.announcementsSeen);
    const announcement = await pickAnnouncement(records, {
      brand,
      locale: clampLocaleToBrand(brand, locale),
      seen: new Set(state.announcementsSeen),
      now,
      facts: () => this.facts(userId, brand),
    });
    return { announcement };
  }

  async markSeen(userId: string, brand: ProductBrand, id: string, locale?: string | null): Promise<void> {
    const rec = await this.repo.get(id);
    const lang = clampLocaleToBrand(brand, locale);
    // Only what `next` could have shown: this brand, published and inside its
    // window, in the person's language. A draft, scheduled or ended id is
    // "not found", so nothing unpublished reaches the inbox.
    if (!rec || rec.brand !== brand.id || statusOf(rec, this.now()) !== 'live' || !rec.locales.includes(lang)) {
      throw new HttpError('not_found', 'Announcement not found.');
    }
    const state = await this.uiState(userId);
    if (state.announcementsSeen.includes(id)) return;
    await this.recordSeen(userId, id);
    const view = viewFor(rec, lang, brand);
    if (view) {
      await this.inbox({ userId, brand, record: rec, view }).catch((err) =>
        logger.warn('ANNOUNCE', 'inbox copy failed', { error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  // ── Admin ──────────────────────────────────────────────────────────────

  async adminList(filter: { brand?: 'roboapply' | 'goapply'; active?: 'true' | 'false' }): Promise<{ items: AdminAnnouncementView[] }> {
    const now = this.now();
    let rows = await this.repo.list({ brand: filter.brand });
    if (filter.active) rows = rows.filter((r) => r.active === (filter.active === 'true'));
    return { items: rows.map((r) => toAdminView(r, now)) };
  }

  async adminCreate(body: UpsertBody): Promise<AdminAnnouncementView> {
    const now = this.now();
    const brand = getBrand(body.brand);
    const startsAt = body.startsAt ? new Date(body.startsAt) : now;
    const endsAt = body.endsAt ? new Date(body.endsAt) : new Date(startsAt.getTime() + ANNOUNCEMENT_DEFAULT_DAYS * DAY_MS);
    const draft = {
      key: body.key,
      brand: brand.id,
      locales: [...new Set(body.locales)],
      content: body.content,
      cohort: body.cohort ?? {},
      active: body.active ?? false,
      priority: body.priority ?? ANNOUNCEMENT_DEFAULT_PRIORITY,
      startsAt,
      endsAt,
    };
    validateDraft(brand, draft);
    if (await this.repo.getByKey(body.key)) {
      throw new HttpError('conflict', 'An announcement with this key already exists.', { reason: ANNOUNCEMENT_ERROR_REASONS.keyTaken });
    }
    try {
      return toAdminView(await this.repo.create(draft), now);
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        throw new HttpError('conflict', 'An announcement with this key already exists.', { reason: ANNOUNCEMENT_ERROR_REASONS.keyTaken });
      }
      throw err;
    }
  }

  async adminUpdate(id: string, patch: PatchBody): Promise<AdminAnnouncementView> {
    const now = this.now();
    const rec = await this.repo.get(id);
    if (!rec) throw new HttpError('not_found', 'Announcement not found.');
    const brand = getBrand(isBrandId(rec.brand) ? rec.brand : 'roboapply');
    const startsAt = patch.startsAt === undefined ? rec.startsAt : patch.startsAt === null ? now : new Date(patch.startsAt);
    const endsAt =
      patch.endsAt === undefined
        ? rec.endsAt
        : patch.endsAt === null
          ? new Date(startsAt.getTime() + ANNOUNCEMENT_DEFAULT_DAYS * DAY_MS)
          : new Date(patch.endsAt);
    const next = {
      locales: patch.locales ? [...new Set(patch.locales)] : rec.locales,
      content: patch.content ?? rec.content,
      cohort: patch.cohort ?? rec.cohort,
      active: patch.active ?? rec.active,
      priority: patch.priority ?? rec.priority,
      startsAt,
      endsAt,
    };
    validateDraft(brand, next);
    return toAdminView(await this.repo.update(id, next), now);
  }

  async adminDelete(id: string): Promise<void> {
    if (!(await this.repo.delete(id))) throw new HttpError('not_found', 'Announcement not found.');
  }
}

let shared: AnnouncementsService | null = null;
export function announcementsService(): AnnouncementsService {
  shared ??= new AnnouncementsService();
  return shared;
}
