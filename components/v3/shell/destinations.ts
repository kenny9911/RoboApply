'use client';

// components/v3/shell/destinations.ts — the logged-in information
// architecture, per brand (FND-6a; PRODUCT_PLAN.md §3.3; TASK_PLAN.md R-04,
// R-05).
//
// ONE list. The Sidebar (top + lower groups), the mobile bottom bar, the More
// sheet, the ⌘K palette and the Topbar crumb all read it, so the surfaces
// cannot drift apart.
//
// An entry renders only when ALL of these hold:
//   1. the current brand is in `brands`;
//   2. `ready` is true — false for every NEW destination until INT (WP-93)
//      flips it once the owning WP has shipped the page; the dev override
//      `NEXT_PUBLIC_SHOW_ALL_NAV=true` skips this check (only this one);
//   3. `flag` (if any) is on — read through useCapabilities(), which fails
//      closed, so a flagged entry appears a moment late but never shows when
//      off (R-04: a disabled feature has no UI entry);
//   4. its `gate` (if any) passes: `admin` (role) or `coachRoster` (the brand's
//      roster has ≥1 active coach).
//
// Existing destinations (Jobs, Applications, Resume, Interview prep, Settings,
// Admin) carry no flag on RoboApply, so the rail never flickers for them.
//
// `mobile`: a slot number on the bottom bar (1–4; the fifth slot is More), or
// 'more' for the More sheet, or null (desktop only).

import { useMemo, type ComponentType } from 'react';
import { usePathname } from 'next/navigation';

import { useBrand } from '../../../lib/brand/BrandProvider';
import type { BrandId } from '../../../lib/brand/registry.generated';
import { useCapabilities, type FlagKey, type ResolvedFlags } from '../../../lib/flags';
import { useAuth } from '../../../lib/auth/useAuth';
import { useCoachRosterAvailable, type NavBadgeId } from '../../../hooks/shared/navBadges';
import {
  IconBolt,
  IconCalendar,
  IconCheck,
  IconFile,
  IconGift,
  IconPerson,
  IconPuzzle,
  IconSearch,
  IconSettings,
  IconSparkle,
  IconStack,
  IconTarget,
  IconUsers,
  type IconProps,
} from '../primitives/Iconset';

export type NavGroup = 'top' | 'lower';
export type NavMobileSlot = 1 | 2 | 3 | 4 | 'more' | null;
export type NavGate = 'admin' | 'coachRoster';

export interface NavEntry {
  /** Stable id (brand-specific entries are prefixed `cn.`). */
  id: string;
  href: string;
  /** Key in the `nav` namespace. */
  labelKey: string;
  /** Shorter label on the bottom bar (defaults to labelKey). */
  mobileLabelKey?: string;
  icon: ComponentType<IconProps>;
  group: NavGroup;
  brands: readonly BrandId[];
  flag: FlagKey | null;
  badge: NavBadgeId | null;
  mobile: NavMobileSlot;
  /** False until the destination's page has shipped (INT flips it). */
  ready: boolean;
  gate?: NavGate;
  /** Which pathnames light this entry. */
  match: (pathname: string) => boolean;
}

const RA: readonly BrandId[] = ['roboapply'];
const GA: readonly BrandId[] = ['goapply'];
const BOTH: readonly BrandId[] = ['roboapply', 'goapply'];

/** `p === prefix` or under it, by path segment. */
export function under(prefix: string): (pathname: string) => boolean {
  return (p) => p === prefix || p.startsWith(`${prefix}/`);
}

const matchJobs = (p: string) => under('/jobs')(p) || under('/job-search')(p);

/**
 * The registry. Order inside each brand is the order on screen (top group,
 * then lower group).
 */
export const NAV_ENTRIES: readonly NavEntry[] = [
  // ── RoboApply · top ───────────────────────────────────────────────────
  { id: 'jobs', href: '/jobs', labelKey: 'jobs', icon: IconSearch, group: 'top', brands: RA, flag: null, badge: 'jobs', mobile: 1, ready: true, match: matchJobs },
  { id: 'ready', href: '/ready', labelKey: 'ready', icon: IconCheck, group: 'top', brands: RA, flag: 'agent', badge: 'ready', mobile: 'more', ready: false, match: under('/ready') },
  { id: 'applications', href: '/applications', labelKey: 'applications', icon: IconStack, group: 'top', brands: RA, flag: null, badge: 'applications', mobile: 2, ready: true, match: under('/applications') },
  { id: 'resume', href: '/resume', labelKey: 'resume', icon: IconFile, group: 'top', brands: RA, flag: null, badge: null, mobile: 3, ready: true, match: under('/resume') },
  { id: 'practice', href: '/practice', labelKey: 'practice', icon: IconSparkle, group: 'top', brands: RA, flag: null, badge: null, mobile: 4, ready: true, match: under('/practice') },
  { id: 'profile', href: '/profile', labelKey: 'profile', icon: IconPerson, group: 'top', brands: RA, flag: null, badge: 'profile', mobile: 'more', ready: true, match: under('/profile') },
  // ── RoboApply · lower ─────────────────────────────────────────────────
  { id: 'coaching', href: '/coaching', labelKey: 'coaching', icon: IconTarget, group: 'lower', brands: RA, flag: 'coaching', badge: null, mobile: 'more', ready: false, gate: 'coachRoster', match: under('/coaching') },
  { id: 'invite', href: '/invite', labelKey: 'invite', icon: IconGift, group: 'lower', brands: RA, flag: 'invites', badge: null, mobile: 'more', ready: false, match: under('/invite') },
  { id: 'extension', href: '/extension', labelKey: 'extension', icon: IconPuzzle, group: 'lower', brands: RA, flag: 'extension', badge: null, mobile: null, ready: false, match: under('/extension') },
  { id: 'settings', href: '/settings', labelKey: 'settings', icon: IconSettings, group: 'lower', brands: RA, flag: null, badge: null, mobile: 'more', ready: true, match: under('/settings') },
  { id: 'admin', href: '/admin', labelKey: 'admin', icon: IconBolt, group: 'lower', brands: RA, flag: null, badge: null, mobile: null, ready: true, gate: 'admin', match: under('/admin') },

  // ── GoApply · top (职位 · 校招日历 · 待投递 · 投递记录 · 简历 · 面试练习 · 我的资料) ──
  { id: 'cn.jobs', href: '/jobs', labelKey: 'jobs', icon: IconSearch, group: 'top', brands: GA, flag: 'jobs.feed', badge: 'jobs', mobile: 1, ready: true, match: matchJobs },
  { id: 'cn.campus', href: '/campus', labelKey: 'campus', mobileLabelKey: 'campus_short', icon: IconCalendar, group: 'top', brands: GA, flag: 'jobs.campusCalendar', badge: null, mobile: 2, ready: false, match: under('/campus') },
  { id: 'cn.ready', href: '/ready', labelKey: 'cn_ready', icon: IconCheck, group: 'top', brands: GA, flag: 'agent', badge: 'ready', mobile: 'more', ready: false, match: under('/ready') },
  { id: 'cn.applications', href: '/applications', labelKey: 'cn_applications', mobileLabelKey: 'cn_applications_short', icon: IconStack, group: 'top', brands: GA, flag: null, badge: 'applications', mobile: 3, ready: true, match: under('/applications') },
  { id: 'cn.resume', href: '/resume', labelKey: 'resume', icon: IconFile, group: 'top', brands: GA, flag: null, badge: null, mobile: 'more', ready: true, match: under('/resume') },
  { id: 'cn.practice', href: '/practice', labelKey: 'cn_practice', mobileLabelKey: 'cn_practice_short', icon: IconSparkle, group: 'top', brands: GA, flag: null, badge: null, mobile: 4, ready: true, match: under('/practice') },
  { id: 'cn.profile', href: '/profile', labelKey: 'cn_profile', icon: IconPerson, group: 'top', brands: GA, flag: null, badge: 'profile', mobile: 'more', ready: true, match: under('/profile') },
  // ── GoApply · lower (内推 · 邀请好友 · 设置 · 会员 badge) ─────────────────
  { id: 'cn.referrals', href: '/referrals', labelKey: 'cn_referrals', icon: IconUsers, group: 'lower', brands: GA, flag: 'cn.referralCodes', badge: null, mobile: 'more', ready: false, match: under('/referrals') },
  { id: 'cn.invite', href: '/invite', labelKey: 'invite', icon: IconGift, group: 'lower', brands: GA, flag: 'invites', badge: null, mobile: 'more', ready: false, match: under('/invite') },
  { id: 'cn.settings', href: '/settings', labelKey: 'settings', icon: IconSettings, group: 'lower', brands: GA, flag: null, badge: null, mobile: 'more', ready: true, match: under('/settings') },
  { id: 'cn.admin', href: '/admin', labelKey: 'admin', icon: IconBolt, group: 'lower', brands: GA, flag: null, badge: null, mobile: null, ready: true, gate: 'admin', match: under('/admin') },
];

/** Label of the bottom bar's fifth slot (the More sheet) per brand: "More" / 我的. */
export const MORE_LABEL_KEY: Record<BrandId, string> = { roboapply: 'more', goapply: 'cn_me' };

/**
 * Non-nav surfaces with the same readiness rule: the Topbar's Ask button
 * (the Assistant rail is WP-51) and the job-detail route the palette links to
 * (WP-34). INT flips them with the destinations.
 */
export const SURFACES_READY = {
  assistant: false,
  jobDetail: false,
} as const;

/** The dev override: show entries whose page is not ready yet. Never set in production. */
export function showAllNav(): boolean {
  return process.env.NEXT_PUBLIC_SHOW_ALL_NAV === 'true';
}

export interface NavVisibilityContext {
  brandId: BrandId;
  /** Resolved capability flags, or null until known (fail closed). */
  flags: Partial<ResolvedFlags> | null;
  isAdmin: boolean;
  /** Dev override for `ready`. */
  showAll: boolean;
  /** The brand's coach roster has ≥1 active coach. */
  coachRoster: boolean;
}

/** Brand, readiness and flag only (no per-user gates). */
export function passesStaticRules(entry: NavEntry, ctx: Pick<NavVisibilityContext, 'brandId' | 'flags' | 'showAll'>): boolean {
  if (!entry.brands.includes(ctx.brandId)) return false;
  if (!entry.ready && !ctx.showAll) return false;
  if (entry.flag && ctx.flags?.[entry.flag] !== true) return false;
  return true;
}

export function isNavEntryVisible(entry: NavEntry, ctx: NavVisibilityContext): boolean {
  if (!passesStaticRules(entry, ctx)) return false;
  if (entry.gate === 'admin' && !ctx.isAdmin) return false;
  if (entry.gate === 'coachRoster' && !ctx.coachRoster) return false;
  return true;
}

export interface VisibleNav {
  top: NavEntry[];
  lower: NavEntry[];
  /** Bottom-bar slots 1–4 in order (missing slots collapse). */
  mobile: NavEntry[];
  /** Entries in the More sheet, in registry order. */
  more: NavEntry[];
  /** Every visible entry, registry order (palette). */
  all: NavEntry[];
}

/** Pure: which entries render where for one brand/user. */
export function buildNav(ctx: NavVisibilityContext, entries: readonly NavEntry[] = NAV_ENTRIES): VisibleNav {
  const all = entries.filter((e) => isNavEntryVisible(e, ctx));
  return {
    all,
    top: all.filter((e) => e.group === 'top'),
    lower: all.filter((e) => e.group === 'lower'),
    mobile: all
      .filter((e) => typeof e.mobile === 'number')
      .sort((a, b) => (a.mobile as number) - (b.mobile as number)),
    more: all.filter((e) => e.mobile === 'more'),
  };
}

/**
 * The signed-in home: the first visible top entry. On GoApply with the job
 * feed off (R-14) that is 校招日历 when the calendar is on, else 投递记录 —
 * so the logo and post-login redirects never land on a hidden page.
 */
export function homeHref(nav: Pick<VisibleNav, 'top'>): string {
  return nav.top[0]?.href ?? '/settings';
}

/** Entries of one brand regardless of visibility (crumbs, tests). */
export function entriesForBrand(brandId: BrandId, entries: readonly NavEntry[] = NAV_ENTRIES): NavEntry[] {
  return entries.filter((e) => e.brands.includes(brandId));
}

/**
 * The Topbar crumb for a path: a key in the `nav` namespace, or null (an
 * unmatched path renders no crumb rather than a wrong one). Most specific
 * first: the invoice pages belong to Billing, not Settings.
 */
export function crumbKeyFor(pathname: string, brandId: BrandId): string | null {
  if (under('/settings/billing')(pathname)) return 'billing';
  if (under('/assistant')(pathname)) return 'assistant';
  if (under('/inbox')(pathname)) return 'inbox';
  const entry = entriesForBrand(brandId).find((e) => e.match(pathname));
  return entry ? entry.labelKey : null;
}

/**
 * Where a job hit in the palette goes: `/jobs/[id]` once the detail page has
 * shipped (WP-34), the feed until then (the route shell is a stub).
 */
export function jobHref(jobId: string, showAll: boolean = showAllNav()): string {
  return SURFACES_READY.jobDetail || showAll ? `/jobs/${encodeURIComponent(jobId)}` : '/jobs';
}

/** The visible nav for the current brand, user and flags. */
export function useVisibleNav(): VisibleNav & { brandId: BrandId; activeId: string | null } {
  const brand = useBrand();
  const { flags } = useCapabilities();
  const { user } = useAuth();
  const pathname = usePathname() ?? '';
  const showAll = showAllNav();
  const coachingEntryCould = NAV_ENTRIES.some(
    (e) => e.gate === 'coachRoster' && passesStaticRules(e, { brandId: brand.id, flags, showAll }),
  );
  const coachRoster = useCoachRosterAvailable(coachingEntryCould);
  const isAdmin = user?.role === 'admin';
  const nav = useMemo(
    () => buildNav({ brandId: brand.id, flags, isAdmin, showAll, coachRoster }),
    [brand.id, flags, isAdmin, showAll, coachRoster],
  );
  const activeId = nav.all.find((e) => e.match(pathname))?.id ?? null;
  return useMemo(() => ({ ...nav, brandId: brand.id, activeId }), [nav, brand.id, activeId]);
}
