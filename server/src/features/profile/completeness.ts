// server/src/features/profile/completeness.ts
//
// Profile completeness (F-ACCT-03; PRODUCT O9). Two lists per market:
//   required — the fields application forms ask for and the extension fills
//              (they produce the "Missing" markers, the completion card and
//              the nav's "Incomplete" dot);
//   helpful  — fields that improve tailoring and the Assistant but that no
//              form requires.
// Completeness = (2 × required filled + helpful filled) / (2 × required + helpful),
// rounded down, 0–100. Pure: it reads only the normalized profile.

import type { ProfileMissingField, ProfileSection } from './contract.js';
import { filled, type Market, type ProfileCore } from './model.js';

interface Rule {
  key: string;
  section: ProfileSection;
  required: boolean;
  markets: readonly Market[];
  /** Rule applies to this profile (default: always). */
  applies?: (p: ProfileCore) => boolean;
  done: (p: ProfileCore) => boolean;
}

const BOTH: readonly Market[] = ['intl', 'cn'];
const INTL: readonly Market[] = ['intl'];
const CN: readonly Market[] = ['cn'];

const cnIdentity = (p: ProfileCore): string | null => {
  const v = p.cnFields?.identity;
  return typeof v === 'string' ? v : null;
};
const isStudent = (p: ProfileCore) => {
  const id = cnIdentity(p);
  return id === 'yingjie' || id === 'zaixiao';
};

export const COMPLETENESS_RULES: readonly Rule[] = [
  // Personal
  { key: 'firstName', section: 'personal', required: true, markets: BOTH, done: (p) => filled(p.firstName) },
  { key: 'lastName', section: 'personal', required: true, markets: BOTH, done: (p) => filled(p.lastName) },
  { key: 'contactEmail', section: 'personal', required: true, markets: BOTH, done: (p) => filled(p.contactEmail) },
  { key: 'phone', section: 'personal', required: true, markets: BOTH, done: (p) => filled(p.phoneE164) },
  { key: 'location', section: 'personal', required: true, markets: INTL, done: (p) => filled(p.city) && filled(p.country) },
  { key: 'city', section: 'personal', required: true, markets: CN, done: (p) => filled(p.city) },
  { key: 'headline', section: 'personal', required: false, markets: BOTH, done: (p) => filled(p.headline) },
  { key: 'summary', section: 'personal', required: false, markets: BOTH, done: (p) => filled(p.summary) },
  // GoApply 基本信息
  { key: 'cnIdentity', section: 'basics', required: true, markets: CN, done: (p) => cnIdentity(p) !== null },
  {
    key: 'graduationClass',
    section: 'basics',
    required: true,
    markets: CN,
    applies: isStudent,
    done: (p) => typeof p.cnFields?.graduationClass === 'number',
  },
  // Education
  { key: 'education', section: 'education', required: true, markets: BOTH, done: (p) => p.education.length > 0 },
  // Work: required unless a GoApply student (students may have no internship yet).
  { key: 'experience', section: 'work', required: true, markets: INTL, done: (p) => p.experience.length > 0 },
  { key: 'experience', section: 'work', required: true, markets: CN, applies: (p) => !isStudent(p), done: (p) => p.experience.length > 0 },
  { key: 'experience', section: 'work', required: false, markets: CN, applies: isStudent, done: (p) => p.experience.length > 0 },
  // Skills
  { key: 'skills', section: 'skills', required: true, markets: BOTH, done: (p) => p.skills.length > 0 },
  { key: 'languages', section: 'skills', required: false, markets: BOTH, done: (p) => p.languages.length > 0 },
  // Links (LinkedIn is RoboApply only: F-NET-01 is SKIP on GoApply)
  { key: 'linkedin', section: 'links', required: false, markets: INTL, done: (p) => filled(p.links.linkedin) },
  {
    key: 'links',
    section: 'links',
    required: false,
    markets: CN,
    done: (p) => filled(p.links.github) || filled(p.links.portfolio) || filled(p.links.website),
  },
  // Work authorization: at least one country answered (RoboApply only).
  { key: 'workAuth', section: 'workAuth', required: true, markets: INTL, done: (p) => p.workAuth.some((w) => w.authorized !== null) },
];

/** i18n key of a missing field's label (`profile.missing.<key>`, staged in i18n/staging/profile.en.json). */
export const missingLabelKey = (key: string) => `profile.missing.${key}`;

export interface CompletenessResult {
  completeness: number;
  missing: ProfileMissingField[];
}

export function computeCompleteness(profile: ProfileCore, market: Market): CompletenessResult {
  let weight = 0;
  let got = 0;
  const missing: ProfileMissingField[] = [];
  for (const rule of COMPLETENESS_RULES) {
    if (!rule.markets.includes(market)) continue;
    if (rule.applies && !rule.applies(profile)) continue;
    const w = rule.required ? 2 : 1;
    weight += w;
    if (rule.done(profile)) got += w;
    else if (rule.required) missing.push({ key: rule.key, label: missingLabelKey(rule.key), section: rule.section });
  }
  return { completeness: weight === 0 ? 0 : Math.floor((100 * got) / weight), missing };
}
