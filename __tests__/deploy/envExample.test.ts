// @vitest-environment node
//
// MKT-1G (market wave, phase M1): the env examples describe the variables the
// code of this phase reads (docs/jobright-clone/market/MARKET_STRATEGY.md 4.3,
// 5.1 "Safety first", 5.3 G2, M-13, M-25; requirements ST-0 and PC-1, the
// documentation half).
//
// Text checks on purpose. The two files are read as text: no network, no
// database, and no import of server code, because the code that reads these
// variables is written by other bundles of the same phase. The names below are
// copied from the env arrays of the M1 bundles in
// docs/jobright-clone/orch/market-bundles.json; they are not read from that
// file at run time. MKT-5H extends the lists with the variables of M2 to M5.
//
// __tests__/deploy/deployKit.test.ts keeps the older rules of the same files
// (each active name once, no off switch shipped, the mainland kit).

import { readFileSync } from 'node:fs';
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

/** A variable name as a whole word (STRIPE_PRICE_<PLANKEY> must not be satisfied by STRIPE_PRICE_<PLANKEY>_CENTS). */
const wholeName = (name: string) => new RegExp(`(?<![A-Za-z0-9_<>])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_<>])`);
const mentions = (text: string, name: string) => wholeName(name).test(text);
/** `NAME=value` lines that are not commented out. */
const activeLines = (text: string) => [...text.matchAll(/^([A-Z][A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1]!, m[2]!.trim()] as const);
/** Names with an entry of their own, active (`NAME=`) or commented out (`# NAME=`). */
const entries = (text: string) => new Set([...text.matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!));
/** The lines under one `# ── title ──` heading, up to the next heading. */
const section = (text: string, title: RegExp): string => {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('# ──') && title.test(l));
  expect(start, String(title)).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && l.startsWith('# ──'));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
};
/** Assertions on a whole file report the label, not the file (a failed toMatch would print 1,300 lines). */
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
  // MKT-1C: job sources
  'JOB_SOURCES_CONTACT',
  // MKT-1D: evaluation harness
  'EVAL_LIVE',
  'EVAL_JUDGE_MODEL',
  // MKT-1F: estimate v2
  'MATCH_PRIORS',
  'CN_MATCH_PRIORS',
  'MATCH_CALIBRATION_MIN_PAIRS',
];

/** Names with a placeholder, in their documented pattern form (MKT-1A, PC-1). */
const M1_PATTERN_NAMES = [
  'PRICE_<PLANKEY>_USD_CENTS',
  'STRIPE_PRICE_<PLANKEY>_CENTS',
  'STRIPE_PRICE_<PLANKEY>',
  'PRICE_<PLANKEY>_TWD_CENTS',
  'STRIPE_PRICE_<PLANKEY>_TWD_CENTS',
  'STRIPE_PRICE_<PLANKEY>_TWD',
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
];

describe('env examples: the variables of market wave phase M1', () => {
  it('names every literal variable of the M1 bundles in .env.example', () => {
    for (const name of M1_LITERAL_NAMES) expect(mentions(root, name), name).toBe(true);
  });

  it('gives every literal variable an entry of its own (NAME= or # NAME=), not only a mention in prose', () => {
    const listed = entries(root);
    for (const name of M1_LITERAL_NAMES) expect(listed.has(name), name).toBe(true);
  });

  it('documents every per-plan variable in its pattern form', () => {
    for (const name of M1_PATTERN_NAMES) expect(mentions(root, name), name).toBe(true);
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
    for (const placeholder of ['sk_test_...', 'whsec_...', 'a live key (sk_live_ or rk_live_) is refused']) {
      expect(SECRET_SHAPES.some(([, shape]) => shape.test(placeholder)), placeholder).toBe(false);
    }
  });

  it('ships the Stripe credentials empty', () => {
    const active = new Map(activeLines(root));
    for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'ROBOAPPLY_STRIPE_WEBHOOK_SECRET']) {
      expect(active.get(name) ?? '', name).toBe('');
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

  it('says the webhook secret accepts a comma-separated list for a rotation', () => {
    expectHas(text, /comma-separated list/);
    expectHas(text, /rotation/);
  });

  // Interim, phase M1 only. The rail's readiness check (MKT-1A, stripeEnv.ts)
  // reads both names as lists, but the webhook route verifies a signature with
  // one raw string until MKT-2B (phase M2) makes it try each secret. A list set
  // before then opens checkout and fails every webhook, the failure M-25 is
  // there to prevent. MKT-5H removes these sentences and this test once MKT-2B
  // has merged.
  it('warns that until phase M2 the webhook is verified with one value, and which name wins', () => {
    const list = commentAbove(stripe, 'STRIPE_WEBHOOK_SECRET=');
    expectHas(list, /Until phase M2 of the market wave \(MKT-2B\) is merged the webhook route verifies with a single value: set one secret, not a list/);
    expectHas(list, /a list set before then lets checkout open while every webhook is rejected and nothing is fulfilled/);
    const second = commentAbove(stripe, '# ROBOAPPLY_STRIPE_WEBHOOK_SECRET=');
    expectHas(second, /Until then, when both names are set only ROBOAPPLY_STRIPE_WEBHOOK_SECRET is used to verify/);
  });

  it('says a live key is refused outside production and names the test key and the stripe listen secret', () => {
    expectHas(text, /live key \(sk_live_ or rk_live_\) is refused whenever VERCEL_ENV is not production/);
    expectHas(text, /sk_test_\.\.\./);
    expectHas(text, /stripe listen/);
    expectHas(text, /whsec_\.\.\./);
  });

  it('shows the override as a commented line with its warning, never as an active line', () => {
    expectHas(stripe, /^# STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION=true$/m);
    expect(activeLines(root).map(([n]) => n)).not.toContain('STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION');
    const warning = commentAbove(stripe, '# STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION=true');
    expectHas(warning, /Warning: true lets a development machine act on the live Stripe account/);
    expectHas(warning, /default unset = a live key is refused outside production/);
  });

  it('does not document a variable no code reads', () => {
    expect(root.includes('STRIPE_BILLING_PORTAL_URL')).toBe(false);
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
    // Interim: MKT-1C ships the helper (sourceUserAgent) with no caller; the
    // adapters send it from phase M3 (MKT-3D, MKT-3E). MKT-5H drops the sentence
    // and this line once M3 has merged.
    expectHas(note, /Sent by the job-source adapters from phase M3 of the market wave; before that the variable has no effect/);
  });

  it('EVAL_LIVE and EVAL_JUDGE_MODEL: off unless set, and the judge differs from the scorer', () => {
    const live = commentAbove(root, '# EVAL_LIVE=');
    expectHas(live, /1 allows `npm run eval:match -- --live` to read the database \(read-only\) and to call models/);
    expectHas(live, /any other value, or unset, refuses/);
    const judge = commentAbove(root, '# EVAL_JUDGE_MODEL=');
    expectHas(judge, /must differ from the resolved LLM_MATCHING_MODEL/);
    expectHas(judge, /unset = --live refuses to judge/);
  });

  it('MATCH_PRIORS, CN_MATCH_PRIORS and MATCH_CALIBRATION_MIN_PAIRS: defaults 44 / 39 / 24 / 50 / 45 and 500', () => {
    const priors = commentAbove(root, '# MATCH_PRIORS=');
    expectHas(priors, /title_level \/ skills \/ industry \/ logistics \/ career_path; defaults 44 \/ 39 \/ 24 \/ 50 \/ 45/);
    expectHas(priors, /malformed value keeps the defaults/);
    // The GoApply name is an optional override that falls back to the shared value (D5).
    expectHas(commentAbove(root, '# CN_MATCH_PRIORS='), /OPTIONAL override; unset = MATCH_PRIORS, then the defaults/);
    // The default is written next to the switch, as the commented-out value.
    expectHas(commentAbove(root, '# MATCH_CALIBRATION_MIN_PAIRS=500'), /default 500/);
  });
});

describe('deploy/cn/cn.env.example: the mainland kit', () => {
  it('offers CN_MATCH_PRIORS as a commented optional override that falls back to the shared value', () => {
    expectHas(kit, /^# CN_MATCH_PRIORS=$/m);
    expect(activeLines(kit).map(([n]) => n)).not.toContain('CN_MATCH_PRIORS');
    const above = commentAbove(kit, '# CN_MATCH_PRIORS=');
    expectHas(above, /Optional: unset = MATCH_PRIORS, then the defaults in code/);
    // Its section is labelled like every other China-specific section of the kit.
    expectHas(kit, /^# ── Optional override: job matching ──$/m);
  });

  it('lists no Stripe or USD price variable: a GoApply plan never reaches Stripe (rule A11)', () => {
    expect([...entries(kit)].filter((n) => /^STRIPE_|^PRICE_/.test(n))).toEqual([]);
  });

  it('every name it lists is in the root catalogue', () => {
    const catalogue = entries(root);
    for (const name of entries(kit)) expect(catalogue.has(name), name).toBe(true);
  });
});
