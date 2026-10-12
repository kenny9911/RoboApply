#!/usr/bin/env node
// scripts/check-copy.mjs
//
// Gates over the product's words:
//
//   1. BANNED WORDS — every term the panel found a first-time job seeker
//      cannot understand cold, plus every claim the product is not allowed to
//      make. Runs over all nine locale bundles, the staging files the feature
//      waves write (i18n/staging), the GoApply override bundles
//      (i18n/brands/**), the server email bundles (server/src/i18n/**) and the
//      extension bundles (extension/src/i18n/**), because "queue" and "ATS"
//      leak through translation unchanged. Each rule is
//      `{ term, locales, regex, reason }` (TASK_PLAN.md R-12): word-boundary
//      regexes where a substring would misfire, per-locale terms for the
//      translated auto-apply wording.
//
//   2. BRAND NEUTRALITY — no literal "RoboApply"/"GoApply" in any bundle
//      (`%BRAND%` / `%OTHER_BRAND%`, substituted per host by lib/i18n.ts), and
//      the count of each token per key is equal across locales. The recruiter
//      banks RoboHire/GoHire are real source names (D3) and are allowed.
//
//   3. CALL-SITE INTEGRITY — every t('key') resolves in en.json ∪ the staged
//      English, and every locale bundle has the same key set as English.
//      This matters more than it looks: lib/i18n.ts deep-merges each locale
//      over English and app/providers.tsx sets no onError, so next-intl does
//      NOT throw on a missing key — it renders the literal dotted path. A
//      deleted key ships to production as the string "jobs.headline", in all
//      nine locales, and neither `next build` nor `vitest` catches it.
//
//   npm run check:copy            (`--root <dir>` checks another tree; tests use it)
//
// See docs/roboapply/OVERHAUL_RULINGS.md §3 and C30, PRODUCT_PLAN.md §5.25,
// ARCHITECTURE.md §10.1.4, CN_TW_LAUNCH_PLAN.md §9.1.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LOCALES = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pt', 'de'];
/** The locales GoApply serves (server/src/platform/brand/registry.ts, goapply.locales). */
export const GOAPPLY_LOCALES = ['en', 'zh'];
/** Key prefixes that render on GoApply only; parity is required in GOAPPLY_LOCALES alone. */
export const GOAPPLY_ONLY_PREFIXES = ['authCn', 'billingCn', 'jobsCn', 'onboardingCn', 'practiceCn', 'notifyCn', 'campus', 'landing.cnHome'];
export function isGoApplyOnlyPath(path) {
  return GOAPPLY_ONLY_PREFIXES.some((p) => path === p || path.startsWith(`${p}.`));
}
const ALL = '*';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A plain substring rule (the original gate's semantics; case-insensitive). */
const sub = (term, reason, locales = ALL) => ({ term, locales, regex: new RegExp(escape(term), 'iu'), reason });
// Unicode-aware word boundaries (`\b` is ASCII-only, so "illimité " would not end a word).
const B0 = '(?<![\\p{L}\\p{N}_])';
const B1 = '(?![\\p{L}\\p{N}_])';
/** A word-boundary rule for Latin-script terms ("ATS." and "(JD)" match; "stats" does not). */
const word = (term, reason, locales = ALL) => ({ term, locales, regex: new RegExp(`${B0}${escape(term)}${B1}`, 'iu'), reason });
/** A pattern rule wrapped in word boundaries. */
const wre = (term, source, reason, locales = ALL) => ({ term, locales, regex: new RegExp(`${B0}(?:${source})${B1}`, 'iu'), reason });
/** A rule with an explicit pattern. */
const re = (term, regex, reason, locales = ALL) => ({ term, locales, regex, reason });

const D1 = 'the product never submits to an employer (D1)';
const AFFILIATION = 'implies affiliation; say "模拟企业常用的 AI 面试形式"';
const NO_UNLIMITED = 'caps are printed ("Up to N a day"), never "unlimited" (PRODUCT §6.1)';

/** term → why it is banned. The reason is printed on failure, because a bare
 *  "banned word" error just gets worked around with a synonym. */
export const BANNED = [
  // ── Original gate (unchanged semantics; no existing ban is removed) ──────
  // Auto-apply vocabulary — the product does not submit anything (ruling R1).
  sub('auto-apply', 'the product never submits to an employer'),
  sub('auto-applied', 'the product never submits to an employer'),
  sub('autopilot', 'the product never submits to an employer'),
  sub('review queue', 'the queue concept is deleted'),
  sub('consent layer', 'internal architecture vocabulary'),
  sub('review hold', 'internal architecture vocabulary'),
  sub('night shift', 'idiom, and it narrates work that did not happen'),
  sub('while you slept', 'narrates work that did not happen'),
  sub('on your behalf', 'implies an agent acting as you'),
  sub('on my end', 'first-person persona in an error message'),
  // Invented scales the user has no calibration for (rulings C2, C3).
  sub('threshold', 'asks the user to pick an integer on a scale they have never seen'),
  sub('above bar', 'implies an invisible cut line'),
  sub('cleared your bar', 'implies an invisible cut line'),
  sub('strong match', 'a fifth quality word; the ladder is Great fit / Good fit / Possible / Unlikely'),
  sub('long shot', 'idiom (betting)'),
  sub('stretch role', 'idiom (rubber)'),
  // Recruiter-side and engineer-side vocabulary leaking into a candidate UI.
  // `jd` was the space-padded ' jd '; the word boundary also catches "(JD)" and "JD.".
  word('jd', 'ATS/recruiter abbreviation'),
  sub('applicant tracking', 'a first-time job seeker has never heard this'),
  sub('ats-safe', 'ATS expands to a phrase the user does not know'),
  sub('ats-friendly', 'ATS expands to a phrase the user does not know'),
  sub('parser', 'compiler-theory word'),
  sub('recruiter screen', 'nobody outside recruiting calls a phone call a screen'),
  sub('onsite', 'factually wrong — most final loops are video calls'),
  sub('trajectory', 'physics word; nobody describes their own career this way'),
  sub('dimension', 'analyst vocabulary'),
  sub('kanban', 'project-management tool vocabulary'),
  sub('funnel', 'internal/sales vocabulary'),
  sub('pipeline', 'internal vocabulary'),
  // Compliance vocabulary in a consumer product (ruling C12).
  sub('violation', 'compliance vocabulary on a screen where someone is sending a document'),
  sub('citation-checked', 'names the mechanism, not the source'),
  // The agent persona (ruling D4).
  sub('your ai job hunter', 'the agent persona is deleted'),
  sub('mission control', 'invented noun'),
  sub('aggressiveness', 'invented setting'),

  // ── R-12 additions (PRODUCT §5.25 ∪ ARCH §10.1.4 ∪ CN §9.1) ──────────────
  wre('apply for you', 'appl(?:y|ies|ied) for you', D1),
  word('we apply', D1),
  wre('submit for you', 'submit(?:s|ted)? for you', D1),
  re('auto-submit', /(?<![\p{L}\p{N}_])auto[- ]?submit/iu, 'implies submission; our action is "Fill this form"'),
  re('one-click apply', /(?<![\p{L}\p{N}_])(?:one|1)[- ]click apply/iu, 'implies submission; the extension fills, the user submits'),
  re('insider', /(?<!business )(?<![\p{L}\p{N}_])insiders?(?![\p{L}\p{N}_])/iu, 'implies privileged contacts we do not have; say "People at {company}" (the publication "Business Insider" is a source name)'),
  word('hidden jobs', 'implies secret inventory; say "Recruiter-posted"'),
  re(
    'guarantee',
    /(?<!(?<![\p{L}])(?:no|not|never|cannot|can not|can't|can’t|don't|don’t|do not|doesn't|doesn’t|does not|won't|won’t|will not)\s+)(?<![\p{L}\p{N}_])guarantee(?:d|s)?(?![\p{L}\p{N}_])/iu,
    'no outcome is guaranteed (D3, F-TRUST-05); "no guarantee" / "can\'t guarantee" / "cannot guarantee" pass',
  ),
  word('ats', 'extends ruling C8: a first-time job seeker does not know the abbreviation'),
  word('unlimited', NO_UNLIMITED),
  sub('not on other job boards', 'we cannot verify it (F-FEED-04)'),
  // `unlimited` in every locale.
  sub('无限', NO_UNLIMITED, ['zh']),
  sub('無限', NO_UNLIMITED, ['zh-TW', 'ja']),
  sub('無制限', NO_UNLIMITED, ['ja']),
  sub('무제한', NO_UNLIMITED, ['ko']),
  wre('ilimitado', 'ilimitad[oa]s?', NO_UNLIMITED, ['es', 'pt']),
  wre('illimité', 'illimité(?:e|s|es)?', NO_UNLIMITED, ['fr']),
  re('unbegrenzt', /(?<![\p{L}\p{N}_])(?:unbegrenzt|unbeschränkt)/iu, NO_UNLIMITED, ['de']),
  // Translated auto-apply wording (English terms never match translated bundles).
  sub('自動応募', D1, ['ja']),
  sub('代わりに応募', D1, ['ja']),
  sub('자동 지원', D1, ['ko']),
  sub('대신 지원', D1, ['ko']),
  sub('postulación automática', D1, ['es']),
  sub('postulamos por ti', D1, ['es']),
  sub('candidature automatique', D1, ['fr']),
  sub('postule pour vous', D1, ['fr']),
  sub('candidatura automática', D1, ['pt']),
  sub('candidatamo-nos por si', D1, ['pt']),
  sub('automatische bewerbung', D1, ['de']),
  sub('bewirbt sich für sie', D1, ['de']),
  ...['自动投递', '一键投递', '一键网申', '代投', '海投', '自动打招呼', '替你投递', '帮你投递'].map((t) => sub(t, D1, ['zh'])),
  ...['自動投遞', '一鍵投遞', '代投', '海投', '自動應徵', '替你應徵', '幫你應徵'].map((t) => sub(t, D1, ['zh-TW'])),
  sub('北森', AFFILIATION, ['zh']),
  sub('牛客', AFFILIATION, ['zh']),
];

/**
 * Scoped exceptions: key path (exact, or a `prefix.*` wildcard) → banned
 * `term`s legitimate there. Each one is a reviewed false positive.
 */
export const ALLOW = {
  // The résumé editor legitimately talks about job descriptions it tailors to.
  'jobs.description': ['jd'],
  // SEO search intent: the meta title must match "applicant tracking system resume checker" (ARCH §10.1.4).
  'seo.tools.resumeChecker.meta.*': ['applicant tracking'],
  // FAQ questions that ask whether the product applies for the user; the answers say it never does (false-positive grep, FND-7).
  'landing.faq.items.q5.q': ['apply for you'],
  'landing.faq.items.q2.q': ['代わりに応募', '대신 지원'],
};

export function allowed(path, term) {
  for (const [key, terms] of Object.entries(ALLOW)) {
    const match = key.endsWith('.*') ? path.startsWith(key.slice(0, -1)) : path === key;
    if (match && terms.includes(term)) return true;
  }
  return false;
}

/** Banned rules a string breaks in a locale (allows applied). */
export function findBanned(value, locale, path = '') {
  const hits = [];
  for (const rule of BANNED) {
    if (rule.locales !== ALL && !rule.locales.includes(locale)) continue;
    if (!rule.regex.test(value)) continue;
    if (path && allowed(path, rule.term)) continue;
    hits.push(rule);
  }
  return hits;
}

export const LITERAL_BRAND_RE = /RoboApply|GoApply/;
export const BRAND_TOKENS = ['%BRAND%', '%OTHER_BRAND%'];

export function leaves(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, path, out);
    else out.set(path, String(v));
  }
  return out;
}

const countToken = (s, token) => s.split(token).length - 1;

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function jsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => join(dir, f));
}

function walkDirs(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkDirs(full, out);
    else out.push(full);
  }
  return out;
}

/** The locale a bundle file speaks, from its name. */
export function localeOf(file) {
  const name = basename(file, '.json');
  const parts = name.split('.');
  const last = parts.at(-1);
  if (LOCALES.includes(last)) return last;
  return 'en';
}

/**
 * Every bundle the banned-word and brand rules scan:
 * `{ file, locale, data, kind }` (kind: messages | staging | brands | email | extension).
 */
export function collectBundles(root) {
  const out = [];
  const add = (file, kind) => {
    if (file.endsWith('.remove.json') || basename(file).startsWith('_')) return;
    const data = readJsonSafe(file);
    if (data && typeof data === 'object' && !Array.isArray(data)) out.push({ file, kind, locale: localeOf(file), data });
  };
  for (const f of jsonFiles(join(root, 'i18n/messages'))) add(f, 'messages');
  for (const f of jsonFiles(join(root, 'i18n/staging'))) add(f, 'staging');
  for (const f of walkDirs(join(root, 'i18n/brands')).filter((f) => f.endsWith('.json'))) add(f, 'brands');
  for (const f of walkDirs(join(root, 'server/src/i18n')).filter((f) => f.endsWith('.json'))) add(f, 'email');
  for (const f of walkDirs(join(root, 'extension/src/i18n')).filter((f) => f.endsWith('.json'))) add(f, 'extension');
  return out;
}

const FIXTURES = ['lib/stub/raV2.stub.ts'];

/** Run every rule; returns the violation list (empty when clean). */
export function runCopyCheck(root) {
  const violations = [];
  const fail = (file, path, rule, detail) => violations.push({ file: relative(root, file) || file, path, rule, detail });

  const bundles = collectBundles(root);

  // ── 1. Banned words, every scanned bundle ──────────────────────────────────
  for (const b of bundles) {
    for (const [path, value] of leaves(b.data)) {
      for (const rule of findBanned(value, b.locale, path)) {
        fail(b.file, path, 'banned-word', `"${rule.term}" — ${rule.reason}`);
      }
    }
  }

  // ── 1b. Banned words in fixture data ───────────────────────────────────────
  //
  // lib/stub/raV2.stub.ts is not "just test data": with NEXT_PUBLIC_USE_STUB_API
  // it is what every screen renders in development, in the unit tests, and in any
  // demo. Fixture strings are product copy.
  for (const rel of FIXTURES) {
    let src;
    try {
      src = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue; // fixture removed — not this gate's business
    }
    src.split('\n').forEach((raw, i) => {
      const line = raw.trim();
      // Comments describe the code; they are not shown to anyone.
      if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) return;
      // Only STRING LITERALS can reach a user. Checking the whole line would flag
      // `aggressiveness: body.aggressiveness` — an API field name, not copy.
      const literals = raw.match(/'[^']*'|"[^"]*"|`[^`]*`/g) ?? [];
      for (const lit of literals) {
        for (const rule of findBanned(lit.slice(1, -1), 'en')) {
          fail(join(root, rel), `line ${i + 1}`, 'banned-word-fixture', `"${rule.term}" — ${rule.reason}`);
        }
      }
    });
  }

  // ── 2. Brand neutrality ────────────────────────────────────────────────────
  for (const b of bundles) {
    for (const [path, value] of leaves(b.data)) {
      if (LITERAL_BRAND_RE.test(value)) {
        fail(b.file, path, 'literal-brand', 'write %BRAND% / %OTHER_BRAND% (substituted per host), never the product name');
      }
    }
  }
  // Token parity per key across locales: web messages and email bundles.
  for (const kind of ['messages', 'email']) {
    const group = bundles.filter((b) => b.kind === kind && !b.file.includes(`${'/'}staging${'/'}`));
    const en = group.find((b) => b.locale === 'en' && basename(b.file) === 'en.json');
    if (!en) continue;
    const enLeaves = leaves(en.data);
    for (const b of group) {
      if (b === en) continue;
      for (const [path, value] of leaves(b.data)) {
        const source = enLeaves.get(path);
        if (source === undefined) continue;
        for (const token of BRAND_TOKENS) {
          if (countToken(value, token) !== countToken(source, token)) {
            fail(b.file, path, 'brand-token-parity', `${token} appears ${countToken(value, token)}× here, ${countToken(source, token)}× in English`);
          }
        }
      }
    }
  }

  // ── 3. Locale parity (i18n/messages only; staging is English-only) ────────
  //
  // One tier: all nine bundles carry every namespace at exact leaf parity. To
  // add a tenth locale, run the i18n-locale-sync skill.
  //
  // One scoped exception: GoApply serves zh and en only (brand registry
  // `locales`), so the namespaces that render on GoApply alone are required in
  // zh.json and nowhere else. A translation of them into ja/ko/es/… is text no
  // visitor can reach. They may still be present (orphan rule unchanged).
  const messages = bundles.filter((b) => b.kind === 'messages');
  const enBundle = messages.find((b) => b.locale === 'en');
  const enLeaves = leaves(enBundle?.data ?? {});
  for (const b of messages) {
    if (b === enBundle) continue;
    const keys = leaves(b.data);
    for (const path of enLeaves.keys()) {
      if (isGoApplyOnlyPath(path) && !GOAPPLY_LOCALES.includes(b.locale)) continue;
      if (!keys.has(path)) fail(b.file, path, 'missing-key', 'present in en.json, absent here');
    }
    // An orphan is always a bug: it is a string nobody can ever reach, and it is
    // how deleted vocabulary survives a purge.
    for (const path of keys.keys()) {
      if (!enLeaves.has(path)) fail(b.file, path, 'orphan-key', 'not present in en.json');
    }
  }

  // ── 4. Every t() call resolves in en.json ∪ staged English ────────────────
  const resolvable = new Map(enLeaves);
  for (const b of bundles) {
    if ((b.kind === 'staging' && b.locale === 'en') || (b.kind === 'extension' && b.locale === 'en')) {
      for (const [k, v] of leaves(b.data)) resolvable.set(k, v);
    }
  }
  const sources = ['app', 'components', 'hooks', 'lib', 'extension/src']
    .flatMap((d) => walkDirs(join(root, d)))
    .filter((f) => ['.tsx', '.ts'].includes(extname(f)));
  for (const abs of sources) {
    const src = readFileSync(abs, 'utf8');
    // The namespace a file binds, e.g. useTranslations('today').
    const ns = [...src.matchAll(/useTranslations\(\s*['"]([\w.-]+)['"]\s*\)/g)].map((m) => m[1]);
    if (ns.length !== 1) continue; // multi-namespace or dynamic files: skip, too noisy to be useful
    // Only literal keys — a template literal is a runtime decision we cannot check here.
    for (const m of src.matchAll(/\bt\(\s*['"]([\w.]+)['"]/g)) {
      const full = `${ns[0]}.${m[1]}`;
      if (!resolvable.has(full)) {
        const line = src.slice(0, m.index).split('\n').length;
        fail(abs, full, 'missing-string', `t('${m[1]}') at line ${line} does not resolve in en.json or i18n/staging`);
      }
    }
  }

  return { violations, bundles, englishStrings: enLeaves.size };
}

export function report(result, log = console) {
  const { violations } = result;
  if (violations.length === 0) {
    const kinds = result.bundles.reduce((acc, b) => ((acc[b.kind] = (acc[b.kind] ?? 0) + 1), acc), {});
    log.log(
      `✓ copy clean — ${kinds.messages ?? 0} locales, ${result.englishStrings} English strings; ` +
        `also scanned ${kinds.staging ?? 0} staging, ${kinds.email ?? 0} email, ${kinds.brands ?? 0} brand, ${kinds.extension ?? 0} extension bundles`,
    );
    return 0;
  }
  const byRule = violations.reduce((acc, v) => ((acc[v.rule] ??= []).push(v), acc), {});
  log.error(`\n✗ ${violations.length} copy violation(s)\n`);
  for (const [rule, list] of Object.entries(byRule).sort((a, b) => b[1].length - a[1].length)) {
    log.error(`  ${rule} (${list.length})`);
    for (const v of list.slice(0, 15)) log.error(`    ${v.file}  ${v.path}\n      ${v.detail}`);
    if (list.length > 15) log.error(`    … and ${list.length - 15} more`);
    log.error('');
  }
  log.error('See docs/roboapply/OVERHAUL_RULINGS.md §3 and docs/jobright-clone/PRODUCT_PLAN.md §5.25 for the vocabulary.\n');
  return 1;
}

function rootFromArgs(argv) {
  const i = argv.indexOf('--root');
  return i === -1 ? fileURLToPath(new URL('..', import.meta.url)) : argv[i + 1];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(report(runCopyCheck(rootFromArgs(process.argv.slice(2)))));
}
