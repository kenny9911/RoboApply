'use client';

// lib/mockRoleLabels.ts
//
// Display-label localization for the mock-interview catalog's job CATEGORIES and
// ROLE titles. The catalog (lib/fixtures/mockCatalog.ts ↔ backend raMockCatalog)
// keeps its English strings as the CANONICAL value — they are the id used for
// the launch payload (`role`), recommendation matching (categoryForRole /
// suitedRoleCategories), and category/role equality in the picker. We therefore
// localize ONLY the on-screen label, mirroring how personas/types are localized
// (mock.setup.personas.<id>.* / mock.setup.types.<id>.*).
//
// Keys: mock.setup.role.categories.<slug> and mock.setup.role.roles.<slug>,
// where <slug> = slugifyMockRole(englishLabel). When a key is missing the
// English source is shown verbatim (graceful fallback for untranslated locales
// and free-text JD-derived titles).

import { useTranslations } from 'next-intl';

/** Stable i18n key slug for a catalog category name or role title. MUST match
 *  the slugs used to key the message files. e.g. "DevOps / Platform Engineer"
 *  → "devops-platform-engineer". */
export function slugifyMockRole(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface MockRoleLabelHelpers {
  /** Localized category label, English fallback. */
  localizeCategory: (name: string) => string;
  /** Localized role title, English fallback (incl. free-text JD titles). */
  localizeRole: (role: string) => string;
}

/** Hook returning localizers for catalog category names and role titles. */
export function useMockRoleLabels(): MockRoleLabelHelpers {
  const t = useTranslations('mock');
  const localizeCategory = (name: string): string => {
    const key = `setup.role.categories.${slugifyMockRole(name)}`;
    return t.has(key) ? t(key) : name;
  };
  const localizeRole = (role: string): string => {
    const key = `setup.role.roles.${slugifyMockRole(role)}`;
    return t.has(key) ? t(key) : role;
  };
  return { localizeCategory, localizeRole };
}
