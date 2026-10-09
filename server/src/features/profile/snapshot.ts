// server/src/features/profile/snapshot.ts
//
// `profileSnapshotForLlm()` text builder (TASK_PLAN.md §2.2, H32). This is the
// ONLY profile context the Assistant, scoring, tailoring, cover letters and the
// extension may put in a prompt.
//
// It is built from an explicit ALLOWLIST, never by serializing the profile, so
// a field added later never leaks by default. It never contains:
//   - sensitive answers of any kind (RASensitiveAnswers is never read here):
//     EEO answers, gender, race, veteran or disability status, 籍贯, 政治面貌,
//     家庭成员, the photo;
//   - birth date or age (the profile stores none);
//   - contact and identity details: names, email, phone, street address,
//     postal code, profile links (renderers place them in documents after the
//     model runs);
//   - GoApply school tags (display and user filter only, never a ranking input).
// GoApply cnFields are read through a fixed key list for the same reason.

import { createHash } from 'node:crypto';

import type { ProfileView } from './contract.js';
import { filled, type Market, type ProfileCore } from './model.js';

/** cnFields keys a prompt may see. Everything else in the column is ignored. */
export const CN_SNAPSHOT_KEYS = [
  'identity',
  'graduationClass',
  'degree',
  'isFullTimeProgram',
  'schoolName',
  'major',
  'jobSearchStatus',
  'internshipDaysPerWeek',
  'internshipMonths',
  'availableFrom',
  'acceptReassignment',
] as const;

/** Keys that must never reach a prompt, whatever column they turn up in (checked by tests). */
export const NEVER_IN_PROMPT = [
  'eeo',
  'gender',
  'raceEthnicity',
  'veteranStatus',
  'disabilityStatus',
  'nativePlace',
  'politicalStatus',
  'photoAssetId',
  'familyMembers',
  'birthDate',
  'schoolTags',
] as const;

const yesNo = (v: boolean | null) => (v === null ? 'not answered' : v ? 'yes' : 'no');
const SPONSORSHIP: Record<string, string> = { now: 'needs sponsorship now', later: 'will need sponsorship later', no: 'does not need sponsorship' };
const PERMIT: Record<string, string> = {
  citizen_or_resident: 'citizen or resident (no work permit needed)',
  work_permit_needed: 'needs a work permit',
  gold_card: 'holds an Employment Gold Card',
};

function span(start: string | null, end: string | null, current: boolean): string {
  const s = start ?? '?';
  const e = current ? 'present' : (end ?? '?');
  return start || end || current ? ` (${s} – ${e})` : '';
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+\n/g, '\n').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function twPay(pay: NonNullable<NonNullable<ProfileView['twFields']>['desiredPay']>): string {
  if (pay.kind === 'negotiable') return 'negotiable (面議)';
  if (pay.kind === 'company_policy') return 'per company policy (依公司規定)';
  const { min, max } = pay.range;
  const amount = min !== null && max !== null ? `NT$${min}–${max}` : min !== null ? `from NT$${min}` : `up to NT$${max}`;
  return `${amount} per ${pay.kind === 'monthly' ? 'month' : 'year'}`;
}

/** Pure: the prompt text for one profile. */
export function buildSnapshotText(p: ProfileCore, market: Market): string {
  const lines: string[] = [];
  if (filled(p.headline)) lines.push(`Headline: ${clip(p.headline, 160)}`);
  const place = [p.city, p.region, p.country].filter(filled).join(', ');
  if (place) lines.push(`Location: ${place}`);
  if (filled(p.summary)) lines.push(`Summary: ${clip(p.summary, 2000)}`);

  if (market === 'cn' && p.cnFields) {
    const parts: string[] = [];
    for (const key of CN_SNAPSHOT_KEYS) {
      const v = p.cnFields[key];
      if (v === undefined || v === null || v === '') continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') parts.push(`${key}: ${String(v)}`);
    }
    if (parts.length) lines.push(`Background: ${parts.join('; ')}`);
  }

  if (p.skills.length) lines.push(`Skills: ${p.skills.map((s) => s.name).join(', ')}`);
  if (p.languages.length) lines.push(`Languages: ${p.languages.map((l) => `${l.language} (${l.level})`).join(', ')}`);

  if (market === 'intl' && p.workAuth.length) {
    lines.push('Work authorization (the person’s own answers):');
    for (const w of p.workAuth) {
      const bits = [`allowed to work: ${yesNo(w.authorized)}`];
      bits.push(w.sponsorship ? SPONSORSHIP[w.sponsorship]! : 'sponsorship: not answered');
      if (w.country === 'TW' && w.permit) bits.push(PERMIT[w.permit]!);
      lines.push(`- ${w.country}: ${bits.join('; ')}`);
    }
  }

  if (market === 'intl' && p.twFields) {
    const tw = p.twFields;
    const bits: string[] = [];
    if (tw.desiredTitles?.length) bits.push(`titles: ${tw.desiredTitles.join(', ')}`);
    if (tw.desiredLocations?.length) bits.push(`places: ${tw.desiredLocations.join(', ')}`);
    if (tw.desiredPay) bits.push(`expected pay: ${twPay(tw.desiredPay)}`);
    if (bits.length) lines.push(`Taiwan job preferences: ${bits.join('; ')}`);
  }

  if (p.experience.length) {
    lines.push('Experience:');
    for (const x of p.experience) {
      const tag = x.kind === 'internship' ? ' [internship]' : '';
      lines.push(`- ${x.title}, ${x.company}${x.location ? `, ${x.location}` : ''}${span(x.startDate, x.endDate, x.current)}${tag}`);
      if (filled(x.description)) lines.push(`  ${clip(x.description, 1200)}`);
      for (const b of x.bullets.slice(0, 12)) lines.push(`  • ${clip(b, 300)}`);
    }
  }

  if (p.education.length) {
    lines.push('Education:');
    for (const e of p.education) {
      const what = [e.degree, e.major].filter(filled).join(', ');
      const gpa = filled(e.gpa) ? `; GPA ${e.gpa}` : '';
      lines.push(`- ${what ? `${what} — ` : ''}${e.school}${span(e.startDate, e.endDate, e.current)}${gpa}`);
    }
  }

  return lines.join('\n');
}

/** Cache key: profile updatedAt + primary resume content hash. */
export function snapshotCacheKey(updatedAt: string | null, primaryResumeHash: string | null): string {
  return createHash('sha256')
    .update(`${updatedAt ?? 'none'}|${primaryResumeHash ?? 'none'}`)
    .digest('hex')
    .slice(0, 32);
}
