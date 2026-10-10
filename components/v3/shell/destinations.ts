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
//   2. `ready` is true (the dev override `NEXT_PUBLIC_SHOW_ALL_NAV=true` skips
//      this check, and only this one);
//   3. `flag` (if any) is on — read through useCapabilities(), which fails
//      closed, so a flagged entry appears a moment late but never shows when
//      off (R-04: a disabled feature has no UI entry);
//   4. its `gate` (if any) passes: `admin` (role), `coachRoster` (the brand's
//      roster has ≥1 active coach), `invitesLive` (the brand's every sign-up
//      path attaches the invite, hooks/growth INVITE_REWARD_BRANDS) or
//      `extensionPublished` (the brand's extension has a store id,
//      NEXT_PUBLIC_EXT_ID / NEXT_PUBLIC_CN_EXT_ID — until then /extension can
//      only say "not available", which is not a destination).
//
// READY FLIPS (INT-12 / WP-93). Every destination below has shipped and
// passed the no-dead-ends audit (__tests__/shell/noDeadEnds.test.tsx), so
// every `ready` is true. `ready` stays in the shape as the one-line revert:
// set it to false on ONE entry and that entry leaves the rail, the bottom
// bar, the More sheet and the palette, on both themes and every locale,
// without touching its page. Flipped by INT-12:
//   ready, cn.ready        /ready      WP-53   shown with `agent`
//   cn.campus              /campus     WP-58   shown with `jobs.campusCalendar`
//   cn.referrals           /referrals  WP-54   shown with `cn.referralCodes`
//   extension, cn.extension  /extension  WP-55a  shown with `extension` + gate `extensionPublished`
//   invite, cn.invite      /invite     WP-60   shown with `invites` + gate `invitesLive`
//                                              (GoApply: only once its phone and
//                                              WeChat sign-ups carry the invite)
//   coaching, cn.coaching  /coaching   WP-72   shown with `coaching` + gate `coachRoster`
//   SURFACES_READY.assistant           WP-51   the Topbar's Ask button, with `copilot`
//
// Parity (D5; GOAPPLY_PARITY_PLAN §3.11). GoApply has the same entries under
// the same gates as RoboApply: 职位 carries no flag (with the job feed switched
// off the page itself says so and still offers the user's own added jobs),
// 求职辅导 shows when GoApply's roster has a coach, and the extension entry
// shows when GoApply's extension has a store id. What GoApply adds stays
// (校招日历, 内推码).
//
// Existing destinations (Jobs, Applications, Resume, Interview prep, Settings,
// Admin) carry no flag on either brand, so the rail never flickers for them.
//
// `mobile`: a slot number on the bottom bar (1–4; the fifth slot is More), or
// 'more' for the More sheet, or null (desktop only).

import { useMemo, type ComponentType } from 'react';
import { usePathname } from 'next/navigation';

import { useBrand } from '../../../lib/brand/BrandProvider';
import type { BrandId } from '../../../lib/brand/registry.generated';
import { useCapabilities, type FlagKey, type ResolvedFlags } from '../../../lib/flags';
import { useAuth } from '../../../lib/auth/useAuth';
import { extensionIdFor } from '../../../hooks/extension/bridge';
import { INVITE_REWARD_BRANDS } from '../../../hooks/growth/useInvites';
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
export type NavGate = 'admin' | 'coachRoster' | 'invitesLive' | 'extensionPublished';

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
  /** The destination's page has shipped. All true since INT-12; set one to false to take that entry out. */
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
  { id: 'ready', href: '/ready', labelKey: 'ready', icon: IconCheck, group: 'top', brands: RA, flag: 'agent', badge: 'ready', mobile: 'more', ready: true, match: under('/ready') },
  { id: 'applications', href: '/applications', labelKey: 'applications', icon: IconStack, group: 'top', brands: RA, flag: null, badge: 'applications', mobile: 2, ready: true, match: under('/applications') },
  { id: 'resume', href: '/resume', labelKey: 'resume', icon: IconFile, group: 'top', brands: RA, flag: null, badge: null, mobile: 3, ready: true, match: under('/resume') },
  { id: 'practice', href: '/practice', labelKey: 'practice', icon: IconSparkle, group: 'top', brands: RA, flag: null, badge: null, mobile: 4, ready: true, match: under('/practice') },
  { id: 'profile', href: '/profile', labelKey: 'profile', icon: IconPerson, group: 'top', brands: RA, flag: null, badge: 'profile', mobile: 'more', ready: true, match: under('/profile') },
  // ── RoboApply · lower ─────────────────────────────────────────────────
  { id: 'coaching', href: '/coaching', labelKey: 'coaching', icon: IconTarget, group: 'lower', brands: RA, flag: 'coaching', badge: null, mobile: 'more', ready: true, gate: 'coachRoster', match: under('/coaching') },
  { id: 'invite', href: '/invite', labelKey: 'invite', icon: IconGift, group: 'lower', brands: RA, flag: 'invites', badge: null, mobile: 'more', ready: true, gate: 'invitesLive', match: under('/invite') },
  { id: 'extension', href: '/extension', labelKey: 'extension', icon: IconPuzzle, group: 'lower', brands: RA, flag: 'extension', badge: null, mobile: null, ready: true, gate: 'extensionPublished', match: under('/extension') },
  { id: 'settings', href: '/settings', labelKey: 'settings', icon: IconSettings, group: 'lower', brands: RA, flag: null, badge: null, mobile: 'more', ready: true, match: under('/settings') },
  { id: 'admin', href: '/admin', labelKey: 'admin', icon: IconBolt, group: 'lower', brands: RA, flag: null, badge: null, mobile: null, ready: true, gate: 'admin', match: under('/admin') },

  // ── GoApply · top (职位 · 校招日历 · 待投递 · 投递记录 · 简历 · 面试练习 · 我的资料) ──
  { id: 'cn.jobs', href: '/jobs', labelKey: 'jobs', icon: IconSearch, group: 'top', brands: GA, flag: null, badge: 'jobs', mobile: 1, ready: true, match: matchJobs },
  { id: 'cn.campus', href: '/campus', labelKey: 'campus', mobileLabelKey: 'campus_short', icon: IconCalendar, group: 'top', brands: GA, flag: 'jobs.campusCalendar', badge: null, mobile: 2, ready: true, match: under('/campus') },
  { id: 'cn.ready', href: '/ready', labelKey: 'cn_ready', icon: IconCheck, group: 'top', brands: GA, flag: 'agent', badge: 'ready', mobile: 'more', ready: true, match: under('/ready') },
  { id: 'cn.applications', href: '/applications', labelKey: 'cn_applications', mobileLabelKey: 'cn_applications_short', icon: IconStack, group: 'top', brands: GA, flag: null, badge: 'applications', mobile: 3, ready: true, match: under('/applications') },
  { id: 'cn.resume', href: '/resume', labelKey: 'resume', icon: IconFile, group: 'top', brands: GA, flag: null, badge: null, mobile: 'more', ready: true, match: under('/resume') },
  { id: 'cn.practice', href: '/practice', labelKey: 'cn_practice', mobileLabelKey: 'cn_practice_short', icon: IconSparkle, group: 'top', brands: GA, flag: null, badge: null, mobile: 4, ready: true, match: under('/practice') },
  { id: 'cn.profile', href: '/profile', labelKey: 'cn_profile', icon: IconPerson, group: 'top', brands: GA, flag: null, badge: 'profile', mobile: 'more', ready: true, match: under('/profile') },
  // ── GoApply · lower (求职辅导 · 内推 · 邀请好友 · 浏览器插件 · 设置 · 会员 badge) ──
  { id: 'cn.coaching', href: '/coaching', labelKey: 'coaching', icon: IconTarget, group: 'lower', brands: GA, flag: 'coaching', badge: null, mobile: 'more', ready: true, gate: 'coachRoster', match: under('/coaching') },
  { id: 'cn.referrals', href: '/referrals', labelKey: 'cn_referrals', icon: IconUsers, group: 'lower', brands: GA, flag: 'cn.referralCodes', badge: null, mobile: 'more', ready: true, match: under('/referrals') },
  { id: 'cn.invite', href: '/invite', labelKey: 'invite', icon: IconGift, group: 'lower', brands: GA, flag: 'invites', badge: null, mobile: 'more', ready: true, gate: 'invitesLive', match: under('/invite') },
  { id: 'cn.extension', href: '/extension', labelKey: 'extension', icon: IconPuzzle, group: 'lower', brands: GA, flag: 'extension', badge: null, mobile: null, ready: true, gate: 'extensionPublished', match: under('/extension') },
  { id: 'cn.settings', href: '/settings', labelKey: 'settings', icon: IconSettings, group: 'lower', brands: GA, flag: null, badge: null, mobile: 'more', ready: true, match: under('/settings') },
  { id: 'cn.admin', href: '/admin', labelKey: 'admin', icon: IconBolt, group: 'lower', brands: GA, flag: null, badge: null, mobile: null, ready: true, gate: 'admin', match: under('/admin') },
];

/** Label of the bottom bar's fifth slot (the More sheet) per brand: "More" / 我的. */
export const MORE_LABEL_KEY: Record<BrandId, string> = { roboapply: 'more', goapply: 'cn_me' };

/**
 * Non-nav surfaces with the same readiness rule: the Topbar's Ask button
 * (the Assistant rail, WP-51) and the job-detail route the palette links to
 * (WP-34). Both shipped; set one to false to take that surface out.
 */
export const SURFACES_READY = {
  assistant: true, // WP-51 shipped the rail and /assistant; flipped by INT-12 (WP-93)
  jobDetail: true, // WP-34 shipped /jobs/[id]; flipped at the Wave 3 gate (WP-34 / WP-35 request)
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

/** The invite programme runs on this brand (every sign-up path attaches the invite). */
export function invitesLiveFor(brandId: BrandId): boolean {
  return INVITE_REWARD_BRANDS.includes(brandId);
}

/** The brand's browser extension is published (it has a store id), so there is something to get. */
export function extensionPublishedFor(brandId: BrandId): boolean {
  return extensionIdFor(brandId) !== null;
}

export function isNavEntryVisible(entry: NavEntry, ctx: NavVisibilityContext): boolean {
  if (!passesStaticRules(entry, ctx)) return false;
  if (entry.gate === 'admin' && !ctx.isAdmin) return false;
  if (entry.gate === 'coachRoster' && !ctx.coachRoster) return false;
  if (entry.gate === 'invitesLive' && !invitesLiveFor(ctx.brandId)) return false;
  if (entry.gate === 'extensionPublished' && !extensionPublishedFor(ctx.brandId)) return false;
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
 * The signed-in home: the first visible top entry, which is Jobs / 职位 on
 * both brands (neither carries a flag). The fallback covers a registry whose
 * top group is empty (the `ready` revert, or a test), so the logo and the
 * post-login redirect never land on a hidden page.
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
 * Where a job hit in the palette goes: `/jobs/[id]` (WP-34), or the feed if
 * `SURFACES_READY.jobDetail` is ever turned off.
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
