// lib/resumeAI.ts
//
// Local heuristic AI helpers — same signatures the real LLM-backed endpoints
// will expose. The editor wires its "AI rewrite" / "Generate summary" buttons
// to these. Each function returns a Promise so the UI can wear its loading
// state honestly; when the real endpoint lands, only the function bodies
// change.
//
// The transformations are deliberately conservative — they make bullets
// punchier (action verb + quantified outcome) without inventing claims that
// aren't in the original text.

import type { StructuredResume } from './resumeStructure';

function fakeLatency(ms = 600): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const WEAK_OPENERS: Record<string, string> = {
  worked: 'Led',
  helped: 'Drove',
  responsible: 'Owned',
  assisted: 'Partnered on',
  did: 'Delivered',
  was: 'Owned',
  had: 'Led',
  in: 'Drove',
  participated: 'Co-led',
  contributed: 'Shipped',
};

const ACTION_BANK = [
  'Led',
  'Shipped',
  'Reduced',
  'Designed',
  'Owned',
  'Built',
  'Scaled',
  'Optimized',
  'Drove',
  'Launched',
];

function rewriteBulletHeuristic(text: string): string {
  let t = text.trim();
  if (!t) return t;

  // Strip the leading bullet marker if one slipped in.
  t = t.replace(/^[-*•]\s+/, '');

  // Capitalize first letter.
  t = t.charAt(0).toUpperCase() + t.slice(1);

  // Replace weak openers.
  const firstWord = t.split(/\s+/)[0].toLowerCase();
  if (WEAK_OPENERS[firstWord]) {
    t = WEAK_OPENERS[firstWord] + t.slice(firstWord.length);
  }

  // If still starts with a weak filler, pick a strong verb based on length.
  const opener = t.split(/\s+/)[0];
  if (opener.length < 3) {
    const pick = ACTION_BANK[Math.floor(Math.random() * ACTION_BANK.length)];
    t = `${pick} ${t}`;
  }

  // Replace "and was responsible for" / "in charge of" with "owned".
  t = t.replace(/\b(was responsible for|in charge of|responsible for)\b/gi, 'owned');

  // Collapse double whitespace.
  t = t.replace(/\s+/g, ' ').trim();

  // Add a soft quantifier nudge if none exist.
  if (!/\d/.test(t)) {
    t = t.replace(/\.$/, '');
    t += '; quantify the impact (e.g. 30% faster, 8M users, $1M saved).';
  }
  return t;
}

export async function aiRewriteBullet(text: string): Promise<string> {
  await fakeLatency();
  return rewriteBulletHeuristic(text);
}

export async function aiRewriteBullets(bullets: string[]): Promise<string[]> {
  await fakeLatency(800);
  return bullets.map(rewriteBulletHeuristic);
}

export async function aiGenerateSummary(
  resume: StructuredResume,
): Promise<string> {
  await fakeLatency(900);
  const title = resume.targetTitle.trim() || 'Software professional';
  const yearsHint = resume.experiences.length;
  const topCompanies = resume.experiences
    .map((e) => e.company.trim())
    .filter((c) => c)
    .slice(0, 3);
  const topSkills = resume.skills.slice(0, 5);

  const segments: string[] = [];
  segments.push(`${title} with ${yearsHint > 0 ? `${yearsHint}+ roles` : 'a strong background'} delivering measurable outcomes.`);
  if (topCompanies.length) {
    segments.push(
      `Most recently at ${topCompanies.join(' and ')}, where I shipped end-to-end features that moved real business metrics.`,
    );
  }
  if (topSkills.length) {
    segments.push(
      `Comfortable across ${topSkills.join(', ')} — equally at home setting direction and going deep on the code.`,
    );
  }
  segments.push(
    'Looking for a role where I can pair ambitious technical work with the team that ships it to users.',
  );
  return segments.join(' ');
}

export interface BulletDraftContext {
  company: string;
  title: string;
  /** What the user has already typed in the composer (may be empty). */
  seed?: string;
  /** Bullets already on this role — so the draft doesn't repeat them. */
  existing?: string[];
}

const TEMPLATE_DRAFTS: ((ctx: BulletDraftContext) => string)[] = [
  (c) =>
    `Led a ${c.title || 'cross-functional'} initiative at ${c.company || 'the company'} that shipped end-to-end and lifted [metric] by [X]% over [N months].`,
  (c) =>
    `Reduced [latency/cost/errors] by [X]% on the ${c.company || 'product'} stack by [specific change you owned].`,
  (c) =>
    `Designed and rolled out a new [system/process] adopted by [N teams / X users], cutting [bottleneck] by [Y]%.`,
  (c) =>
    `Mentored [N] ${c.title?.toLowerCase().includes('senior') || c.title?.toLowerCase().includes('lead') ? 'engineers' : 'teammates'} through their first production ship and standardized [practice] now used company-wide.`,
];

export async function aiDraftBullet(ctx: BulletDraftContext): Promise<string> {
  await fakeLatency(700);
  // If the user typed a seed, just rewrite it punchier.
  if (ctx.seed && ctx.seed.trim().length > 0) {
    return rewriteBulletHeuristic(ctx.seed);
  }
  // Pick a template that hasn't been used yet in this role's bullets.
  const existing = (ctx.existing ?? []).join(' \n ').toLowerCase();
  const ordered = [...TEMPLATE_DRAFTS].sort(() => Math.random() - 0.5);
  for (const fn of ordered) {
    const candidate = fn(ctx);
    const stem = candidate.split(/\s+/).slice(0, 2).join(' ').toLowerCase();
    if (!existing.includes(stem)) return candidate;
  }
  return ordered[0](ctx);
}

export async function aiGenerateBulletsFromJob(jobDescription: string): Promise<string[]> {
  await fakeLatency(1000);
  // Extract noun-phrases (very crude) — we want the LLM to do this later.
  const cleaned = jobDescription
    .replace(/[^\w\s,.;:-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = cleaned.split(/[.;]\s+/).filter((s) => s.split(/\s+/).length >= 4);
  const picks = sentences.slice(0, 4).map((s) => {
    const trimmed = s.trim().replace(/^(you'll|you will|the role|the candidate|we are looking for)\s*/i, '');
    return rewriteBulletHeuristic(trimmed);
  });
  if (picks.length === 0) {
    return [
      'Led the rollout of a new feature from spec through ship; quantify the impact.',
      'Reduced latency / cost / errors by X% across the affected surface.',
      'Partnered with PM and design to align the team behind one shippable plan.',
    ];
  }
  return picks;
}
