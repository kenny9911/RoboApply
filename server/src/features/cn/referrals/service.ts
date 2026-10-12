// server/src/features/cn/referrals/service.ts — GoApply 内推码 hub (WP-54; PRODUCT F-NET-08 cn).
//
//   list     approved, unexpired, unhidden codes (+ the viewer's own codes in every state)
//   create   a user shares a code → `pending` until a moderator approves it (10/day)
//   report   one report per user per code; 3 reports take an approved code off the hub
//            until a moderator looks again
//   remove   the sharer deletes their own code (soft delete: it still counts toward
//            the 10-a-day cap, so delete-and-reshare cannot flood the queue)
//   queue / moderate   the admin moderation queue
//
// Honesty: a code is shown only after moderation, with "Shared by a %BRAND%
// user, {month year}". Notes carrying phone numbers, WeChat ids, emails or
// links are refused (contact details stay off a public list; PIPL).

import { HttpError } from '../../../platform/http.js';
import {
  CN_REFERRALS_ERROR_CODES as E,
  REFERRALS_PAGE_SIZE,
  REFERRAL_REPORTS_TO_HIDE,
  REFERRAL_SHARES_PER_DAY,
  type ListReferralCodesResponse,
  type ReferralCodeStatus,
  type ReferralCodeView,
  type ReferralQueueItem,
  type ReferralQueueResponse,
  type ReferralReportReason,
} from './contract.js';
import type { ReferralCodeRow, ReferralStore } from './store.js';

export interface ReferralDeps {
  store: ReferralStore;
  brandId: () => string;
  normalizeCompany: (name: string) => string;
  now?: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MINE_LIMIT = 50;

/** Contact details a public list must not carry: phone numbers, emails, links, WeChat/QQ ids. */
export function hasContactDetails(text: string | null | undefined, kind: 'code' | 'text' = 'text'): boolean {
  const s = (text ?? '').normalize('NFKC');
  if (!s.trim()) return false;
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(s)) return true;
  if (/https?:\/\/|www\.|\.(com|cn|net|top|io)\b/i.test(s)) return true;
  if (/(?<!\d)1[3-9]\d{9}(?!\d)/.test(s.replace(/[\s-]/g, ''))) return true;
  // A code may itself be a long run of digits; only free text is checked for other phone shapes.
  if (kind === 'text' && /(?:\+?\d[\s-]?){8,}/.test(s)) return true;
  if (/(微信|vx|v信|wx|wechat|qq|加我|私聊|联系方式)\s*[:：号]?\s*[a-z0-9_-]{4,}/i.test(s)) return true;
  return false;
}

function todayUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export class CnReferralService {
  constructor(private readonly deps: ReferralDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private assertStore(): void {
    if (!this.deps.store.available()) {
      throw new HttpError('storage_unavailable', 'The referral code list is not available yet.', { reason: E.storageUnavailable });
    }
  }

  private status(row: ReferralCodeRow): ReferralCodeStatus {
    if (row.status === 'approved' && row.expiresAt && row.expiresAt.getTime() < todayUtc(this.now()).getTime()) return 'expired';
    return (['pending', 'approved', 'rejected', 'expired'] as const).includes(row.status as ReferralCodeStatus) ? (row.status as ReferralCodeStatus) : 'pending';
  }

  view(row: ReferralCodeRow, viewerId: string, reported: Set<string>): ReferralCodeView {
    const mine = row.userId === viewerId;
    return {
      id: row.id,
      company: row.company,
      code: row.code,
      programme: row.programme,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString().slice(0, 10) : null,
      note: row.note,
      status: this.status(row),
      sharedAt: row.createdAt.toISOString(),
      mine,
      reportedByMe: reported.has(row.id),
      rejectReason: mine && row.status === 'rejected' ? row.rejectReason : null,
    };
  }

  async list(userId: string, query: { company?: string; classYear?: number; cursor?: string }): Promise<ListReferralCodesResponse> {
    this.assertStore();
    const brand = this.deps.brandId();
    const company = query.company ? this.deps.normalizeCompany(query.company) : '';
    const [rows, mine] = await Promise.all([
      this.deps.store.listVisible({
        brand,
        companyNormalized: company || undefined,
        programmeContains: query.classYear ? String(query.classYear) : undefined,
        today: todayUtc(this.now()),
        cursor: query.cursor,
        limit: REFERRALS_PAGE_SIZE + 1,
      }),
      query.cursor ? Promise.resolve([] as ReferralCodeRow[]) : this.deps.store.listMine(userId, brand, MINE_LIMIT),
    ]);
    const page = rows.slice(0, REFERRALS_PAGE_SIZE);
    const reported = await this.deps.store.reportedBy(userId, page.map((r) => r.id));
    return {
      items: page.map((r) => this.view(r, userId, reported)),
      cursor: rows.length > REFERRALS_PAGE_SIZE ? page[page.length - 1]!.id : null,
      mine: mine.map((r) => this.view(r, userId, new Set())),
    };
  }

  async create(
    userId: string,
    body: { company: string; code: string; programme?: string; expiresAt?: string; note?: string },
  ): Promise<ReferralCodeView> {
    this.assertStore();
    const brand = this.deps.brandId();
    const now = this.now();
    const companyNormalized = this.deps.normalizeCompany(body.company);
    if (!companyNormalized) throw new HttpError('invalid_request', 'Add the company name.', { reason: 'company_required' });
    let expiresAt: Date | null = null;
    if (body.expiresAt) {
      expiresAt = new Date(`${body.expiresAt}T00:00:00.000Z`);
      if (Number.isNaN(expiresAt.getTime())) throw new HttpError('invalid_request', 'Check the expiry date.', { reason: 'expiry_invalid' });
      if (expiresAt.getTime() < todayUtc(now).getTime()) throw new HttpError('invalid_request', 'This code has already expired.', { reason: 'expiry_past' });
    }
    if (hasContactDetails(body.code, 'code') || hasContactDetails(body.note) || hasContactDetails(body.programme)) {
      throw new HttpError('invalid_request', 'Leave out phone numbers, WeChat IDs, emails and links.', { reason: E.contactDetails });
    }
    const shared = await this.deps.store.countSharedSince(userId, new Date(now.getTime() - DAY_MS));
    if (shared >= REFERRAL_SHARES_PER_DAY) {
      throw new HttpError('rate_limited', `You can share ${REFERRAL_SHARES_PER_DAY} codes a day.`, { reason: E.shareLimit, retryAfterSec: 3600 });
    }
    const code = body.code.trim();
    if (await this.deps.store.findLiveDuplicate(brand, companyNormalized, code)) {
      throw new HttpError('conflict', 'This code is already listed or waiting for review.', { reason: E.duplicate });
    }
    const row = await this.deps.store.create({
      brand,
      userId,
      company: body.company.trim(),
      companyNormalized,
      code,
      programme: body.programme?.trim() || null,
      expiresAt,
      note: body.note?.trim() || null,
    });
    return this.view(row, userId, new Set());
  }

  private async visibleRow(id: string): Promise<ReferralCodeRow> {
    const row = await this.deps.store.find(id);
    if (!row || row.brand !== this.deps.brandId() || row.status === 'deleted') throw new HttpError('not_found', 'Not found.', { reason: E.notFound });
    return row;
  }

  async report(userId: string, id: string, body: { reason: ReferralReportReason; note?: string }): Promise<{ reported: true }> {
    this.assertStore();
    const row = await this.visibleRow(id);
    // Only listed codes can be reported (a pending or rejected code is not public).
    if (row.status !== 'approved' && row.userId !== userId) throw new HttpError('not_found', 'Not found.', { reason: E.notFound });
    if (row.userId === userId) throw new HttpError('invalid_request', 'You shared this code. Delete it instead.', { reason: 'own_code' });
    const added = await this.deps.store.addReport({ codeId: row.id, userId, reason: body.reason, note: body.note?.trim() || null });
    if (!added) throw new HttpError('conflict', 'You already reported this code.', { reason: E.alreadyReported });
    // Atomic increment: concurrent reports each count; hiding is decided on the value after it.
    const after = await this.deps.store.incrementReportCount(row.id);
    if (after.reportCount >= REFERRAL_REPORTS_TO_HIDE && !after.hiddenAt) await this.deps.store.update(row.id, { hiddenAt: this.now() });
    return { reported: true };
  }

  async remove(userId: string, id: string): Promise<{ deleted: true }> {
    this.assertStore();
    const row = await this.visibleRow(id);
    if (row.userId !== userId) throw new HttpError('not_found', 'Not found.', { reason: E.notFound });
    await this.deps.store.remove(row.id);
    return { deleted: true };
  }

  // ── Admin ──────────────────────────────────────────────────────────────

  async queue(query: { cursor?: string }): Promise<ReferralQueueResponse> {
    this.assertStore();
    const rows = await this.deps.store.queue({ brand: this.deps.brandId(), cursor: query.cursor, limit: REFERRALS_PAGE_SIZE + 1 });
    const page = rows.slice(0, REFERRALS_PAGE_SIZE);
    const reports = await this.deps.store.reportsFor(page.map((r) => r.id));
    const items: ReferralQueueItem[] = page.map((r) => {
      const { mine: _m, reportedByMe: _r, ...base } = this.view(r, '', new Set());
      return {
        ...base,
        rejectReason: r.rejectReason,
        userId: r.userId,
        reportCount: r.reportCount,
        reports: reports
          .filter((x) => x.codeId === r.id)
          .map((x) => ({ reason: x.reason as ReferralReportReason, note: x.note, createdAt: x.createdAt.toISOString() })),
        queue: r.status === 'pending' ? 'new' : 'reported',
      };
    });
    return { items, cursor: rows.length > REFERRALS_PAGE_SIZE ? page[page.length - 1]!.id : null };
  }

  async moderate(moderatorId: string, id: string, body: { decision: 'approve' | 'reject'; reason?: string }): Promise<{ id: string; status: ReferralCodeStatus }> {
    this.assertStore();
    const row = await this.visibleRow(id);
    const now = this.now();
    const updated = await this.deps.store.update(row.id, {
      status: body.decision === 'approve' ? 'approved' : 'rejected',
      rejectReason: body.decision === 'reject' ? (body.reason ?? 'other') : null,
      hiddenAt: null,
      // An approval after reports starts a fresh count (otherwise the count is left alone: no read-modify-write).
      ...(body.decision === 'approve' && row.hiddenAt ? { reportCount: 0 } : {}),
      moderatedAt: now,
      moderatedById: moderatorId,
    });
    return { id: updated.id, status: this.status(updated) };
  }
}
