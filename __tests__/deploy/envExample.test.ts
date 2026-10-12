// @vitest-environment node
//
// MKT-1G (market wave, phase M1) and MKT-5H (phase M5): the env examples
// describe every variable the market wave introduced or redefined
// (docs/jobright-clone/market/MARKET_STRATEGY.md 4.3, 5.1 "Safety first", 5.3,
// 7 "Purchases and keys", M-13, M-25; requirements ST-0, PC-1 and OT-1, the
// documentation half).
//
// Text checks on purpose. The two files are read as text: no network, no
// database, and no import of server code. The names below are copied from
// the env arrays of the bundles in docs/jobright-clone/orch/market-bundles.json,
// corrected by the section "Env variables added or redefined" of each merged
// handoff (docs/jobright-clone/orch/handoffs-mkt/) and by section 5 of
// docs/jobright-clone/market/MARKET_TASK_PLAN.md; they are not read from
// those files at run time.
//
// The M1 to M4 names were checked against the merged code. The M5 bundles ran
// in parallel with this one, so their code was not in this bundle's tree: the
// M5 names are the bundles file's, and each was then read in its bundle's own
// worktree on 2026-10-12 (not merged at that time). What that reading changed
// is marked "as built" below.
//
// __tests__/deploy/deployKit.test.ts keeps the older rules of the same files
// (each active name once, no off switch shipped, the mainland kit).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const ROOT_EXAMPLE = '.env.example';
const KIT_EXAMPLE = 'deploy/cn/cn.env.example';
const root = read(ROOT_EXAMPLE);
const kit = read(KIT_EXAMPLE);
const FILES: Array<[string, string]> = [
  [ROOT_EXAMPLE, root],
  [KIT_EXAMPLE, kit],
];

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A variable name as a whole word (STRIPE_PRICE_<PLANKEY> must not be satisfied by STRIPE_PRICE_<PLANKEY>_CENTS). */
const wholeName = (name: string) => new RegExp(`(?<![A-Za-z0-9_<>])${escapeRe(name)}(?![A-Za-z0-9_<>])`);
const mentions = (text: string, name: string) => wholeName(name).test(text);
/** `NAME=value` lines that are not commented out. */
const activeLines = (text: string) => [...text.matchAll(/^([A-Z][A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1]!, m[2]!.trim()] as const);
/** Every entry line, active (`NAME=`) or commented out (`# NAME=`), in file order. */
const entryList = (text: string) => [...text.matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!);
/** Names with an entry of their own. */
const entries = (text: string) => new Set(entryList(text));
/** How many entry lines a name has. */
const entryCount = (text: string, name: string) => entryList(text).filter((n) => n === name).length;
/** The lines under one `# ── title ──` heading, up to the next heading. */
const section = (text: string, title: RegExp): string => {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('# ──') && title.test(l));
  expect(start, String(title)).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && l.startsWith('# ──'));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
};
/** Assertions on a whole file report the label, not the file (a failed toMatch would print 1,500 lines). */
const expectHas = (text: string, re: RegExp, label = String(re)) => expect(re.test(text), `expected ${label}`).toBe(true);
const expectLacks = (text: string, re: RegExp, label = String(re)) => expect(re.test(text), `did not expect ${label}`).toBe(false);
/** Comment text with the line breaks and `#` markers folded away, so a sentence can be matched across lines. */
const prose = (text: string) => text.replace(/\n#\s*/g, ' ').replace(/\s+/g, ' ');
/** The comment block directly above an entry line such as `# NAME=`, as prose. */
const commentAbove = (text: string, entry: string): string => {
  const lines = text.split('\n');
  const at = lines.indexOf(entry);
  expect(at, entry).toBeGreaterThan(0);
  let start = at;
  // Walk up over comment lines that are not themselves entries (`# NAME=`) or headings.
  while (start > 0 && /^#/.test(lines[start - 1]!) && !/^#? ?[A-Z][A-Z0-9_]+=/.test(lines[start - 1]!) && !lines[start - 1]!.startsWith('# ──')) start -= 1;
  return prose(lines.slice(start, at).join('\n'));
};

/** Literal names of the M1 env arrays (MKT-1A, MKT-1C, MKT-1D, MKT-1F). */
const M1_LITERAL_NAMES = [
  // MKT-1A: Stripe safety (ST-0)
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'ROBOAPPLY_STRIPE_WEBHOOK_SECRET',
  'STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION',
  // MKT-1C: job sources (each brand reads its own name)
  'JOB_SOURCES_CONTACT',
  'CN_JOB_SOURCES_CONTACT',
  // MKT-1D: evaluation harness (EVAL_LIVE is a shell switch: named in prose, see SHELL_ONLY_NAMES)
  'EVAL_JUDGE_MODEL',
  // MKT-1F: estimate v2
  'MATCH_PRIORS',
  'CN_MATCH_PRIORS',
  'MATCH_CALIBRATION_MIN_PAIRS',
];

/** Literal names of the M2 bundles (MKT-2A, 2C, 2G, 2H; MKT-2B redefines the two webhook secret names of M1). */
const M2_LITERAL_NAMES = [
  // MKT-2A: Alipay, additive (AL-3, AL-4)
  'CN_ALIPAY_NOTIFY_ORIGIN',
  'ALIPAY_SECRETLESS_UNTIL',
  'CN_ALIPAY_PACKAGE_ID_MODE',
  // MKT-2C: tax switch (ST-8)
  'STRIPE_TAX_ENABLED',
  // MKT-2G: canonical skills (SM-6)
  'SKILL_EMBED_MATCH_MIN',
  // MKT-2H: embeddings (SM-7)
  'EMBED_MODEL',
  'EMBED_API_KEY',
  'EMBED_BASE_URL',
  'EMBED_BATCH_SIZE',
  'EMBED_DAILY_TOKENS',
  'CN_EMBED_MODEL',
  'CN_EMBED_API_KEY',
  'CN_EMBED_BASE_URL',
  'CN_EMBED_BATCH_SIZE',
  'CN_EMBED_DAILY_TOKENS',
];

/** Literal names of the M3 bundles and the M3 gate (MKT-3A, 3D, 3E; the gate added three). */
const M3_LITERAL_NAMES = [
  // MKT-3A: quota (JI-1); INGEST_QUOTA_RECHECK_HOURS is as built, not in the plan
  'INGEST_QUOTA_RESERVE_SHARE',
  'INGEST_QUOTA_RECHECK_HOURS',
  'INGEST_CURSOR_TICK_SHARE',
  'INGEST_ACTIVEJOBS_DAILY_CALLS',
  'INGEST_JSEARCH_DAILY_CALLS',
  // M3 cross-review
  'INGEST_SCHEDULED_DEMAND_SHARE',
  // MKT-3D: employer boards (JI-3, JI-4)
  'ATS_BOARDS_CONCURRENCY',
  'ATS_SR_DETAILS_PER_RUN',
  'ATS_DISCOVERY_VALIDATIONS_PER_RUN',
  'ATS_PUBLIC_SOURCES_DISABLED',
  // MKT-3E: Taiwan open data (JT-2); TW_OPEN_DATA_COUNTY_WALK_MIN is as built, not in the plan
  'TW_OPEN_DATA_JOBS_ENABLED',
  'TW_OPEN_DATA_JOBS_URL',
  'TW_OPEN_DATA_REQUESTS_PER_FETCH',
  'TW_OPEN_DATA_PAUSE_MS',
  'TW_OPEN_DATA_SWEEP_HOURS',
  'TW_OPEN_DATA_COUNTY_WALK_MIN',
  // M3 gate, on MKT-3H's request
  'STRIPE_TEST_CLOCK_ID',
];

/** Literal names of the M4 bundles (MKT-4D, 4F, 4G). */
const M4_LITERAL_NAMES = [
  'ENRICH_REQUIREMENTS_MAX',
  'FEED_HYBRID',
  'FEED_QUERY_EMBED_TIMEOUT_MS',
  'MATCH_SCORER_RUBRIC',
  'CN_MATCH_SCORER_RUBRIC',
  // Existing lines that gain "the one pinned scorer model per market" (MKT-4G).
  'LLM_MATCHING_MODEL',
  'CN_LLM_MATCHING_MODEL',
];

/** Literal names of the M5 env arrays (MKT-5A to MKT-5E), from the bundles file; INGEST_BANK_RESYNC_DAYS is as built by MKT-5E, not in its env array. */
const M5_LITERAL_NAMES = [
  // MKT-5A: licensed feed (JI-7), Active Jobs DB for the mainland (JC-6)
  'FANTASTIC_MONTHLY_JOBS',
  'FANTASTIC_FEED_DISABLED',
  // Added in MKT-5A's review round, after MKT-5H had read its handoff (M5 gate).
  'FANTASTIC_FEED_SLICE_CHECK_DISABLED',
  'FANTASTIC_TRANSPORT',
  'FANTASTIC_API_KEY',
  'FANTASTIC_API_KEY_HEADER',
  'FANTASTIC_FEED_PATH',
  'FANTASTIC_EXPIRED_PATH',
  'INGEST_FEED_DAILY_JOBS',
  'INGEST_FEED_CN_DAILY_JOBS',
  'INGEST_FEED_COUNTRIES',
  'INGEST_FEED_TAXONOMIES',
  'CN_ACTIVEJOBS_ENABLED',
  // MKT-5B: more connectors (JI-8), 北森 behind its flag (JC-8)
  'ATS_WORKABLE_DISABLED',
  'CN_ATS_BEISEN_ENABLED',
  'CN_ATS_BEISEN_MAX_POSTINGS_PER_RUN',
  'CN_ATS_TENANT_DENYLIST',
  // MKT-5C: liveness (JI-10)
  'LIVENESS_CHECK_DISABLED',
  'LIVENESS_RECHECK_HOURS',
  // MKT-5D: USAJobs (JI-9), 事求人 (JT-9)
  'USAJOBS_API_KEY',
  'USAJOBS_USER_AGENT_EMAIL',
  'USAJOBS_DISABLED',
  'TW_GOV_JOBS_ENABLED',
  'TW_GOV_JOBS_URL',
  'TW_GOV_JOBS_INCLUDE_TRANSFERS',
  // MKT-5E: GoHire syndication (JC-2)
  'GOHIRE_SYNDICATION_URL',
  'GOHIRE_SYNDICATION_KEY',
  'GOHIRE_BANK_TRANSPORT',
  'INGEST_BANK_RESYNC_DAYS',
];

const LATER_LITERAL_NAMES = [...M2_LITERAL_NAMES, ...M3_LITERAL_NAMES, ...M4_LITERAL_NAMES, ...M5_LITERAL_NAMES];
const ALL_LITERAL_NAMES = [...M1_LITERAL_NAMES, ...LATER_LITERAL_NAMES];

/**
 * Read from the shell only, never from an env file. EVAL_LIVE (MKT-1D) is
 * documented in prose with no `NAME=` entry. EVAL_SCORER_RECORD (MKT-4G)
 * belongs in neither file at all: the harness README documents it.
 */
const SHELL_ONLY_NAMES = ['EVAL_LIVE', 'EVAL_SCORER_RECORD'];

/** Names with a placeholder, in their documented pattern form (MKT-1A, PC-1). */
const M1_PATTERN_NAMES = [
  'PRICE_<PLANKEY>_USD_CENTS',
  'STRIPE_PRICE_<PLANKEY>_CENTS',
  'STRIPE_PRICE_<PLANKEY>',
  'PRICE_<PLANKEY>_TWD_CENTS',
  'STRIPE_PRICE_<PLANKEY>_TWD_CENTS',
  'STRIPE_PRICE_<PLANKEY>_TWD',
];

/** Pattern names of M3 (MKT-3A). */
const M3_PATTERN_NAMES = ['INGEST_<PROVIDER>_DAILY_CALLS', 'INGEST_<PROVIDER>_CN_DAILY_CALLS', 'RA_ONBOARDING_<PROVIDER>_DAILY_BUDGET'];

/** What a mainland deployment may set: every GoApply override of the wave, each optional (item 2 of MKT-5H; D5). */
const KIT_OVERRIDE_NAMES = [
  // Alipay (strategy 5.3)
  'CN_ALIPAY_NOTIFY_ORIGIN',
  'ALIPAY_SECRETLESS_UNTIL',
  'CN_ALIPAY_PACKAGE_ID_MODE',
  // Job sources
  'INGEST_ACTIVEJOBS_CN_DAILY_CALLS',
  'INGEST_FEED_CN_DAILY_JOBS',
  'CN_ACTIVEJOBS_ENABLED',
  'GOHIRE_SYNDICATION_URL',
  'GOHIRE_SYNDICATION_KEY',
  'INGEST_BANK_RESYNC_DAYS',
  'CN_ATS_BEISEN_ENABLED',
  'CN_ATS_BEISEN_MAX_POSTINGS_PER_RUN',
  'CN_ATS_TENANT_DENYLIST',
  'CN_JOB_SOURCES_CONTACT',
  // Matching and retrieval
  'CN_EMBED_MODEL',
  'CN_EMBED_API_KEY',
  'CN_EMBED_BASE_URL',
  'CN_EMBED_BATCH_SIZE',
  'CN_EMBED_DAILY_TOKENS',
  'CN_MATCH_SCORER_RUBRIC',
  'CN_LLM_MATCHING_MODEL',
  'CN_MATCH_PRIORS',
];

/** RoboApply catalog defaults in USD cents (MARKET_STRATEGY 4.1 and the 4.3 matrix). */
const USD_DEFAULT_CENTS: Record<string, number> = {
  PRO_WEEKLY: 999,
  PRO_MONTHLY: 2499,
  PRO_QUARTERLY: 5499,
  PRO_WEEK_PASS: 999,
  PRACTICE_PACK_5: 999,
  PRACTICE_PACK_15: 2499,
  STUDENT_MONTHLY: 1749,
  STUDENT_QUARTERLY: 3799,
};

/** A live or test secret, as opposed to the bare prefix or a placeholder such as sk_test_... */
const SECRET_SHAPES: Array<[string, RegExp]> = [
  ['Stripe live secret key', /sk_live_\w{4,}/],
  ['Stripe live restricted key', /rk_live_\w{4,}/],
  ['Stripe test secret key', /sk_test_\w{4,}/],
  ['Stripe test restricted key', /rk_test_\w{4,}/],
  ['Stripe webhook secret', /whsec_\w{4,}/],
  ['Stripe test clock id', /clock_\w{8,}/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9_-]{16,}/],
];

describe('env examples: the variables of market wave phases M1 to M5', () => {
  it('names every literal variable of the bundles in .env.example', () => {
    for (const name of ALL_LITERAL_NAMES) expect(mentions(root, name), name).toBe(true);
    expect(mentions(root, 'EVAL_LIVE')).toBe(true);
  });

  it('gives every literal variable exactly one entry of its own (NAME= or # NAME=), not only a mention in prose', () => {
    for (const name of ALL_LITERAL_NAMES) expect(entryCount(root, name), name).toBe(1);
    // The lists themselves hold each name once.
    expect(new Set(ALL_LITERAL_NAMES).size).toBe(ALL_LITERAL_NAMES.length);
  });

  it('gives a shell-only switch no entry, and keeps EVAL_SCORER_RECORD out of both files', () => {
    // A line in an env file would suggest the file is read for it.
    for (const name of SHELL_ONLY_NAMES) for (const [file, text] of FILES) expect(entries(text).has(name), `${file}: ${name}`).toBe(false);
    for (const [file, text] of FILES) expect(mentions(text, 'EVAL_SCORER_RECORD'), file).toBe(false);
    expectHas(prose(root), /The harness's other shell switches are documented in server\/src\/features\/match\/eval\/README\.md/);
  });

  it('documents every per-plan and per-provider variable in its pattern form', () => {
    for (const name of [...M1_PATTERN_NAMES, ...M3_PATTERN_NAMES]) expect(mentions(root, name), name).toBe(true);
  });

  it('holds no secret value: no line of either file has the shape of a live or test secret', () => {
    for (const [file, text] of FILES) {
      for (const line of text.split('\n')) {
        for (const [label, shape] of SECRET_SHAPES) expect(shape.test(line), `${file}: ${label} in "${line.slice(0, 40)}"`).toBe(false);
      }
    }
    // The shapes above do catch a key and do let the documented placeholders through.
    expect(SECRET_SHAPES.some(([, shape]) => shape.test('STRIPE_SECRET_KEY=sk_live_abcd'))).toBe(true);
    expect(SECRET_SHAPES.some(([, shape]) => shape.test('STRIPE_WEBHOOK_SECRET=whsec_abcd'))).toBe(true);
    expect(SECRET_SHAPES.some(([, shape]) => shape.test('EMBED_API_KEY=sk-proj-0123456789abcdef'))).toBe(true);
    for (const placeholder of ['sk_test_...', 'whsec_...', 'a live key (sk_live_ or rk_live_) is refused', 'With a test key (sk_test_ or']) {
      expect(SECRET_SHAPES.some(([, shape]) => shape.test(placeholder)), placeholder).toBe(false);
    }
  });

  it('ships every credential of the wave empty', () => {
    const credentials = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'ROBOAPPLY_STRIPE_WEBHOOK_SECRET', 'EMBED_API_KEY', 'CN_EMBED_API_KEY', 'FANTASTIC_API_KEY', 'USAJOBS_API_KEY', 'GOHIRE_SYNDICATION_KEY', 'STRIPE_TEST_CLOCK_ID'];
    for (const [file, text] of FILES) {
      for (const name of credentials) {
        // Active or commented out, the entry carries nothing after the `=`.
        const lines = text.split('\n').filter((l) => new RegExp(`^#? ?${name}=`).test(l));
        for (const line of lines) expect(line.replace(/^#? ?/, ''), `${file}: ${name}`).toBe(`${name}=`);
      }
    }
  });

  it('states a default in the comment, never as a live value: no variable of M2 to M5 is an active line with a value', () => {
    for (const [file, text] of FILES) {
      const active = new Map(activeLines(text));
      for (const name of LATER_LITERAL_NAMES) expect(active.get(name) ?? '', `${file}: ${name}`).toBe('');
    }
  });

  it('ships no kill switch of the wave switched on and no feature of it switched off', () => {
    // Commented or not, the example never shows the value that switches a source off.
    const OFF_VALUES: Array<[string, RegExp]> = [
      ['FANTASTIC_FEED_DISABLED', /true|1|on|yes/i],
      ['ATS_WORKABLE_DISABLED', /true|1|on|yes/i],
      ['USAJOBS_DISABLED', /true|1|on|yes/i],
      ['LIVENESS_CHECK_DISABLED', /true|1|on|yes/i],
      ['ATS_PUBLIC_SOURCES_DISABLED', /true|1|on|yes/i],
      ['TW_OPEN_DATA_JOBS_ENABLED', /false|0|off|no/i],
      ['TW_GOV_JOBS_ENABLED', /false|0|off|no/i],
      ['CN_ACTIVEJOBS_ENABLED', /false|0|off|no/i],
      ['FEED_HYBRID', /off/i],
      ['MATCH_SCORER_RUBRIC', /fit_v3/],
      ['CN_MATCH_SCORER_RUBRIC', /fit_v3/],
      ['GOHIRE_BANK_TRANSPORT', /off/i],
      ['EMBED_DAILY_TOKENS', /^0$/],
      ['STRIPE_TAX_ENABLED', /true|1|on|yes/i],
    ];
    for (const [file, text] of FILES) {
      for (const [name, off] of OFF_VALUES) {
        for (const m of text.matchAll(new RegExp(`^#? ?${name}=(.*)$`, 'gm'))) expect(off.test(m[1]!.trim()), `${file}: ${name}=${m[1]}`).toBe(false);
      }
    }
  });

  it('never ships CN_ATS_BEISEN_ENABLED as true: commented out and false in both files, with the counsel sentence', () => {
    for (const [file, text] of FILES) {
      expect(activeLines(text).map(([n]) => n), file).not.toContain('CN_ATS_BEISEN_ENABLED');
      expectHas(text, /^# CN_ATS_BEISEN_ENABLED=false$/m, `${file}: # CN_ATS_BEISEN_ENABLED=false`);
      // Wherever the name is followed by `=`, the value is false.
      for (const m of text.matchAll(/CN_ATS_BEISEN_ENABLED\s*=\s*(\S*)/g)) expect(m[1], `${file}: CN_ATS_BEISEN_ENABLED=${m[1]}`).toBe('false');
      const above = commentAbove(text, '# CN_ATS_BEISEN_ENABLED=false');
      expectHas(above, /needs counsel's sign-off under 反不正当竞争法 (\(2025\) )?Art\. 13\(3\) first/, `${file}: the counsel sentence`);
      expectHas(above, /no request to such a board can be built/, `${file}: off means no request`);
    }
  });

  it('never ships CN_PAYMENTS_ENABLED as an off switch (strategy 5.3 G2: on unless explicitly off)', () => {
    for (const [file, text] of FILES) {
      expectLacks(text, /^CN_PAYMENTS_ENABLED\s*=\s*(false|0|off|no)\b/im, `${file}: CN_PAYMENTS_ENABLED shipped as an off switch`);
    }
    // The kill-switch wording stays, and the old gate wording is gone.
    const text = prose(root);
    expectHas(text, /Kill switch: false \(or 0 \/ off \/ no\) stops GoApply charging/);
    expectLacks(text, /sellable only with CN_PAYMENTS_ENABLED=true/i);
    expectHas(root, /^# CN_PAYMENTS_ENABLED=true$/m);
  });

  it('carries no interim "until phase M…" sentence any more: every phase is merged', () => {
    for (const [file, text] of FILES) {
      const flat = prose(text);
      expectLacks(flat, /Until phase M\d/i, `${file}: until phase M`);
      expectLacks(flat, /from phase M3 of the market wave/i, `${file}: from phase M3`);
      expectLacks(flat, /before that the variable has no effect/i, `${file}: no effect yet`);
      expectLacks(flat, /set one secret, not a list/i, `${file}: one secret only`);
    }
  });
});

describe('.env.example: the Stripe safety rule (ST-0, M-25)', () => {
  const stripe = section(root, /Stripe \(RoboApply/);
  const text = prose(stripe);

  it('says the rail needs the key AND a webhook secret, and what happens with either missing', () => {
    expectHas(text, /only with the key AND a webhook secret/);
    expectHas(text, /With either missing RoboApply lists its plans and prices and cannot open a payment/);
    expect(mentions(stripe, 'STRIPE_WEBHOOK_SECRET')).toBe(true);
    expect(mentions(stripe, 'ROBOAPPLY_STRIPE_WEBHOOK_SECRET')).toBe(true);
  });

  it('says the webhook secret is read as a comma-separated list for a rotation', () => {
    expectHas(text, /comma-separated list/);
    expectHas(text, /rotation/);
  });

  // Since MKT-2B (phase M2) the webhook route tries every configured secret,
  // each trimmed (stripeEnv.ts `STRIPE_WEBHOOK_TRIES_EVERY_SECRET` is true), so
  // a list opens the rail. The interim M1 sentences that said the opposite are
  // gone (requests/waveM1-carryover.md, MKT-5H.1).
  it('says a list is accepted: every secret is tried and trimmed, and only whitespace inside a secret keeps payments closed', () => {
    const list = commentAbove(stripe, 'STRIPE_WEBHOOK_SECRET=');
    expectHas(list, /The webhook tries every secret of the list in order and the first one that verifies wins/);
    expectHas(list, /Each secret is trimmed, so a space or a trailing newline around it \(what `echo \.\.\. \| vercel env add` stores\) does no harm/);
    expectHas(list, /A secret with a space or a line break INSIDE it never verifies/);
    expectHas(list, /Stripe payments stay closed \(plans and prices are listed, no payment can be opened, and one warning line in the log names the cause\)/);
    expectHas(list, /subscribed to the fourteen event types/);
    expectLacks(text, /lets checkout open/);
    const second = commentAbove(stripe, '# ROBOAPPLY_STRIPE_WEBHOOK_SECRET=');
    expectHas(second, /Read first, before the name above/);
    expectHas(second, /the secrets of both names are tried/);
    expectHas(second, /A blank value here in front of a real STRIPE_WEBHOOK_SECRET is harmless/);
    expectLacks(second, /only ROBOAPPLY_STRIPE_WEBHOOK_SECRET is used to verify/);
  });

  it('says a live key is refused outside production and names the test key and the stripe listen secret', () => {
    expectHas(text, /live key \(sk_live_ or rk_live_\) is refused whenever VERCEL_ENV is not production/);
    expectHas(text, /sk_test_\.\.\./);
    expectHas(text, /stripe listen/);
    expectHas(text, /whsec_\.\.\./);
  });

  it('says which keys are test keys: only sk_test_ and rk_test_, every other key is treated as a live key', () => {
    expectHas(text, /Only a key that starts with sk_test_ or rk_test_ counts as a test key; every other key, a format the code does not know included, is treated as a live key/);
  });

  it('shows the override as a commented line with its warning, never as an active line', () => {
    expectHas(stripe, /^# STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION=true$/m);
    expect(activeLines(root).map(([n]) => n)).not.toContain('STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION');
    const warning = commentAbove(stripe, '# STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION=true');
    expectHas(warning, /Warning: true lets a development machine act on the live Stripe account/);
    expectHas(warning, /default unset = a live key is refused outside production/);
    // VERCEL_ENV is the one production signal, so a production elsewhere needs the override.
    expectHas(warning, /VERCEL_ENV=production is the only production signal the code reads/);
    expectHas(warning, /a RoboApply production that does not run on Vercel must set this/);
  });

  it('says products, prices and the billing portal configuration are created by code, and names no portal variable', () => {
    expectHas(text, /Stripe products and prices are created by code on first use/);
    expectHas(text, /and so is the billing portal configuration/);
    // Nothing reads a portal URL (handoff MKT-2B): the name stays out of the catalogue.
    expect(root.includes('STRIPE_BILLING_PORTAL_URL')).toBe(false);
  });

  it('STRIPE_TAX_ENABLED (ST-8): off unless set, what it adds, and what must exist in the Dashboard first', () => {
    const note = commentAbove(stripe, '# STRIPE_TAX_ENABLED=');
    expectHas(note, /Default unset = off: no tax field is sent and the billing address stays optional/);
    expectHas(note, /true \(also 1, yes, on\) adds automatic tax, tax id collection and a required billing address to every Checkout Session/);
    expectHas(note, /only after Stripe Tax is activated and the registrations are added in the Dashboard/);
    expectHas(note, /RoboApply only/);
    // GoApply never reaches Stripe: the mainland kit lists no Stripe name (asserted below).
  });

  it('names the readers of the legacy price ids by their real paths (they are server files, not files of the web lib/)', () => {
    const note = commentAbove(stripe, 'STRIPE_ROBOAPPLY_STARTER_PRICE_ID=');
    expectHas(note, /server\/src\/lib\/rateCard\.ts and server\/src\/lib\/mockInterviewPlans\.ts still read them/);
    for (const file of ['server/src/lib/rateCard.ts', 'server/src/lib/mockInterviewPlans.ts']) expect(existsSync(join(ROOT, file)), file).toBe(true);
    // Neither file exists under the repository's lib/ (the frontend library), so the short form is never written.
    for (const short of ['lib/rateCard.ts', 'lib/mockInterviewPlans.ts']) {
      expect(existsSync(join(ROOT, short)), short).toBe(false);
      expectLacks(root, new RegExp(`(?<!server/src/)${escapeRe(short)}`), `${short} without server/src/`);
    }
  });

  it('STRIPE_TEST_CLOCK_ID (M3 gate): test keys only, a new customer only', () => {
    const note = commentAbove(stripe, '# STRIPE_TEST_CLOCK_ID=');
    expectHas(note, /With a test key \(sk_test_ or rk_test_\) a NEW customer is created under that clock/);
    expectHas(note, /Ignored with a live key and for a customer that already exists/);
  });
});

describe('.env.example: plan prices are catalog defaults, env values are overrides (PC-1, M-13)', () => {
  const plans = section(root, /Credits and plans/);
  const text = prose(plans);

  it('no longer says a plan is sellable only when a price variable is set', () => {
    expectLacks(prose(root), /sellable (only )?when its (rail|Stripe) price is set/i);
    expectHas(text, /Every plan has a default amount in code/);
    expectHas(text, /env values (below )?are overrides/);
  });

  it('states the RoboApply defaults in USD cents, one per plan key, as the strategy lists them', () => {
    for (const [key, cents] of Object.entries(USD_DEFAULT_CENTS)) {
      // In the sentence of defaults: "PRO_MONTHLY 2499".
      expect(new RegExp(`(?<![A-Z0-9_])${key} ${cents}(?![0-9])`).test(text), `${key} ${cents}`).toBe(true);
      // And as the commented example of the override, the default next to the switch.
      expectHas(plans, new RegExp(`^# PRICE_${key}_USD_CENTS=${cents}$`, 'm'), `# PRICE_${key}_USD_CENTS=${cents}`);
    }
  });

  it('says what each override does: alias, pin, Taiwan price', () => {
    expectHas(text, /STRIPE_PRICE_<PLANKEY>_CENTS[^.]*alias/);
    expectHas(text, /STRIPE_PRICE_<PLANKEY> [^.]*pin/);
    expectHas(text, /pin alone is ignored and logged/);
    expectHas(text, /when both amount variables are set and differ, the pin is ignored and logged too/);
    expectHas(text, /PRICE_<PLANKEY>_USD_CENTS overrides a default: a positive integer, in cents\. Any other value is ignored and logged once, and the default stays/);
    expectHas(text, /catalog sync on first use/);
    expectHas(text, /PRICE_<PLANKEY>_TWD_CENTS[^.]*multiple of 100/);
    expectHas(text, /[Uu]nset[^.]*Taiwan pays USD with the reference line/);
  });

  it('keeps the STRIPE_PRICE_* lines as commented examples: no price variable is active', () => {
    const active = activeLines(root).map(([n]) => n);
    expect(active.filter((n) => /^(STRIPE_)?PRICE_/.test(n))).toEqual([]);
    for (const key of Object.keys(USD_DEFAULT_CENTS)) {
      expectHas(plans, new RegExp(`^# STRIPE_PRICE_${key}=`, 'm'));
      expectHas(plans, new RegExp(`^# STRIPE_PRICE_${key}_CENTS=`, 'm'));
    }
  });

  it('leaves the GoApply price overrides as the parity wave wrote them', () => {
    const active = activeLines(root).map(([n]) => n);
    for (const key of ['PRO_WEEK_PASS', 'PRO_MONTHLY', 'PRO_QUARTERLY', 'PRACTICE_PACK_5', 'PRACTICE_PACK_15', 'STUDENT_MONTHLY', 'STUDENT_QUARTERLY']) {
      expect(active, key).toContain(`CN_PRICE_${key}_FEN`);
    }
    // GoApply has no auto-renewing weekly plan (rule A9, M-24).
    expectLacks(root, /^#? ?CN_PRICE_PRO_WEEKLY_FEN=/m);
  });
});

describe('.env.example: the other M1 variables, each with its meaning and default', () => {
  it('JOB_SOURCES_CONTACT: the contact in the User-Agent, default the brand site URL', () => {
    const note = commentAbove(root, '# JOB_SOURCES_CONTACT=');
    expectHas(note, /User-Agent of every request to a public job board or an open-data endpoint/);
    expectHas(note, /a URL or a mailto: address/);
    expectHas(note, /Unset = the brand's site URL/);
    // The adapters send it since M3 (the board sync of MKT-3D, the Taiwan sweep of MKT-3E).
    expectHas(note, /Sent by the board sync, the Taiwan open-data adapters and every other adapter that reads a public endpoint/);
    // The contact is identity and never crosses brands (MKT-1C review; sources/userAgent.ts reads brandOwnEnv).
    expectHas(note, /RoboApply reads JOB_SOURCES_CONTACT only and GoApply reads CN_JOB_SOURCES_CONTACT only/);
    expectHas(commentAbove(root, '# CN_JOB_SOURCES_CONTACT='), /GoApply's own contact \(never the value above\); unset = https:\/\/www\.goapply\.top/);
  });

  it('EVAL_LIVE and EVAL_JUDGE_MODEL: off unless set, a shell switch, and the judge differs from the scorer', () => {
    // EVAL_LIVE has no entry (it is not read from an env file); its note sits above the judge model's entry.
    const note = commentAbove(root, '# EVAL_JUDGE_MODEL=');
    expectHas(note, /EVAL_LIVE is a shell switch, not an entry of this file/);
    expectHas(note, /EVAL_LIVE=1 allows `npm run eval:match -- --live` to read the database \(read-only\) and to call models/);
    expectHas(note, /any other value, or unset, refuses/);
    expectHas(note, /It is not read from this file/);
    expectHas(note, /must differ from the resolved LLM_MATCHING_MODEL of the market being judged/);
    expectHas(note, /unset = --live refuses to judge/);
  });

  it('MATCH_PRIORS, CN_MATCH_PRIORS and MATCH_CALIBRATION_MIN_PAIRS: defaults 44 / 39 / 24 / 50 / 45 and 500', () => {
    const priors = commentAbove(root, '# MATCH_PRIORS=');
    expectHas(priors, /title_level \/ skills \/ industry \/ logistics \/ career_path; defaults 44 \/ 39 \/ 24 \/ 50 \/ 45/);
    expectHas(priors, /malformed value keeps the defaults/);
    // A data-derived prior replaces the setting for four components; logistics always follows it (MKT-1F).
    expectHas(priors, /Once a market has 200 model-scored values of a component, that component's prior is the market's own mean/);
    expectHas(priors, /the logistics prior is never taken from data and always follows this setting/);
    // The GoApply name is an optional override that falls back to the shared value (D5).
    expectHas(commentAbove(root, '# CN_MATCH_PRIORS='), /OPTIONAL override; unset = MATCH_PRIORS, then the defaults/);
    // The default is written next to the switch, as the commented-out value.
    expectHas(commentAbove(root, '# MATCH_CALIBRATION_MIN_PAIRS=500'), /default 500/);
  });
});

describe('.env.example: Alipay, additive (M2; AL-3, AL-4; strategy 5.3 G4, G8, G10)', () => {
  it('no longer compares the callback secret with the Stripe key alone', () => {
    const alipay = prose(section(root, /Alipay \(RMB market/));
    expectLacks(alipay, /as STRIPE_SECRET_KEY is Stripe's/);
    expectHas(alipay, /The rail's own credential \(Stripe's are its key and a webhook secret; this rail needs this one value\)/);
  });

  it('ALIPAY_SECRETLESS_UNTIL: never unless set, a full ISO instant with a zone, production orders only, closed after 7 days', () => {
    const note = commentAbove(root, '# ALIPAY_SECRETLESS_UNTIL=');
    expectHas(note, /Default unset = never/);
    expectHas(note, /a full ISO instant WITH a zone/);
    expectHas(note, /only for an Alipay order production created before that instant/);
    expectHas(note, /an order this code created always needs the secret/);
    expectHas(note, /only until 7 days after it/);
    expectHas(note, /A callback with a wrong `cb` is always refused/);
  });

  it('CN_ALIPAY_NOTIFY_ORIGIN: an optional override with its fallback chain, never another brand by default', () => {
    const note = commentAbove(root, '# CN_ALIPAY_NOTIFY_ORIGIN=');
    expectHas(note, /OPTIONAL override/);
    expectHas(note, /a bare https origin \(scheme, host, optional port; no path or query\)/);
    expectHas(note, /Unset = CN_BACKEND_URL, then https:\/\/www\.goapply\.top/);
    expectHas(note, /Never another brand's host by default: name another host only when that host runs this code on the same database/);
    expectHas(note, /is ignored and startup logs a warning/);
  });

  it('CN_ALIPAY_PACKAGE_ID_MODE: the plan key unless legacy', () => {
    const note = commentAbove(root, '# CN_ALIPAY_PACKAGE_ID_MODE=');
    expectHas(note, /Unset = the plan key/);
    expectHas(note, /legacy = `starter`, with the plan key kept in package_name/);
  });
});

describe('.env.example: metered providers and quota (M3; JI-1, JC-6)', () => {
  const quota = section(root, /Job sources: metered providers and quota/);
  const text = prose(quota);

  it('INGEST_<PROVIDER>_DAILY_CALLS: an upper bound that is also capped by remaining quota', () => {
    expectHas(text, /INGEST_<PROVIDER>_DAILY_CALLS \(PROVIDER = ACTIVEJOBS, JSEARCH\) is the operator's upper bound of daily calls/);
    expectHas(text, /also capped by remaining quota/);
    expectHas(text, /With a quota reading and no bound set the limit is that cap/);
    expectHas(text, /Unset and with no quota reading yet: activejobs 300, jsearch 200/);
    expectHas(text, /0 refuses every call, a person's own search included/);
    expectHas(quota, /^INGEST_ACTIVEJOBS_DAILY_CALLS=$/m);
    expectHas(quota, /^INGEST_JSEARCH_DAILY_CALLS=$/m);
  });

  it('INGEST_<PROVIDER>_CN_DAILY_CALLS: default 0, Active Jobs DB only, JSearch never', () => {
    const note = commentAbove(quota, '# INGEST_ACTIVEJOBS_CN_DAILY_CALLS=');
    expectHas(note, /counted apart under <provider>:cn/);
    expectHas(note, /Default 0/);
    expectHas(note, /Only Active Jobs DB can be called for a mainland request at all \(JSearch never is\)/);
    // As built by MKT-5A: the 20 calls of an open gate are ingest's; a person's own search needs the operator's bound.
    expectHas(note, /while that gate is open its default is 20/);
    expectHas(note, /Those 20 are ingest calls, which carry a role's own label and nothing a person typed/);
    expectHas(note, /A GoApply person's own search reaches the provider only when this is set above 0/);
    // No JSearch budget for GoApply exists anywhere (strategy M-6).
    for (const [file, fileText] of FILES) expect([...entries(fileText)].filter((n) => /JSEARCH.*_CN_|_CN_.*JSEARCH/.test(n)), file).toEqual([]);
  });

  it('the shares and the recheck, each with its default', () => {
    expectHas(commentAbove(quota, '# INGEST_QUOTA_RESERVE_SHARE=0.05'), /Default 0\.05/);
    expectHas(commentAbove(quota, '# INGEST_QUOTA_RECHECK_HOURS=0'), /Default 0 = never before the reset/);
    const tick = commentAbove(quota, '# INGEST_CURSOR_TICK_SHARE=0.4');
    expectHas(tick, /Clamped to 0\.05-1/);
    expectHas(tick, /Default 0\.4/);
    expectHas(commentAbove(quota, 'INGEST_SCHEDULED_DEMAND_SHARE='), /default 0\.8/);
  });

  it('marks RA_ONBOARDING_<PROVIDER>_DAILY_BUDGET as a deprecated alias and drops the LinkedIn names', () => {
    const boards = prose(section(root, /External job boards/));
    expectHas(boards, /RA_ONBOARDING_<PROVIDER>_DAILY_BUDGET \(JSEARCH, ACTIVEJOBS\) is a deprecated alias of INGEST_<PROVIDER>_DAILY_CALLS/);
    expectHas(boards, /read only while that name is unset, and logged once/);
    expectHas(boards, /It is no longer a counter per process/);
    expectLacks(boards, /per-process daily billed-call budget/);
    // The alias is shown commented out, never as an active line someone would fill.
    const active = activeLines(root).map(([n]) => n);
    for (const name of ['RA_ONBOARDING_JSEARCH_DAILY_BUDGET', 'RA_ONBOARDING_ACTIVEJOBS_DAILY_BUDGET']) {
      expect(active, name).not.toContain(name);
      expect(entries(root).has(name), name).toBe(true);
    }
    // Nothing reads these: they are named once, in the "no longer read" note, and have no entry.
    for (const gone of ['RA_ONBOARDING_LINKEDIN_JOBS_DAILY_BUDGET', 'RA_ONBOARDING_LINKEDIN_JOBS_DISABLED', 'INGEST_LINKEDIN_DAILY_CALLS']) {
      expect(entries(root).has(gone), gone).toBe(false);
      expect(mentions(root, gone), gone).toBe(true);
    }
    expectHas(boards, /The LinkedIn Job Search API is not a source and is never called/);
  });

  // Redefined by MKT-5A: the provider's kill switches also stop the licensed feed, and a direct key takes Active Jobs DB off the RapidAPI key.
  it('says what the older Active Jobs DB names mean now that the licensed feed exists', () => {
    const boards = section(root, /External job boards/);
    expectHas(commentAbove(boards, 'RAPID_API_KEY='), /Active Jobs DB does not use this key when FANTASTIC_TRANSPORT=direct/);
    expectHas(commentAbove(boards, 'RA_ONBOARDING_EXTERNAL_JOBS_DISABLED='), /the licensed feed included/);
    expectHas(commentAbove(boards, 'RA_ONBOARDING_JSEARCH_DISABLED='), /RA_ONBOARDING_ACTIVEJOBS_DISABLED also stops the licensed feed/);
    expectHas(commentAbove(boards, '# RA_ONBOARDING_FANTASTIC_WINDOW='), /It also decides the window stored on a planned Active Jobs DB search query/);
  });
});

describe('.env.example: public employer boards (M3 and M5; JI-3, JI-4, JI-8, JC-8, JI-10)', () => {
  const boards = section(root, /Job sources: public employer boards/);
  const text = prose(boards);

  it('the kill switch stops reads and takes nothing down', () => {
    const note = commentAbove(boards, 'ATS_PUBLIC_SOURCES_DISABLED=');
    expectHas(note, /Kill switch: true stops every read of a public job board/);
    expectHas(note, /It takes nothing down/);
  });

  it('the three sync knobs with their ranges and defaults', () => {
    expectHas(commentAbove(boards, '# ATS_BOARDS_CONCURRENCY=6'), /clamped to 4-8\. Default 6/);
    expectHas(commentAbove(boards, '# ATS_SR_DETAILS_PER_RUN=100'), /1-1000 .*Default 100/);
    expectHas(commentAbove(boards, '# ATS_DISCOVERY_VALIDATIONS_PER_RUN=20'), /0-200; 0 = none\. Default 20/);
  });

  it('ATS_WORKABLE_DISABLED: the connector is on unless switched off', () => {
    const workable = commentAbove(boards, '# ATS_WORKABLE_DISABLED=');
    expectHas(workable, /true turns the Workable connector off .*Default unset = the connector is on/);
    // As built by MKT-5B: a switched-off system is passed over without a request, and none of its boards can be added.
    expectHas(workable, /A Workable board is then passed over \(no request; its stored postings are left as they are\) and none can be added/);
  });

  it('the 北森 cap and the tenant denylist', () => {
    expectHas(commentAbove(boards, '# CN_ATS_BEISEN_MAX_POSTINGS_PER_RUN=200'), /per 北森 tenant and run, 1-2000; .*Default 200/);
    const denylist = commentAbove(boards, '# CN_ATS_TENANT_DENYLIST=');
    expectHas(denylist, /never read, comma list \(the takedown path/);
    expectHas(denylist, /Honoured whether the 北森 flag is on or off/);
  });

  it('the liveness check: one read of a public posting, off switch and recheck window', () => {
    const off = commentAbove(boards, '# LIVENESS_CHECK_DISABLED=');
    expectHas(off, /nothing is ever submitted/);
    expectHas(off, /true turns the check off\. Default false/);
    expectHas(off, /Greenhouse, Lever, SmartRecruiters; Lever's EU instance is not asked/);
    const recheck = commentAbove(boards, '# LIVENESS_RECHECK_HOURS=6');
    expectHas(recheck, /0 to 720 \(0 = no such window\); anything else means the default/);
    expectHas(recheck, /Default 6/);
  });

  it('says the boards are not read at all when no brand of the deployment writes them', () => {
    const inventory = prose(section(root, /Job inventory, enrichment and scoring/));
    expectHas(inventory, /When no brand of the deployment writes board postings .* the employer boards are not read at all: no request is made/);
    expectHas(inventory, /JSearch is not a GoApply source and is never called for GoApply/);
    expectHas(inventory, /No mainland board is ever scraped/);
    expectHas(text, /read by their own cron \(\/api\/v1\/cron\/jobs-boards, every 5 minutes\)/);
  });
});

describe('.env.example: Taiwan open data (M3 and M5; JT-2, JT-9)', () => {
  const tw = section(root, /Job sources: Taiwan open data/);

  it('台灣就業通 is on unless switched off, with the endpoint rule and the sweep pacing', () => {
    const on = commentAbove(tw, 'TW_OPEN_DATA_JOBS_ENABLED=');
    expectHas(on, /ON unless set to false \/ 0 \/ off \/ no \(unset, empty or any other value is on\)/);
    expectHas(on, /shown with the dataset's credit line/);
    const url = commentAbove(tw, 'TW_OPEN_DATA_JOBS_URL=');
    expectHas(url, /https:\/\/free\.taiwanjobs\.gov\.tw\/webservice_taipei\/Webservice\.ashx/);
    expectHas(url, /must be https on taiwanjobs\.gov\.tw or a subdomain, without credentials; anything else turns the adapter off/);
    const pacing = commentAbove(tw, '# TW_OPEN_DATA_REQUESTS_PER_FETCH=5');
    expectHas(pacing, /1-50 \(default 5\)/);
    expectHas(pacing, /0-60000 \(default 1500\)/);
    expectHas(pacing, /1-336 \(default 24\)/);
    for (const line of ['# TW_OPEN_DATA_PAUSE_MS=1500', '# TW_OPEN_DATA_SWEEP_HOURS=24']) expect(tw.split('\n'), line).toContain(line);
    expectHas(commentAbove(tw, '# TW_OPEN_DATA_COUNTY_WALK_MIN=50'), /0 = never, 0-1000\. Default 50/);
  });

  it('事求人: on unless false, never a contact field, transfers off by default', () => {
    const on = commentAbove(tw, '# TW_GOV_JOBS_ENABLED=');
    expectHas(on, /on unless set to false/);
    expectHas(on, /contact fields of the file are never read or stored/);
    const url = commentAbove(tw, '# TW_GOV_JOBS_URL=');
    expectHas(url, /Unset = the documented endpoint \(https:\/\/web3\.dgpa\.gov\.tw\/WANT03FRONT\/AP\/WANTF00003\.aspx\?GETJOB=Y\)/);
    // As built by MKT-5D: the same kind of rule as TW_OPEN_DATA_JOBS_URL, so a mirror is not a silent off.
    expectHas(url, /An override must be https on dgpa\.gov\.tw or a subdomain, without credentials; anything else turns the adapter off \(reason url_invalid\)/);
    const transfers = commentAbove(tw, '# TW_GOV_JOBS_INCLUDE_TRANSFERS=');
    expectHas(transfers, /outside the three kinds confirmed as open to the public \(約僱人員, 聘用人員, 其他人員\)/);
    expectHas(transfers, /the transfer posts for serving civil servants \(一般人員\) and the kinds nothing confirms as open, each tagged with its kind/);
    expectHas(transfers, /Default false: they are skipped and counted/);
  });
});

describe('.env.example: the licensed feed and USAJobs (M5; JI-7, JC-6, JI-9)', () => {
  const feed = section(root, /Job sources: licensed feed/);
  const text = prose(feed);

  it('says the feed turns itself on only on a plan of at least 20,000 jobs a month', () => {
    expectHas(text, /turns itself on only when the plan's monthly job quota is at least 20,000/);
    expectHas(text, /On the free plan nothing is requested/);
  });

  // As built by MKT-5A (raFantasticJobs.ts): the vendor's header is confirmed and is the default, and each
  // transport has its own default routes. The bundles file's "no default, never guessed" was the plan.
  it('transport, key and header: rapidapi by default; the direct key goes out as Authorization: Bearer unless overridden', () => {
    const transport = commentAbove(feed, '# FANTASTIC_TRANSPORT=rapidapi');
    expectHas(transport, /rapidapi \(default: the RapidAPI listing, with RAPID_API_KEY\) \| direct/);
    // One transport for the whole client, so one plan is spent and one quota reading describes it (handoff MKT-5A, point 6).
    expectHas(transport, /The transport of the whole Active Jobs DB client, the search and the feed/);
    expectHas(commentAbove(feed, '# FANTASTIC_FEED_DISABLED='), /true stops the feed sync in both markets, and with it the mainland search, which stands behind the same gate\. Default false/);
    const header = commentAbove(feed, '# FANTASTIC_API_KEY_HEADER=');
    expectHas(header, /Override of the header the direct key is sent in/);
    expectHas(header, /Unset = Authorization, sent as Bearer <key>; any other header name carries the bare key/);
    expectHas(header, /A value that is not a header name is ignored/);
    expectLacks(text, /a header name is never guessed/);
    expectLacks(text, /reports that it has no key/);
    const routes = commentAbove(feed, '# FANTASTIC_FEED_PATH=');
    expectHas(routes, /Defaults \/active-ats and \/expired-ats on the RapidAPI transport, \/v1\/active-ats and \/v1\/expired-ats on the direct transport/);
    expectHas(routes, /A value that is not a plain path is ignored/);
    expect(feed.split('\n')).toContain('# FANTASTIC_EXPIRED_PATH=');
  });

  it('budgets, countries and the GoApply switch, each with its default', () => {
    expectHas(commentAbove(feed, '# FANTASTIC_MONTHLY_JOBS='), /When the responses state it too, the larger number counts\. Default unset/);
    // M5 gate (MKT-5A Request 8, review finding 5): the two sentences an operator needs before and after buying a plan.
    expectHas(commentAbove(feed, '# FANTASTIC_MONTHLY_JOBS='), /Required on a deployment that serves only GoApply/);
    expectHas(commentAbove(feed, '# FANTASTIC_FEED_SLICE_CHECK_DISABLED='), /mostly indexed outside the time slice it asked for[\s\S]*Default false/);
    expectHas(commentAbove(root, '# INGEST_QUOTA_RECHECK_HOURS=0'), /after buying or changing a plan in the middle of its period/);
    const day = commentAbove(feed, '# INGEST_FEED_DAILY_JOBS=');
    expectHas(day, /the feed and the search of both markets together/);
    expectHas(day, /Default: the monthly jobs \/ 31/);
    expectHas(commentAbove(feed, '# INGEST_FEED_CN_DAILY_JOBS='), /Default: 20% of the daily feed budget/);
    const countries = commentAbove(feed, '# INGEST_FEED_COUNTRIES=');
    expectHas(countries, /Default US,CA,GB,IE,DE,FR,NL,ES,IT,SE,AU,SG,TW/);
    expectHas(countries, /CN is ignored here: the mainland sync is its own/);
    expectHas(commentAbove(feed, '# INGEST_FEED_TAXONOMIES='), /Default unset = no filter/);
    const cn = commentAbove(feed, '# CN_ACTIVEJOBS_ENABLED=');
    expectHas(cn, /false keeps Active Jobs DB off for GoApply even with a paid plan/);
    expectHas(cn, /Default on once the gate above is open/);
  });

  it('USAJobs: disabled until the key and the contact e-mail are both set', () => {
    const usajobs = commentAbove(feed, '# USAJOBS_API_KEY=');
    expectHas(usajobs, /stays disabled until both are set/);
    // As built by MKT-5D (`usaJobsCredentials`): a value that is not an e-mail address is no key.
    expectHas(usajobs, /The second value must be an e-mail address: anything else counts as not set/);
    expect(feed.split('\n')).toContain('# USAJOBS_USER_AGENT_EMAIL=');
    expectHas(commentAbove(feed, '# USAJOBS_DISABLED='), /Default false/);
  });
});

describe('.env.example: the GoHire bank over the syndication endpoint (M5; JC-2)', () => {
  it('a syndication URL implies its own transport, and its key falls back to GOHIRE_API_KEY', () => {
    const transport = commentAbove(root, '# GOHIRE_BANK_TRANSPORT=');
    expectHas(transport, /db \| api \| off/);
    expectHas(transport, /A syndication URL \(next entry\) implies its own transport/);
    expectHas(transport, /off still switches the bank off/);
    // As built by MKT-5E (`bankTransport`): the URL wins over both other transports.
    expectHas(transport, /db and api are then ignored, with one warning/);
    const url = commentAbove(root, '# GOHIRE_SYNDICATION_URL=');
    expectHas(url, /Must be https/);
    expectHas(url, /Unset \(the default\) = the transports above/);
    expectHas(url, /it is the bank's transport and wins over the list endpoint and the database/);
    const key = commentAbove(root, '# GOHIRE_SYNDICATION_KEY=');
    expectHas(key, /Unset = GOHIRE_API_KEY/);
    expectHas(key, /With neither set the bank is off while the URL is set/);
    expectHas(commentAbove(root, 'INGEST_LEASE_BATCH='), /on the GoHire syndication endpoint a page never holds more than 200/);
  });

  // As built by MKT-5E (adapters/bank.ts `bankResyncDays`); not in the bundles file.
  it('INGEST_BANK_RESYNC_DAYS: the GoHire cursor sync is read again from the beginning, 1 to 30 days, default 7; never RoboHire (MKT-5E review)', () => {
    const note = commentAbove(root, '# INGEST_BANK_RESYNC_DAYS=7');
    expectHas(note, /the GoHire bank, when it is read by cursor \(the syndication endpoint or its database\), is read again from the beginning/);
    expectHas(note, /a whole number from 1 to 30; anything else means the default\. Default 7/);
    expectHas(note, /RoboHire's sync is never re-read for its age/);
  });
});

describe('.env.example: skills, embeddings and retrieval (M2 and M4; SM-6, SM-7)', () => {
  const retrieval = section(root, /Skills, embeddings and retrieval/);
  const text = prose(retrieval);

  it('the shared embedding settings with their defaults', () => {
    expectHas(text, /Vectors never cross markets/);
    expectHas(commentAbove(retrieval, '# EMBED_MODEL='), /requested at 1024 dimensions .* Default openai\/text-embedding-3-small/);
    expectHas(commentAbove(retrieval, '# EMBED_BASE_URL='), /Unset = OPENAI_BASE_URL, then https:\/\/api\.openai\.com\/v1/);
    expectHas(commentAbove(retrieval, '# EMBED_API_KEY='), /Unset = OPENAI_API_KEY, but only while EMBED_BASE_URL is unset: a key is never sent to an endpoint it was not configured for/);
    expectHas(commentAbove(retrieval, '# EMBED_BATCH_SIZE=96'), /at most 96\..* Default 96/);
    expectHas(commentAbove(retrieval, '# EMBED_DAILY_TOKENS=20000000'), /0 switches embedding off\. Default 20000000/);
  });

  it('the GoApply overrides fall back to the shared stack; the mainland model is a recommendation, not a default; the pair rule', () => {
    const model = commentAbove(retrieval, '# CN_EMBED_MODEL=');
    expectHas(model, /OPTIONAL overrides; unset = shared stack/);
    expectHas(model, /as a recommendation and not a default: Alibaba text-embedding-v4 in the Beijing region/);
    // The batch limit is one reading of the vendor's page (handoff MKT-2H): it is given with its date, not as a bare fact.
    expectHas(model, /CN_EMBED_BATCH_SIZE=10 \(that model's limit of inputs per request, as its vendor's page stated it on 2026-10-11\)/);
    // The recommendation is words: the entry itself names no model.
    expect(retrieval.split('\n')).toContain('# CN_EMBED_MODEL=');
    const pair = commentAbove(retrieval, '# CN_EMBED_BASE_URL=');
    expectHas(pair, /ONE PAIR: set both or neither/);
    expectHas(pair, /With only one of the two GoApply embeds nothing/);
    expect(retrieval.split('\n')).toContain('# CN_EMBED_API_KEY=');
    expectHas(commentAbove(retrieval, '# CN_EMBED_BATCH_SIZE='), /unset = the shared values/);
    expect(retrieval.split('\n')).toContain('# CN_EMBED_DAILY_TOKENS=');
  });

  it('SKILL_EMBED_MATCH_MIN, FEED_HYBRID and FEED_QUERY_EMBED_TIMEOUT_MS', () => {
    expectHas(commentAbove(retrieval, '# SKILL_EMBED_MATCH_MIN=0.86'), /Never read below 0\.8 or above 1.* Default 0\.86/);
    expectHas(commentAbove(retrieval, '# FEED_HYBRID='), /off returns every job list to the by-date part alone; any other value is on\. Default on/);
    expectHas(commentAbove(retrieval, '# FEED_QUERY_EMBED_TIMEOUT_MS=800'), /Default 800/);
  });
});

describe('.env.example: scoring and enrichment (M4; SM-8)', () => {
  it('MATCH_SCORER_RUBRIC: fit_v4 by default, fit_v3 is the rollback; the GoApply override', () => {
    const rubric = commentAbove(root, '# MATCH_SCORER_RUBRIC=fit_v4');
    expectHas(rubric, /fit_v4 \(the default: /);
    expectHas(rubric, /fit_v3 \(four judged components; the rollback\)/);
    expectHas(rubric, /Any other value keeps the default/);
    expectHas(rubric, /A change needs no deploy/);
    const cn = commentAbove(root, '# CN_MATCH_SCORER_RUBRIC=');
    expectHas(cn, /OPTIONAL override; unset = MATCH_SCORER_RUBRIC/);
    expectHas(cn, /A value that is not a rubric gives fit_v4, not the shared value/);
  });

  it('ENRICH_REQUIREMENTS_MAX: 1 to 24, default 12, per process', () => {
    const note = commentAbove(root, '# ENRICH_REQUIREMENTS_MAX=12');
    // enrich/schema.ts `enrichRequirementsMax`: Math.min(24, n) for a whole number of 1 or more.
    expectHas(note, /a whole number from 1 to 24 \(a larger whole number is read as 24\); anything else means the default/);
    expectHas(note, /Read per process, not per brand\. Default 12/);
  });

  it('the matching model lines say: the one pinned scorer model per market', () => {
    expectHas(commentAbove(root, 'LLM_MATCHING_MODEL='), /LLM_MATCHING_MODEL is the one pinned scorer model per market/);
    const cn = commentAbove(root, 'CN_LLM_MATCHING_MODEL=');
    expectHas(cn, /OPTIONAL override; unset = LLM_MATCHING_MODEL/);
    expectHas(cn, /the one pinned scorer model per market/);
  });
});

describe('deploy/cn/cn.env.example: the mainland kit', () => {
  it('offers every GoApply override of the wave as a commented optional line, never an active one', () => {
    const listed = entries(kit);
    const active = activeLines(kit).map(([n]) => n);
    for (const name of KIT_OVERRIDE_NAMES) {
      expect(listed.has(name), name).toBe(true);
      expect(entryCount(kit, name), name).toBe(1);
      expect(active, name).not.toContain(name);
    }
    // The per-provider pattern is named in its documented form too.
    expect(mentions(kit, 'INGEST_<PROVIDER>_CN_DAILY_CALLS')).toBe(true);
  });

  it('gives each of them its fallback: unset means the shared value or the safe default', () => {
    const FALLBACKS: Array<[string, RegExp]> = [
      ['# CN_ALIPAY_NOTIFY_ORIGIN=', /Optional: .* Unset = CN_BACKEND_URL, then https:\/\/www\.goapply\.top\. Never another brand's host unless that host runs this code on the same database/],
      ['# ALIPAY_SECRETLESS_UNTIL=', /Optional, for the cut-over only: .* only for an order production created before it, and only for 7 days after it\. Unset = never/],
      ['# CN_ALIPAY_PACKAGE_ID_MODE=', /Optional: legacy sends package_id `starter` .* Unset = the plan key as package_id/],
      ['# GOHIRE_SYNDICATION_URL=', /Optional: .* Unset = the transports above/],
      ['# GOHIRE_SYNDICATION_KEY=', /Optional: .* Unset = GOHIRE_API_KEY/],
      ['# CN_ACTIVEJOBS_ENABLED=', /Optional: .* only behind the paid-plan gate .* sends role text only, never user data\. Unset = on once that gate is open/],
      ['# INGEST_FEED_CN_DAILY_JOBS=', /Optional: .* Unset = 20% of the shared daily feed budget/],
      ['# INGEST_ACTIVEJOBS_CN_DAILY_CALLS=', /Optional: .* Default 0/],
      ['# CN_ATS_BEISEN_MAX_POSTINGS_PER_RUN=', /Optional: .* 1-2000\. Unset = 200/],
      ['# INGEST_BANK_RESYNC_DAYS=', /Optional: .* \(shared name; a whole number from 1 to 30; unset = 7\)/],
      ['# CN_ATS_TENANT_DENYLIST=', /Optional: .* Unset = none/],
      ['# CN_MATCH_SCORER_RUBRIC=', /Optional: .* Unset = MATCH_SCORER_RUBRIC, then fit_v4/],
      ['# CN_LLM_MATCHING_MODEL=', /Optional: .* Unset = LLM_MATCHING_MODEL, then the default model/],
      ['# CN_EMBED_BATCH_SIZE=', /Optional: .* unset = the shared values/],
    ];
    for (const [entry, fallback] of FALLBACKS) expectHas(commentAbove(kit, entry), fallback, `${entry} ${fallback}`);
  });

  it('labels the embeddings group an optional override, says vectors never cross markets and states the mainland model as a recommendation', () => {
    expectHas(kit, /^# ── Optional override: embeddings and retrieval ──$/m);
    const group = commentAbove(kit, '# CN_EMBED_MODEL=');
    expectHas(group, /Unset = the shared embedding model, endpoint, key and limits/);
    expectHas(group, /Vectors never cross markets/);
    expectHas(group, /as a recommendation and not a default: Alibaba text-embedding-v4 in the Beijing region/);
    expectHas(group, /CN_EMBED_BATCH_SIZE=10 next to it \(that model's limit of inputs per request, as its vendor's page stated it on 2026-10-11\)/);
    expect(kit.split('\n')).toContain('# CN_EMBED_MODEL=');
    expectHas(commentAbove(kit, '# CN_EMBED_BASE_URL='), /One pair: set both or neither/);
    for (const line of ['# CN_EMBED_API_KEY=', '# CN_EMBED_DAILY_TOKENS=']) expect(kit.split('\n'), line).toContain(line);
  });

  it('offers CN_MATCH_PRIORS as a commented optional override that falls back to the shared value', () => {
    expectHas(kit, /^# CN_MATCH_PRIORS=$/m);
    expect(activeLines(kit).map(([n]) => n)).not.toContain('CN_MATCH_PRIORS');
    const above = commentAbove(kit, '# CN_MATCH_PRIORS=');
    expectHas(above, /Optional: unset = MATCH_PRIORS, then the defaults in code/);
    // Its section is labelled like every other China-specific section of the kit.
    expectHas(kit, /^# ── Optional override: job matching ──$/m);
  });

  it('offers CN_JOB_SOURCES_CONTACT as a commented optional line: GoApply never reads the unprefixed name', () => {
    expectHas(kit, /^# CN_JOB_SOURCES_CONTACT=$/m);
    expect(entries(kit).has('JOB_SOURCES_CONTACT')).toBe(false);
    const above = commentAbove(kit, '# CN_JOB_SOURCES_CONTACT=');
    expectHas(above, /Optional: unset = https:\/\/www\.goapply\.top/);
    expectHas(above, /GoApply never reads the unprefixed JOB_SOURCES_CONTACT/);
  });

  it('lists no JSearch variable: JSearch is not a GoApply source (strategy M-6)', () => {
    expect([...entries(kit)].filter((n) => /JSEARCH/.test(n))).toEqual([]);
    expectHas(prose(section(kit, /Job sources/)), /JSearch is not a GoApply source and has no variable here/);
  });

  it('switches on no counsel-gated or paid-plan feature: the paid sources and the 北森 flag carry no enabling value', () => {
    const active = new Map(activeLines(kit));
    for (const name of ['CN_ATS_BEISEN_ENABLED', 'CN_ACTIVEJOBS_ENABLED', 'INGEST_ACTIVEJOBS_CN_DAILY_CALLS', 'INGEST_FEED_CN_DAILY_JOBS', 'FANTASTIC_MONTHLY_JOBS', 'FANTASTIC_API_KEY', 'RAPID_API_KEY']) {
      expect(active.has(name), name).toBe(false);
    }
    // Commented out, the two budgets carry no number that would open a paid source when uncommented.
    for (const line of ['# INGEST_ACTIVEJOBS_CN_DAILY_CALLS=', '# INGEST_FEED_CN_DAILY_JOBS=', '# CN_ACTIVEJOBS_ENABLED=']) expect(kit.split('\n'), line).toContain(line);
  });

  // The gate of the paid source needs a key for the chosen transport and, where the responses do not state
  // the plan, its size (ingest/config.ts `feedGateFor`: no_key, plan_too_small). They are shared names, so the
  // kit names them in words and gives them no entry: nothing here opens a paid source.
  it('names the shared variables that open the Active Jobs DB gate, in prose only', () => {
    const note = commentAbove(kit, '# CN_ACTIVEJOBS_ENABLED=');
    expectHas(note, /The key and the plan size are shared names of the root \.env\.example: RAPID_API_KEY, or FANTASTIC_TRANSPORT=direct with FANTASTIC_API_KEY, and FANTASTIC_MONTHLY_JOBS when the responses do not state the plan/);
    for (const name of ['RAPID_API_KEY', 'FANTASTIC_TRANSPORT', 'FANTASTIC_API_KEY', 'FANTASTIC_MONTHLY_JOBS']) {
      expect(entries(kit).has(name), name).toBe(false);
      expect(entries(root).has(name), name).toBe(true);
    }
    const calls = commentAbove(kit, '# INGEST_ACTIVEJOBS_CN_DAILY_CALLS=');
    expectHas(calls, /a person's own search reaches the provider only when this is set above 0/);
  });

  it('says the boards are not read at all when GoApply writes no board posting', () => {
    expectHas(prose(section(kit, /Job sources/)), /When GoApply writes no board posting \(its job feed switched off, or JOB_PROVIDERS_GOAPPLY without ats_public\) the boards are not read at all/);
  });

  it('lists no Stripe or USD price variable: a GoApply plan never reaches Stripe (rule A11)', () => {
    expect([...entries(kit)].filter((n) => /^STRIPE_|^PRICE_/.test(n))).toEqual([]);
  });

  it('every name it lists is in the root catalogue', () => {
    const catalogue = entries(root);
    for (const name of entries(kit)) expect(catalogue.has(name), name).toBe(true);
  });
});
