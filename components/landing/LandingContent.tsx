'use client';

// Landing — public marketing. "NIGHT SHIFT / OVERNIGHT LOG", v2.
//
// The page reads as one overnight run of the agent, 23:04 → 09:02: a live
// "overnight.log" terminal in the hero (nine timestamped lines, a lime flash
// on the 09:00 SUBMIT, a caret that never stops blinking), a why-bots-lose
// stats band, the shift timeline, a full-loop feature grid, the interview
// studio spotlight (report-card receipt), trust as a read-only
// guarantees.conf panel, real pricing (mock-interview credit plans), an
// always-visible FAQ written for AI-engine extraction, and a final "your
// agent clocks in tonight" band.
//
// Two type voices carry the promise: everything the machine does is
// JetBrains Mono / Space Grotesk; everything human ("You interview.",
// "tonight.") is Instrument Serif italic. Headline sentence periods are
// accent-colored — the agent's cursor as a typographic tic.
//
// THEMES — dark is the agent's night (V3 electric tokens); light/warm are
// the human's morning: styles/landing.css re-points the V3 base tokens on
// .landing-root to the Anthropic clay-on-cream palette for BOTH light and
// warm, so the landing has exactly two appearances. Copy is 100% i18n
// (`landing` + `common`). Motion is CSS-only with a reduced-motion fallback.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Logo } from '../chrome/Logo';
import { PageContainer } from '../ui/PageContainer';
import {
  LOCALE_LABELS,
  SEO_READY_LOCALES,
  localePath,
} from '../../lib/localeConfig';
import { LanguageMenu } from './LanguageMenu';
import { ThemeToggle } from './ThemeToggle';

type TagVariant =
  | 'scout'
  | 'match'
  | 'draft'
  | 'queue'
  | 'hold'
  | 'submit'
  | 'digest';

// Hero log rows: i18n key ↔ chip variant. Times/tags live in i18n but stay
// ASCII in every locale (machine voice).
const LOG_LINES: ReadonlyArray<{ key: string; variant: TagVariant }> = [
  { key: 'l1', variant: 'scout' },
  { key: 'l2', variant: 'match' },
  { key: 'l3', variant: 'draft' },
  { key: 'l4', variant: 'draft' },
  { key: 'l5', variant: 'queue' },
  { key: 'l6', variant: 'hold' },
  { key: 'l7', variant: 'hold' },
  { key: 'l8', variant: 'submit' },
  { key: 'l9', variant: 'digest' },
];

const STEPS: ReadonlyArray<{ key: string; variant: TagVariant }> = [
  { key: 's1', variant: 'scout' },
  { key: 's2', variant: 'draft' },
  { key: 's3', variant: 'hold' },
  { key: 's4', variant: 'submit' },
];

const STATS = ['s1', 's2', 's3'] as const;

const LOOP_CARDS: ReadonlyArray<{ key: string; variant: TagVariant }> = [
  { key: 'match', variant: 'match' },
  { key: 'resume', variant: 'draft' },
  { key: 'apply', variant: 'hold' },
  { key: 'studio', variant: 'digest' },
];

const STUDIO_FEATURES = ['f1', 'f2', 'f3', 'f4', 'f5'] as const;
const REPORT_ROWS = [
  { key: 'r1', width: '86%' },
  { key: 'r2', width: '78%' },
  { key: 'r3', width: '84%' },
] as const;

const RULES = ['r1', 'r2', 'r3', 'r4', 'r5'] as const;

const TIERS = [
  { key: 'free', featured: false },
  { key: 'starter', featured: true },
  { key: 'growth', featured: false },
] as const;

const FAQ_ITEMS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8'] as const;

export function LandingContent() {
  const t = useTranslations('landing');
  const tCommon = useTranslations('common');

  return (
    <div className="landing-root min-h-screen bg-bg-page">
      {/* Film grain over the whole page */}
      <div aria-hidden className="landing-grain" />

      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="landing-header sticky top-0 z-40 border-b border-ink-line-soft">
        <PageContainer
          maxWidth="wide"
          className="flex h-16 items-center justify-between gap-3 !py-0"
        >
          {/* Wordmark, not the white-boxed bitmap — the accent square echoes
              the caret motif. */}
          <span className="landing-wordmark">
            <span aria-hidden className="wordmark-square" />
            RoboApply
          </span>
          <div className="flex items-center gap-2.5 sm:gap-4">
            <LanguageMenu label={t('header.lang_label')} />
            <ThemeToggle />
            <Link
              href="/login"
              className="text-sm font-semibold text-accent-text hover:underline"
            >
              {tCommon('sign_in')}
            </Link>
            <Link
              href="/onboarding"
              className="cta-primary hidden !h-10 !rounded-[10px] !px-4 !text-[13px] md:inline-flex"
            >
              {t('header.cta')}
            </Link>
          </div>
        </PageContainer>
      </header>

      <main>
        {/* ── Hero — the overnight.log ─────────────────────────── */}
        <section className="hero-fold hero-base relative overflow-hidden">
          <div aria-hidden className="hero-grid pointer-events-none absolute inset-0 z-0" />
          <div aria-hidden className="hero-wash pointer-events-none absolute inset-0 z-0" />
          <div className="hero-fold-body relative z-10 w-full">
          <PageContainer
            maxWidth="wide"
            className="w-full !pt-12 !pb-16 md:!pt-16 md:!pb-20"
          >
            <div className="grid items-center gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
              {/* Left — pitch */}
              <div>
                <p
                  className="anim-rise hero-eyebrow"
                  style={{ animationDelay: '.05s' }}
                >
                  {t('hero.eyebrow')}
                </p>
                <h1
                  className="anim-rise hero-h1 mt-5 font-bold text-ink-900"
                  style={{ animationDelay: '.15s' }}
                >
                  <span className="block">
                    {t('hero.headline_machine')}
                    <span className="text-accent-text">.</span>
                  </span>{' '}
                  <span className="serif-human block">
                    {t('hero.headline_human')}
                    <span className="text-accent-text">.</span>
                  </span>
                </h1>
                <p
                  className="anim-rise mt-6 max-w-[52ch] text-base leading-relaxed text-ink-700 md:text-lg"
                  style={{ animationDelay: '.28s' }}
                >
                  {t('hero.subheadline')}
                </p>
                <p className="anim-rise sub-emph" style={{ animationDelay: '.34s' }}>
                  {t('hero.sub_emphasis')}
                </p>
                <div
                  className="anim-rise mt-8 flex flex-wrap items-center gap-x-6 gap-y-4 md:mt-9"
                  style={{ animationDelay: '.4s' }}
                >
                  <Link
                    href="/onboarding"
                    className="cta-primary w-full sm:w-auto"
                  >
                    {t('hero.cta_primary')}
                    <span aria-hidden className="font-mono text-[15px] opacity-70">
                      ↵
                    </span>
                  </Link>
                  <a href="#how" className="cta-quiet">
                    {t('hero.cta_secondary')} <span aria-hidden>↓</span>
                  </a>
                </div>
                <p
                  className="anim-rise mt-5 text-[13px] text-ink-500"
                  style={{ animationDelay: '.48s' }}
                >
                  {t('hero.reassure')}
                </p>
              </div>

              {/* Right — the signature log panel */}
              <div className="relative w-full max-w-[560px] lg:mx-0 lg:justify-self-end">
                <div
                  aria-hidden
                  className="pointer-events-none absolute"
                  style={{
                    inset: '-3rem',
                    background:
                      'radial-gradient(closest-side, var(--accent-soft), transparent 70%)',
                    filter: 'blur(24px)',
                  }}
                />
                <div
                  className="anim-rise log-panel relative overflow-hidden rounded-[var(--r-lg)] border border-ink-line p-4 min-[421px]:p-5 md:p-6"
                  style={{ animationDelay: '.55s' }}
                >
                  <div className="mb-4 flex items-center justify-between border-b border-ink-line-soft pb-3">
                    <span className="flex items-center">
                      <span aria-hidden className="log-dots">
                        <span />
                        <span />
                        <span />
                      </span>
                      <span className="font-mono text-xs text-ink-500">
                        {t('hero.log.title')}
                      </span>
                    </span>
                    <span className="sample-chip">
                      <span aria-hidden className="live-dot" />
                      {t('hero.log.live')}
                    </span>
                  </div>
                  <div aria-hidden="true">
                    {LOG_LINES.map(({ key, variant }, i) => {
                      const delay = `${(0.9 + i * 0.22).toFixed(2)}s`;
                      return (
                        <div
                          key={key}
                          className={`${
                            variant === 'submit' ? 'log-flash' : 'log-line'
                          } grid grid-cols-[2.9rem_auto_1fr] items-baseline gap-x-3 py-[5px] font-mono text-[12px] leading-relaxed min-[421px]:grid-cols-[3.2rem_auto_1fr] min-[421px]:text-[13px]`}
                          style={{ animationDelay: delay }}
                        >
                          <span className="text-ink-500">
                            {t(`hero.log.lines.${key}.time`)}
                          </span>
                          <Tag variant={variant} label={t(`hero.log.lines.${key}.tag`)} />
                          <span className="min-w-0 text-ink-700">
                            {t(`hero.log.lines.${key}.msg`)}
                          </span>
                        </div>
                      );
                    })}
                    {/* Caret row — the agent never clocks out */}
                    <div
                      className="log-line grid grid-cols-[2.9rem_auto_1fr] items-baseline gap-x-3 py-[5px] min-[421px]:grid-cols-[3.2rem_auto_1fr]"
                      style={{ animationDelay: '3.1s' }}
                    >
                      <span />
                      <span
                        className="caret inline-block h-[15px] w-[8px] translate-y-[2px]"
                        style={{
                          background: 'var(--accent)',
                          boxShadow: '0 0 10px var(--accent-glow)',
                        }}
                      />
                    </div>
                  </div>
                  <p className="sr-only">{t('hero.log.aria')}</p>
                </div>
              </div>
            </div>
          </PageContainer>
          </div>
          {/* Dawn line — closes the fold with the consent receipt + scroll cue */}
          <div className="hero-strip">
            <PageContainer maxWidth="wide" className="!py-0">
              <div className="hero-strip-row">
                <span className="truncate">{t('hero.strip_summary')}</span>
                <a href="#how">
                  {t('hero.strip_scroll')} <span aria-hidden>↓</span>
                </a>
              </div>
            </PageContainer>
          </div>
        </section>

        {/* ── 01 · Why bots are losing — the stats band ──────────── */}
        <section
          className="border-t border-ink-line-soft py-16 md:py-24"
          style={{ background: 'var(--bg-2)' }}
        >
          <PageContainer maxWidth="content">
            <div className="scroll-rise">
              <p className="font-mono text-xs uppercase tracking-[0.16em] text-ink-500">
                <span className="text-accent-text">01</span> · {t('problem.eyebrow')}
              </p>
              <h2
                className="mt-3 text-3xl font-bold text-ink-900 md:text-4xl"
                style={{ letterSpacing: '-0.02em' }}
              >
                {t('problem.title')}
              </h2>
              <p className="mt-3 max-w-[58ch] text-base text-ink-700 md:text-lg">
                {t('problem.sub')}
              </p>
            </div>

            <div className="mt-10 grid gap-4 sm:grid-cols-3 md:mt-12 md:gap-5">
              {STATS.map((key) => (
                <div
                  key={key}
                  className="scroll-rise rounded-[var(--r-lg)] border border-ink-line bg-bg-card p-6"
                >
                  <p className="stat-number font-mono text-[44px] font-bold leading-none tabular-nums text-accent-text md:text-[52px]">
                    {t(`problem.stats.${key}.value`)}
                  </p>
                  <p className="mt-3 text-sm leading-relaxed text-ink-700">
                    {t(`problem.stats.${key}.label`)}
                  </p>
                </div>
              ))}
            </div>
            <p className="scroll-rise mt-5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-500">
              {t('problem.source')}
            </p>
          </PageContainer>
        </section>

        {/* ── 02 · How a shift runs ──────────────────────────────── */}
        <section id="how" className="py-16 md:py-28">
          <PageContainer maxWidth="content">
            <div className="scroll-rise">
              <p className="font-mono text-xs uppercase tracking-[0.16em] text-ink-500">
                <span className="text-accent-text">02</span> · {t('how.eyebrow')}
              </p>
              <h2
                className="mt-3 text-3xl font-bold text-ink-900 md:text-4xl"
                style={{ letterSpacing: '-0.02em' }}
              >
                {t('how.title')}
              </h2>
              <p className="mt-3 max-w-[52ch] text-base text-ink-700 md:text-lg">
                {t('how.sub')}
              </p>
            </div>

            <div className="mt-12 md:mt-16">
              {STEPS.map(({ key, variant }, i) => {
                const last = i === STEPS.length - 1;
                return (
                  <div
                    key={key}
                    className={`scroll-rise group relative grid grid-cols-[24px_1fr] gap-x-4 md:grid-cols-[96px_28px_1fr] md:gap-x-5 ${
                      last ? '' : 'pb-12'
                    }`}
                  >
                    {/* time + tag (md+) */}
                    <div className="hidden md:flex md:flex-col md:items-end">
                      <span className="font-mono text-lg font-semibold tabular-nums text-ink-900 transition-colors duration-150 group-hover:text-accent-text">
                        {t(`how.steps.${key}.time`)}
                      </span>
                      <span className="mt-1.5">
                        <Tag variant={variant} label={t(`how.steps.${key}.tag`)} />
                      </span>
                    </div>
                    {/* rail */}
                    <div aria-hidden className="relative flex justify-center">
                      {!last && (
                        <span className="absolute top-1 bottom-[-4px] w-px bg-[color:var(--rule)]" />
                      )}
                      <span
                        className={`relative z-10 mt-1 h-[11px] w-[11px] rounded-full border-2 ${
                          last
                            ? 'border-[color:var(--accent)] bg-[color:var(--accent)]'
                            : 'border-[color:var(--rule)] bg-bg-page'
                        }`}
                        style={last ? { boxShadow: 'var(--shadow-cta)' } : undefined}
                      />
                    </div>
                    {/* content */}
                    <div>
                      <div className="flex items-center gap-2 md:hidden">
                        <span className="font-mono text-sm font-semibold tabular-nums text-ink-900">
                          {t(`how.steps.${key}.time`)}
                        </span>
                        <Tag variant={variant} label={t(`how.steps.${key}.tag`)} />
                      </div>
                      <h3
                        className="mt-1 text-lg font-semibold text-ink-900 md:mt-0 md:text-xl lg:text-2xl"
                        style={{ letterSpacing: '-0.015em' }}
                      >
                        {t(`how.steps.${key}.title`)}
                      </h3>
                      <p className="mt-2 max-w-[58ch] text-[15px] leading-relaxed text-ink-700 md:text-base">
                        {t(`how.steps.${key}.body`)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </PageContainer>
        </section>

        {/* ── 03 · The full loop — feature grid ──────────────────── */}
        <section
          className="border-y border-ink-line-soft py-16 md:py-24"
          style={{ background: 'var(--bg-2)' }}
        >
          <PageContainer maxWidth="wide">
            <div className="scroll-rise text-center">
              <p className="font-mono text-xs uppercase tracking-[0.16em] text-ink-500">
                <span className="text-accent-text">03</span> · {t('loop.eyebrow')}
              </p>
              <h2
                className="mt-3 text-3xl font-bold text-ink-900 md:text-4xl"
                style={{ letterSpacing: '-0.02em' }}
              >
                {t('loop.title')}
              </h2>
              <p className="mx-auto mt-3 max-w-[52ch] text-base text-ink-700 md:text-lg">
                {t('loop.sub')}
              </p>
            </div>

            <div className="mx-auto mt-10 grid max-w-[1040px] gap-4 sm:grid-cols-2 md:mt-14 md:gap-5">
              {LOOP_CARDS.map(({ key, variant }) => (
                <div
                  key={key}
                  className="scroll-rise relative rounded-[var(--r-lg)] border border-ink-line bg-bg-card p-6 transition-all duration-200 ease-standard hover:-translate-y-[2px] hover:border-[color:var(--accent)] md:p-7"
                >
                  <div className="flex items-center justify-between gap-3">
                    <Tag variant={variant} label={t(`loop.cards.${key}.tag`)} />
                    {key === 'apply' && (
                      <span className="early-chip">{t('loop.cards.apply.chip')}</span>
                    )}
                  </div>
                  <h3
                    className="mt-4 text-lg font-semibold text-ink-900 md:text-xl"
                    style={{ letterSpacing: '-0.015em' }}
                  >
                    {t(`loop.cards.${key}.title`)}
                  </h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-ink-700">
                    {t(`loop.cards.${key}.body`)}
                  </p>
                </div>
              ))}
            </div>
          </PageContainer>
        </section>

        {/* ── 04 · Interview studio spotlight ────────────────────── */}
        <section id="studio" className="py-16 md:py-28">
          <PageContainer maxWidth="wide">
            <div className="grid items-center gap-10 lg:grid-cols-[1fr_0.9fr] lg:gap-16">
              {/* Left — pitch + features */}
              <div>
                <p className="scroll-rise font-mono text-xs uppercase tracking-[0.16em] text-ink-500">
                  <span className="text-accent-text">04</span> · {t('studio.eyebrow')}
                </p>
                <h2
                  className="scroll-rise mt-3 font-bold text-ink-900"
                  style={{
                    fontSize: 'clamp(1.9rem, 4.2vw, 2.9rem)',
                    lineHeight: 1.1,
                    letterSpacing: '-0.02em',
                  }}
                >
                  {t('studio.title_machine')}
                  <span className="text-accent-text">.</span>{' '}
                  <span className="serif-human">{t('studio.title_human')}</span>
                  <span className="text-accent-text">.</span>
                </h2>
                <p className="scroll-rise mt-4 max-w-[56ch] text-base text-ink-700 md:text-lg">
                  {t('studio.sub')}
                </p>

                <div className="mt-8">
                  {STUDIO_FEATURES.map((key, i) => (
                    <div
                      key={key}
                      className="scroll-rise grid grid-cols-[2rem_1fr] gap-x-3 border-t border-ink-line-soft py-4 last:border-b md:py-5"
                    >
                      <span className="font-mono text-xs font-semibold tabular-nums text-accent-text">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <div>
                        <h3 className="text-[15px] font-semibold text-ink-900 md:text-base">
                          {t(`studio.features.${key}.title`)}
                        </h3>
                        <p className="mt-1 text-sm leading-relaxed text-ink-700">
                          {t(`studio.features.${key}.body`)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>

                <Link
                  href="/onboarding"
                  className="cta-outline scroll-rise mt-8 !w-auto px-6"
                >
                  {t('studio.cta')}
                </Link>
              </div>

              {/* Right — the report-card receipt */}
              <div className="relative w-full max-w-[480px] lg:justify-self-end">
                <div
                  aria-hidden
                  className="pointer-events-none absolute"
                  style={{
                    inset: '-3rem',
                    background:
                      'radial-gradient(closest-side, var(--violet-soft), transparent 70%)',
                    filter: 'blur(24px)',
                  }}
                />
                <div className="scroll-rise log-panel relative overflow-hidden rounded-[var(--r-lg)] border border-ink-line p-5 md:p-6">
                  <div className="mb-5 flex items-center justify-between border-b border-ink-line-soft pb-3">
                    <span className="font-mono text-xs text-ink-500">
                      {t('studio.report.header')}
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500">
                      {t('studio.report.overall_label')}{' '}
                      <span
                        className="text-[20px] font-bold text-accent-text"
                        style={{ textShadow: '0 0 16px var(--accent-glow)' }}
                      >
                        {t('studio.report.overall')}
                      </span>
                    </span>
                  </div>
                  <div className="space-y-4">
                    {REPORT_ROWS.map(({ key, width }) => (
                      <div key={key}>
                        <div className="flex items-baseline justify-between font-mono text-[12px]">
                          <span className="text-ink-700">
                            {t(`studio.report.rows.${key}.k`)}
                          </span>
                          <span className="tabular-nums text-ink-900">
                            {t(`studio.report.rows.${key}.v`)}
                          </span>
                        </div>
                        <div className="report-bar mt-1.5">
                          <span className="report-bar-fill" style={{ width }} />
                        </div>
                      </div>
                    ))}
                  </div>
                  <blockquote className="serif-human mt-6 border-l-2 border-[color:var(--accent)] pl-4 text-[17px] leading-snug text-ink-900">
                    {t('studio.report.quote')}
                  </blockquote>
                  <p className="mt-2 pl-4 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500">
                    {t('studio.report.quote_label')}
                  </p>
                </div>
              </div>
            </div>
          </PageContainer>
        </section>

        {/* ── 05 · Operating rules — guarantees.conf ─────────────── */}
        <section
          className="border-y border-ink-line-soft py-16 md:py-24"
          style={{ background: 'var(--bg-2)' }}
        >
          <PageContainer maxWidth="content">
            <div className="scroll-rise text-center">
              <p className="font-mono text-xs uppercase tracking-[0.16em] text-ink-500">
                <span className="text-accent-text">05</span> · {t('rules.eyebrow')}
              </p>
              <h2
                className="mt-3 text-3xl font-bold text-ink-900 md:text-4xl"
                style={{ letterSpacing: '-0.02em' }}
              >
                {t('rules.title')}
              </h2>
              <p className="mx-auto mt-3 max-w-[52ch] text-base text-ink-700 md:text-lg">
                {t('rules.sub')}
              </p>
            </div>

            <div className="scroll-rise mx-auto mt-10 max-w-[720px] overflow-hidden rounded-[var(--r-lg)] border border-ink-line bg-bg-card md:mt-12">
              <div className="flex items-center justify-between border-b border-ink-line-soft px-5 py-3 md:px-6">
                <span className="font-mono text-xs text-ink-500">
                  {t('rules.file')}
                </span>
                <span
                  className="rounded-[4px] px-2 py-1 font-mono text-[10px] tracking-[0.14em]"
                  style={{ background: 'var(--ok-soft)', color: 'var(--ok)' }}
                >
                  {t('rules.badge')}
                </span>
              </div>
              <div className="px-5 py-2 md:px-6">
                {RULES.map((rule) => (
                  <div
                    key={rule}
                    className="flex items-start gap-3.5 border-b border-ink-line-soft py-4 last:border-0"
                  >
                    <span
                      aria-hidden
                      className="mt-[3px] rounded-[4px] px-1.5 py-0.5 font-mono text-[11px]"
                      style={{ background: 'var(--ok-soft)', color: 'var(--ok)' }}
                    >
                      {t('rules.ok')}
                    </span>
                    <p className="text-[15px] leading-relaxed text-ink-700">
                      <strong className="font-semibold text-ink-900">
                        {t(`rules.items.${rule}_head`)}
                      </strong>{' '}
                      — {t(`rules.items.${rule}_body`)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </PageContainer>
        </section>

        {/* ── 06 · Pricing — the real plans ──────────────────────── */}
        <section id="pricing" className="py-16 md:py-28">
          <PageContainer maxWidth="wide">
            <div className="scroll-rise text-center">
              <p className="font-mono text-xs uppercase tracking-[0.16em] text-ink-500">
                <span className="text-accent-text">06</span> · {t('pricing.eyebrow')}
              </p>
              <h2
                className="mt-3 text-3xl font-bold text-ink-900 md:text-4xl"
                style={{ letterSpacing: '-0.02em' }}
              >
                {t('pricing.title')}
              </h2>
              <p className="mx-auto mt-3 max-w-[52ch] text-base text-ink-700 md:text-lg">
                {t('pricing.sub')}
              </p>
            </div>

            <div className="mx-auto mt-10 grid max-w-[1040px] items-stretch gap-5 md:mt-12 lg:grid-cols-3">
              {TIERS.map(({ key, featured }) => (
                <div
                  key={key}
                  className={`scroll-rise relative flex flex-col rounded-[var(--r-lg)] border bg-bg-card p-6 transition-all duration-200 ease-standard hover:-translate-y-[2px] hover:border-[color:var(--accent)] hover:shadow-lift md:p-7 ${
                    featured ? 'border-[color:var(--accent)]' : 'border-ink-line'
                  }`}
                  style={featured ? { boxShadow: 'var(--shadow-ring)' } : undefined}
                >
                  {featured && (
                    <span
                      className="absolute -top-3 left-7 rounded-pill px-2.5 py-1 font-mono text-[10px] font-medium tracking-[0.12em]"
                      style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
                    >
                      {t('pricing.tiers.starter.badge')}
                    </span>
                  )}
                  <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-500">
                    {t(`pricing.tiers.${key}.code`)}
                  </p>
                  <h3 className="mt-2 text-[22px] font-semibold text-ink-900">
                    {t(`pricing.tiers.${key}.name`)}
                  </h3>
                  <div className="mt-6 flex items-baseline gap-2.5">
                    <span
                      className={`font-mono text-[52px] font-bold leading-none tabular-nums ${
                        featured ? 'text-accent-text' : 'text-ink-900'
                      }`}
                      style={
                        featured
                          ? { textShadow: '0 0 24px var(--accent-glow)' }
                          : undefined
                      }
                    >
                      {t(`pricing.tiers.${key}.rate`)}
                    </span>
                    <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-500">
                      {t(`pricing.tiers.${key}.unit`)}
                    </span>
                  </div>
                  <div className="mt-5 flex items-baseline gap-1">
                    <span className="text-xl font-semibold text-ink-900">
                      {t(`pricing.tiers.${key}.price`)}
                    </span>
                    {t(`pricing.tiers.${key}.per`) !== '' && (
                      <span className="text-sm text-ink-500">
                        {t(`pricing.tiers.${key}.per`)}
                      </span>
                    )}
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-ink-700">
                    {t(`pricing.tiers.${key}.note`)}
                  </p>
                  <div className="flex-1" />
                  {featured ? (
                    <Link
                      href="/onboarding"
                      className="cta-primary mt-8 w-full !h-12 !text-sm"
                    >
                      {t(`pricing.tiers.${key}.cta`)}
                    </Link>
                  ) : (
                    <Link href="/onboarding" className="cta-outline mt-8">
                      {t(`pricing.tiers.${key}.cta`)}
                    </Link>
                  )}
                </div>
              ))}
            </div>
            <p className="scroll-rise mx-auto mt-6 max-w-[64ch] text-center font-mono text-[11px] uppercase tracking-[0.1em] leading-relaxed text-ink-500">
              {t('pricing.credit_note')}
            </p>
          </PageContainer>
        </section>

        {/* ── 07 · FAQ — visible, extraction-friendly ────────────── */}
        <section id="faq" className="border-t border-ink-line-soft py-16 md:py-24">
          <PageContainer maxWidth="wide">
            <div className="scroll-rise">
              <p className="font-mono text-xs uppercase tracking-[0.16em] text-ink-500">
                <span className="text-accent-text">07</span> · {t('faq.eyebrow')}
              </p>
              <h2
                className="mt-3 text-3xl font-bold text-ink-900 md:text-4xl"
                style={{ letterSpacing: '-0.02em' }}
              >
                {t('faq.title')}
              </h2>
            </div>

            <div className="mt-10 grid gap-x-12 gap-y-8 md:mt-12 md:grid-cols-2">
              {FAQ_ITEMS.map((key) => (
                <div key={key} className="scroll-rise">
                  <h3 className="text-base font-semibold text-ink-900 md:text-lg">
                    {t(`faq.items.${key}.q`)}
                  </h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-ink-700">
                    {t(`faq.items.${key}.a`)}
                  </p>
                </div>
              ))}
            </div>
          </PageContainer>
        </section>

        {/* ── 08 · Clock in — final CTA ──────────────────────────── */}
        <section className="relative overflow-hidden border-t border-ink-line-soft py-20 text-center md:py-32">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                'radial-gradient(ellipse 640px 360px at 50% 118%, var(--accent-soft), transparent 65%), radial-gradient(ellipse 520px 420px at 82% -12%, var(--violet-soft), transparent 60%)',
            }}
          />
          <PageContainer
            maxWidth="content"
            className="relative z-10 flex flex-col items-center"
          >
            <span className="scroll-rise inline-flex h-8 items-center gap-2 rounded-pill border border-ink-line bg-bg-card px-3.5 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-700">
              <span aria-hidden className="live-dot" />
              {t('final.chip')}
            </span>
            <h2
              className="scroll-rise mt-7 font-bold text-ink-900"
              style={{
                fontSize: 'clamp(2.2rem, 5vw, 3.6rem)',
                lineHeight: 1.06,
                letterSpacing: '-0.025em',
              }}
            >
              {t('final.title_machine')}{' '}
              <span className="serif-human">{t('final.title_human')}</span>
              <span className="text-accent-text">.</span>
            </h2>
            <p className="scroll-rise mt-5 max-w-[46ch] text-base text-ink-700 md:text-lg">
              {t('final.sub')}
            </p>
            <Link
              href="/onboarding"
              className="cta-primary scroll-rise mt-9 w-full sm:w-auto"
            >
              {t('final.cta')}
              <span aria-hidden className="font-mono text-[15px] opacity-70">
                ↵
              </span>
            </Link>
          </PageContainer>
        </section>
      </main>

      {/* ── Footer ─────────────────────────────────────────────── */}
      <footer className="border-t border-ink-line pb-24 md:pb-0">
        <PageContainer maxWidth="wide" className="!py-8">
          <div className="flex flex-col items-center justify-between gap-4 md:flex-row">
            <Logo size="sm" />
            <p className="text-sm text-ink-700">{t('footer.tagline')}</p>
            <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-500">
              {t('footer.status')}
            </p>
          </div>
          {/* Locale links — crawlable entry points to the hreflang cluster */}
          <nav
            aria-label={t('footer.lang_title')}
            className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 border-t border-ink-line-soft pt-5"
          >
            {SEO_READY_LOCALES.map((locale) => (
              <a
                key={locale}
                href={localePath(locale)}
                hrefLang={locale}
                lang={locale}
                className="text-xs text-ink-500 transition-colors duration-100 hover:text-accent-text"
              >
                {LOCALE_LABELS[locale]}
              </a>
            ))}
          </nav>
          <p className="mt-5 text-center text-xs text-ink-500">
            {t('footer.note')}
          </p>
        </PageContainer>
      </footer>

      {/* ── Sticky mobile CTA — thumb zone ─────────────────────── */}
      <div className="landing-sticky-cta md:hidden">
        <div className="flex items-center gap-3">
          <Link href="/onboarding" className="cta-primary !h-12 flex-1 !text-[15px]">
            {t('sticky.cta')}
          </Link>
          <span className="font-mono text-[10px] uppercase leading-tight tracking-[0.08em] text-ink-500">
            {t('sticky.note')}
          </span>
        </div>
      </div>
    </div>
  );
}

// Color-coded mono tag chip — SCOUT / MATCH / DRAFT / QUEUE / HOLD /
// SUBMIT / DIGEST. Variants live in styles/landing.css.
function Tag({ variant, label }: { variant: TagVariant; label: string }) {
  return <span className={`log-tag log-tag--${variant}`}>{label}</span>;
}
