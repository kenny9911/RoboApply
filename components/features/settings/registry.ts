// components/features/settings/registry.ts — the /settings sections, per brand
// (FND-6a; PRODUCT_PLAN.md §3.4 and F-ACCT-05; ARCHITECTURE.md §11.2).
//
// /settings is ONE page; each section is a hash (`/settings#billing`). This
// list is the single source for the page's section row, the Sidebar's
// Settings group and every deep link, in this order:
//
//   PRODUCT §3.4:   #account #security #notifications #billing #credits
//                   #privacy #appearance [#consents on GoApply] … #danger
//   plan additions: #search #assistant #devices #connections #referrals
//                   #sensitive
//
// The Danger zone stays last: PRODUCT's eight keep their relative order, and
// the added sections sit before it rather than after a destructive section.
//
// Visibility uses the nav rule (components/v3/shell/destinations.ts): brand,
// `ready` (`NEXT_PUBLIC_SHOW_ALL_NAV=true` skips it), the capability
// `requires` (fails closed) and, for one section, `available` (a per-brand
// rule that is not a capability flag).
//
// READY FLIPS (INT-12 / WP-93, after the no-dead-ends audit in
// __tests__/shell/noDeadEnds.test.tsx). To take ONE section back out, set its
// `ready` to false here; nothing else changes:
//   assistant    WP-51   shown with `copilot`
//   devices      WP-55a  shown with `extension` once the brand's extension is
//                        published (a store id is configured): before that
//                        no browser can be connected, so there is no list
//   connections  WP-54   shown whenever `hiringContacts` is not 'off', so
//                        "Delete all imported connections" stays reachable
//                        after the mode drops from 'on' (importing itself
//                        still needs 'on'; the section says so)
//   referrals    WP-60   shown with `invites` on a brand whose every sign-up
//                        attaches the invite (INVITE_REWARD_BRANDS)
//
// Content: the area component in `sectionComponents.ts`, or the route's
// renderer for account / security / danger.
//
// `labelKey` is a FULL message key: existing sections keep their translated
// `settings.nav.*` labels; new ones are staged under `nav.settingsSections.*`.
// `aliases` keep old deep links working (`#notif` → notifications).

import { extensionIdFor } from '../../../hooks/extension/bridge';
import { INVITE_REWARD_BRANDS } from '../../../hooks/growth/useInvites';
import type { BrandId } from '../../../lib/brand/registry.generated';
import type { ResolvedFlags } from '../../../lib/flags';

export type SettingsSectionId =
  | 'account'
  | 'security'
  | 'notifications'
  | 'billing'
  | 'credits'
  | 'privacy'
  | 'appearance'
  | 'consents'
  | 'search'
  | 'assistant'
  | 'devices'
  | 'connections'
  | 'referrals'
  | 'sensitive'
  | 'danger';

/** The area that owns a section's content (its `components/features/<area>/SettingsSection.tsx`). */
export type SettingsOwnerArea =
  | 'auth'
  | 'notifications'
  | 'credits'
  | 'compliance'
  | 'brand'
  | 'search'
  | 'copilot'
  | 'extension'
  | 'network'
  | 'growth'
  | 'profile';

export interface SettingsSectionEntry {
  id: SettingsSectionId;
  /** Full message key (namespace included). */
  labelKey: string;
  brands: readonly BrandId[];
  /** Capability check; absent = always. Fails closed while flags load. */
  requires?: (flags: Partial<ResolvedFlags>) => boolean;
  /** A per-brand rule that is not a capability flag; absent = always. */
  available?: (brandId: BrandId) => boolean;
  /** False while the owner's section is not shipped (INT-12 flipped the last four; see the header). */
  ready: boolean;
  owner: SettingsOwnerArea;
  /** Owner WP, for the handoff trail. */
  wp: string;
  danger?: boolean;
  /** Old hashes that open this section. */
  aliases?: readonly string[];
}

const BOTH: readonly BrandId[] = ['roboapply', 'goapply'];

export const SETTINGS_REGISTRY: readonly SettingsSectionEntry[] = [
  { id: 'account', labelKey: 'settings.nav.account', brands: BOTH, ready: true, owner: 'auth', wp: 'WP-10' },
  { id: 'security', labelKey: 'nav.settingsSections.security', brands: BOTH, ready: true, owner: 'auth', wp: 'WP-10' },
  { id: 'notifications', labelKey: 'settings.nav.notif', brands: BOTH, ready: true, owner: 'notifications', wp: 'WP-39b', aliases: ['notif'] },
  { id: 'billing', labelKey: 'settings.nav.billing', brands: BOTH, ready: true, owner: 'credits', wp: 'WP-21b' },
  { id: 'credits', labelKey: 'nav.settingsSections.credits', brands: BOTH, ready: true, owner: 'credits', wp: 'WP-21b' },
  { id: 'privacy', labelKey: 'nav.settingsSections.privacy', brands: BOTH, ready: true, owner: 'compliance', wp: 'WP-13' },
  { id: 'appearance', labelKey: 'settings.nav.appearance', brands: BOTH, ready: true, owner: 'brand', wp: 'WP-12' },
  { id: 'consents', labelKey: 'nav.settingsSections.consents', brands: ['goapply'], ready: true, owner: 'compliance', wp: 'WP-13' },
  { id: 'search', labelKey: 'settings.nav.search', brands: BOTH, ready: true, owner: 'search', wp: 'WP-20', aliases: ['resume'] },
  { id: 'assistant', labelKey: 'nav.settingsSections.assistant', brands: BOTH, ready: true, owner: 'copilot', wp: 'WP-51', requires: (f) => f.copilot === true },
  { id: 'devices', labelKey: 'nav.settingsSections.devices', brands: BOTH, ready: true, owner: 'extension', wp: 'WP-55a', requires: (f) => f.extension === true, available: (b) => extensionIdFor(b) !== null },
  { id: 'connections', labelKey: 'nav.settingsSections.connections', brands: BOTH, ready: true, owner: 'network', wp: 'WP-54', requires: (f) => f.hiringContacts === 'deeplinks_only' || f.hiringContacts === 'on' },
  { id: 'referrals', labelKey: 'nav.settingsSections.referrals', brands: BOTH, ready: true, owner: 'growth', wp: 'WP-60', requires: (f) => f.invites === true, available: (b) => INVITE_REWARD_BRANDS.includes(b) },
  { id: 'sensitive', labelKey: 'nav.settingsSections.sensitive', brands: BOTH, ready: true, owner: 'profile', wp: 'WP-19' },
  { id: 'danger', labelKey: 'settings.nav.danger', brands: BOTH, ready: true, owner: 'auth', wp: 'WP-10', danger: true },
];

export const SETTINGS_SECTION_IDS: readonly SettingsSectionId[] = SETTINGS_REGISTRY.map((s) => s.id);

export interface SettingsVisibilityContext {
  brandId: BrandId;
  flags: Partial<ResolvedFlags> | null;
  showAll: boolean;
}

export function isSettingsSectionVisible(entry: SettingsSectionEntry, ctx: SettingsVisibilityContext): boolean {
  if (!entry.brands.includes(ctx.brandId)) return false;
  if (!entry.ready && !ctx.showAll) return false;
  if (entry.requires && !(ctx.flags && entry.requires(ctx.flags))) return false;
  if (entry.available && !entry.available(ctx.brandId)) return false;
  return true;
}

/** Pure: the sections shown for a brand/flags, in registry order. */
export function visibleSettingsSections(
  ctx: SettingsVisibilityContext,
  registry: readonly SettingsSectionEntry[] = SETTINGS_REGISTRY,
): SettingsSectionEntry[] {
  return registry.filter((s) => isSettingsSectionVisible(s, ctx));
}

/** Resolve a hash (with or without '#', aliases included) to a section id, or null. */
export function sectionIdFromHash(hash: string, registry: readonly SettingsSectionEntry[] = SETTINGS_REGISTRY): SettingsSectionId | null {
  const raw = hash.replace(/^#/, '').split('?')[0];
  if (!raw) return null;
  const hit = registry.find((s) => s.id === raw || s.aliases?.includes(raw));
  return hit ? hit.id : null;
}

/** Absolute href for a section — valid from any route. */
export function settingsHref(id: SettingsSectionId): string {
  return `/settings#${id}`;
}
