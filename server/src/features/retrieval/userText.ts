// server/src/features/retrieval/userText.ts
//
// What is embedded for a person (MATCH 4.9 "what is embedded for a user", 2.5
// cold start; MARKET_STRATEGY 2.5 rows "Embedding" and "Consent"):
//
//   intent  the default search's target titles and role labels, the level, the
//           top skills, the chosen industries and the career goal from
//           onboarding. It exists before any resume: the cold-start vector.
//   resume  the last two job titles of the PRIMARY resume with their bullet
//           text, its skills and its summary.
//
// Both are built from structured fields, so a name, an address or a contact
// line is never selected in the first place: no education entry (no school, no
// school tier), no personal-details block, no photo. The resume text then goes
// through a PII strip as a second guard for text a person typed into a bullet
// or a summary: the scorer's own `stripResumeForScoring` when the match area
// exports it, else `redactResumeText` below, which applies the same rules on
// its own (it does not depend on that export). Either way a line that carries
// a sensitive field (gender, birth date, age, 政治面貌, 籍贯, 民族, marital
// status, nationality, religion, an address, an id number) is dropped whole,
// and URLs, contact details, ids and the person's name are removed.
//
// A resume with no parsed data gives no resume text (and so no resume vector):
// its titles and bullets cannot be told apart from the rest of the document.
//
// `sourceHash` = sha1(text + model tag): a kind whose stored hash equals it is
// not embedded again.

import { createHash } from 'node:crypto';
import { LLM_PII_KINDS, redactPii } from '../../platform/pii/index.js';
import { taxonomyLabel } from '../jobs/taxonomy/index.js';

export const INTENT_TEXT_MAX_CHARS = 1200;
export const RESUME_TEXT_MAX_CHARS = 3000;
/** Skills that go into either text. */
export const USER_TEXT_MAX_SKILLS = 20;
/** Experience entries read from the resume, most recent first. */
export const RESUME_TEXT_TITLES = 2;

export interface IntentInput {
  /** FilterSet.titles of the search the feed uses. */
  targetTitles: readonly string[];
  /** FilterSet.taxonomyIds of that search. */
  targetTaxonomyIds: readonly string[];
  /** FilterSet.seniority of that search. */
  targetSeniority: readonly string[];
  skills: readonly string[];
  /** FilterSet.industries of that search. */
  industries: readonly string[];
  /** The career goal from onboarding (`more_senior`, …) or the profile's own words. */
  goal: string | null;
}

const REMOVED = /\[removed\]/gi;
const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function unique(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = v.toLowerCase();
    if (!v || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/** The intent text; '' when the person has stated nothing to search by. */
export function intentText(input: IntentInput): string {
  const titles = unique(input.targetTitles.map(clean));
  const roles = unique(input.targetTaxonomyIds.flatMap((id) => [taxonomyLabel(id, 'en'), taxonomyLabel(id, 'zh')]).map(clean));
  const level = unique(input.targetSeniority.map((s) => clean(s).replace(/_/g, ' ')));
  const skills = unique(input.skills.map(clean)).slice(0, USER_TEXT_MAX_SKILLS);
  const industries = unique(input.industries.map(clean));
  const goal = clean(input.goal).replace(/_/g, ' ');
  // Skills alone say what a person knows, not what they look for: with no title, role, industry or goal there is no intent.
  if (!titles.length && !roles.length && !industries.length && !goal) return '';
  return [titles.join(', '), roles.join(' / '), level.join(', '), skills.join(', '), industries.join(', '), goal].filter(Boolean).join('\n').slice(0, INTENT_TEXT_MAX_CHARS).trim();
}

/** Removes personal data from a text; the names are the person's own. */
export type ResumeStrip = (text: string, options: { names: Array<string | null | undefined> }) => string;

/**
 * Lines that carry a field no embedded text may contain, by their label (en,
 * zh, zh-TW). The same labels as the scorer's strip (features/match/pii.ts
 * `SENSITIVE_LINE`; that file is not on the match area's public surface, so
 * the lists are stated here and `userText.test.ts` pins them). A line that
 * matches is dropped whole: the conservative rule of the scorer.
 */
const SENSITIVE_LINE_LATIN =
  /(?:^|[\s|•·*#>-])(?:gender|sex|date of birth|birth ?date|dob|age|marital status|nationality|religion|ethnicity|race|photo|address|home address)\s*[:：]/iu;
// CJK labels may carry a suffix before the colon (出生年月：, 家庭住址：).
const SENSITIVE_LINE_CJK =
  /(?:性别|性別|出生|生日|年龄|年齡|籍贯|籍貫|政治面貌|民族|婚姻|婚否|宗教|照片|家庭成员|家庭成員|住址|地址|身份证|身分證)[^:：\n]{0,6}[:：]/u;

/** True for a line that names a sensitive field (gender, birth date, 政治面貌, 籍贯, marital status, an address, …). */
export function isSensitiveLine(line: string): boolean {
  return SENSITIVE_LINE_LATIN.test(line) || SENSITIVE_LINE_CJK.test(line);
}

/** Links: anything with a scheme or `www.`, and profile pages written without one (linkedin.com/in/…, github.com/…). */
const URL_TEXT =
  /\b(?:https?:\/\/|www\.)\S+|\b(?:[a-z0-9-]+\.)*(?:linkedin\.com|github\.com|github\.io|gitlab\.com|gitee\.com|bitbucket\.org|behance\.net|dribbble\.com|medium\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|weibo\.com|zhihu\.com|csdn\.net|juejin\.cn|stackoverflow\.com|kaggle\.com|leetcode\.com|leetcode\.cn|notion\.site|about\.me)(?:\/[^\s,;，；)）]*)?/giu;

/** Personal pages on shared hosts, written without a scheme (ada.vercel.app, ada.pages.dev/cv). */
const PERSONAL_HOST =
  /\b(?:[a-z0-9-]+\.)+(?:vercel\.app|netlify\.app|pages\.dev|web\.app|firebaseapp\.com|herokuapp\.com|onrender\.com|wixsite\.com|wordpress\.com|blogspot\.com|substack\.com|gitbook\.io|webflow\.io|framer\.website|carrd\.co|read\.cv)(?:\/[^\s,;，；)）]*)?/giu;

/** A bare host after a label that says it is the person's own page ("Site: ada.dev", "个人主页：ada.cn"). The label stays. */
const LABELLED_SITE =
  /((?:\b(?:web ?site|site|portfolio|blog|home ?page|personal page)|个人网站|个人主页|个人博客|主页|博客|作品集|個人網站|個人網頁|個人主頁|部落格)\s*[:：]\s*)(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s,;，；)）]*)?/giu;

/** Any bare host; removed only when it spells one of the person's names (adalovelace.dev). "socket.io" and "ASP.NET" stay. */
const BARE_HOST = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b(?:\/[^\s,;，；)）]*)?/giu;

/**
 * A chat handle after its label: 微信 wxm_dev2020, QQ 123456789, WeChat: coder_x99,
 * Telegram @coderx, LINE ID: ada_l. The label alone is ordinary resume text
 * ("WeChat mini programs", "QQ 音乐", "a product line", "Telegram bots"), so
 * what follows must be marked as a handle (号 / ID / a colon / @) or have the
 * shape of one (five characters or more with a digit or an underscore).
 * `wx` and `tg` are left out: too short to tell from code ("wx:else").
 */
const CHAT_LABEL = String.raw`(?:微信|weixin|wechat|vx|qq|telegram|whatsapp|skype)`;
const CHAT_MARK = String.raw`(?:号码?|账号|帳號|id\b)`;
const HANDLE = String.raw`@?[A-Za-z0-9][A-Za-z0-9_.-]{3,}`;
const CHAT_HANDLE = new RegExp(
  [
    // label, optional 号 / ID, a colon, the handle
    String.raw`(?<![A-Za-z])${CHAT_LABEL}\s*${CHAT_MARK}?\s*[:：]\s*${HANDLE}`,
    // label, 号 / ID, the handle
    String.raw`(?<![A-Za-z])${CHAT_LABEL}\s*${CHAT_MARK}\s*${HANDLE}`,
    // label, then an @handle
    String.raw`(?<![A-Za-z])${CHAT_LABEL}\s+@[A-Za-z0-9][A-Za-z0-9_.-]{3,}`,
    // label, then something handle-shaped
    String.raw`(?<![A-Za-z])${CHAT_LABEL}\s*(?=[A-Za-z0-9_.-]*[0-9_])[A-Za-z0-9][A-Za-z0-9_.-]{4,}`,
    // LINE only with "ID" (a "line" is an ordinary word)
    String.raw`(?<![A-Za-z])line\s*id\b\s*[:：]?\s*${HANDLE}`,
  ].join('|'),
  'giu',
);

/** What is left glued to a removed name: the rest of an address or of a host ("[removed]@example.com", "[removed]-portfolio.example.dev"). */
const REMOVED_REMNANT = /\S*\[removed\]\S*/g;
const REMNANT_SHAPE = /\[removed\][^\s@]*@|@[^\s@]*\[removed\]|\[removed\][A-Za-z0-9-]*\.[a-z]{2,}|[A-Za-z0-9-]\.\[removed\]/i;

function nameParts(names: Array<string | null | undefined>): string[] {
  const parts = new Set<string>();
  for (const name of names) {
    for (const part of (name ?? '').toLowerCase().split(/[^a-z]+/)) if (part.length >= 3) parts.add(part);
  }
  return [...parts];
}

/**
 * The strip used when the scorer's `stripResumeForScoring` is not reachable
 * through the match area's public surface. Safe on its own, in this order:
 *   1. every line that names a sensitive field is dropped (`isSensitiveLine`);
 *   2. URLs are removed (a profile link identifies the person), and with them
 *      a personal page written without a scheme: on a shared host, after a
 *      label ("Site:", "个人主页："), or spelling the person's name;
 *   3. a chat handle after its label is removed (微信, QQ, WeChat, Telegram, …):
 *      the usual way to leave a contact in a 自我评价 line;
 *   4. the platform redactor runs with the kinds no prompt may carry (contact
 *      details, addresses, government ids, health) and the person's names;
 *   5. what is left glued to a removed name (the domain of an address whose
 *      local part was the name, the rest of a host) is removed with it.
 */
export const redactResumeText: ResumeStrip = (text, { names }) => {
  const parts = nameParts(names);
  const kept = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !isSensitiveLine(line))
    .join('\n')
    .replace(URL_TEXT, '[removed]')
    .replace(PERSONAL_HOST, '[removed]')
    .replace(LABELLED_SITE, '$1[removed]')
    .replace(CHAT_HANDLE, '[removed]')
    .replace(BARE_HOST, (host) => {
      if (!parts.length) return host;
      const letters = host.toLowerCase().replace(/[^a-z]/g, '');
      return parts.some((part) => letters.includes(part)) ? '[removed]' : host;
    });
  return redactPii(kept, { kinds: LLM_PII_KINDS, marker: () => '[removed]', knownValues: names }).text.replace(REMOVED_REMNANT, (token) => (REMNANT_SHAPE.test(token) ? '[removed]' : token));
};

function skillsOf(parsed: Record<string, unknown>): string[] {
  const s = parsed.skills;
  const flat = (v: unknown): string[] => {
    if (typeof v === 'string') return [v];
    if (Array.isArray(v)) return v.flatMap(flat);
    if (isRecord(v)) return Array.isArray(v.skills) ? flat(v.skills) : typeof v.name === 'string' ? [v.name] : Object.values(v).flatMap((x) => (Array.isArray(x) ? flat(x) : []));
    return [];
  };
  return unique(flat(s).map(clean)).slice(0, USER_TEXT_MAX_SKILLS);
}

function bulletsOf(entry: Record<string, unknown>): string[] {
  for (const key of ['highlights', 'bullets', 'achievements', 'responsibilities']) {
    const v = entry[key];
    if (Array.isArray(v)) return v.map(clean).filter(Boolean);
  }
  const description = clean(entry.description);
  return description ? [description] : [];
}

export interface ResumeTextInput {
  /** The primary resume's `parsedData` (ParsedResume JSON). */
  parsedData: unknown;
}

/**
 * The resume text: the last two titles with their bullets, the skills and the
 * summary, after `strip`. '' when the resume has no parsed data to read them from.
 */
export function resumeText(resume: ResumeTextInput, options: { names: Array<string | null | undefined>; strip: ResumeStrip }): string {
  const parsed = resume.parsedData;
  if (!isRecord(parsed)) return '';
  const lines: string[] = [];
  const experience = Array.isArray(parsed.experience) ? parsed.experience.filter(isRecord).slice(0, RESUME_TEXT_TITLES) : [];
  for (const e of experience) {
    const title = clean(e.role) || clean(e.title);
    if (title) lines.push(title);
    for (const b of bulletsOf(e)) lines.push(`- ${b}`);
  }
  const skills = skillsOf(parsed);
  if (skills.length) lines.push(skills.join(', '));
  const summary = clean(parsed.summary) || clean(parsed.objective);
  if (summary) lines.push(summary);
  if (!lines.length) return '';
  const names = [...options.names, typeof parsed.candidateName === 'string' ? parsed.candidateName : null];
  const stripped = options.strip(lines.join('\n'), { names });
  return stripped
    .replace(REMOVED, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l && l !== '-' && l !== '#')
    .join('\n')
    .slice(0, RESUME_TEXT_MAX_CHARS)
    .trim();
}

/** sha1 of the text and the model tag it is embedded with. */
export function sourceHash(text: string, modelTag: string): string {
  return createHash('sha1').update(`${modelTag}\u001e${text}`).digest('hex');
}
