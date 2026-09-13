'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { PageContainer } from '../ui/PageContainer';
import { BrandSymbol } from '../chrome/BrandSymbol';
import {
  LOCALE_LABELS,
  SEO_READY_LOCALES,
  isLocale,
  localePath,
} from '../../lib/localeConfig';
import { LanguageMenu } from './LanguageMenu';
import { ThemeToggle } from './ThemeToggle';
import {
  MARKET_CURRENCY,
  formatMoney,
  planPriceMinor,
  type BillingMarket,
} from '../../lib/pricing';

const STEPS = ['s1', 's2', 's3', 's4'] as const;
const LOOP_CARDS = ['match', 'resume', 'apply', 'studio'] as const;
const STUDIO_FEATURES = ['f1', 'f2', 'f3', 'f4', 'f5'] as const;
const REPORT_ROWS = [
  { key: 'r1', width: '86%' },
  { key: 'r2', width: '78%' },
  { key: 'r3', width: '84%' },
] as const;
const TIERS = ['free', 'starter', 'growth'] as const;
const FAQ_ITEMS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8'] as const;
type PreviewStep = (typeof STEPS)[number];

function Arrow({ down = false }: { down?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={down ? { transform: 'rotate(90deg)' } : undefined}
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function BrandWordmark() {
  return (
    <span className="landing-wordmark">
      <span className="landing-brand-symbol" aria-hidden="true">
        <BrandSymbol size={23} />
      </span>
      RoboApply
      <span className="landing-wordmark-period" aria-hidden="true">
        .
      </span>
    </span>
  );
}

function SectionHeading({
  section,
  number,
}: {
  section: 'problem' | 'how' | 'loop' | 'rules' | 'pricing' | 'faq';
  number: string;
}) {
  const t = useTranslations('landing');
  return (
    <div className="landing-section-heading">
      <p className="landing-eyebrow">
        <span>{number}</span>
        {t(`${section}.eyebrow`)}
      </p>
      <h2>{t(`${section}.title`)}</h2>
      {section !== 'faq' && (
        <p className="landing-section-description">{t(`${section}.sub`)}</p>
      )}
    </div>
  );
}

function FeatureIcon({ index }: { index: number }) {
  const paths = [
    <g key="find">
      <circle cx="10.5" cy="10.5" r="5.5" />
      <path d="m15 15 5 5M8 10.5h5M10.5 8v5" />
    </g>,
    <g key="resume">
      <path d="M14 3H5v18h14V8l-5-5Z M14 3v5h5M8 12h8M8 16h5" />
    </g>,
    <g key="track">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 4v16M5.5 8h1M11.5 11h1M17.5 8h1" />
    </g>,
    <g key="practice">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
    </g>,
  ];
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[index]}
    </svg>
  );
}

/** The preview uses the same evidence hierarchy as the product. All figures
 * are explicitly sample data, and the explanation travels with the score. */
function ProductPreview() {
  const t = useTranslations('landing');
  const [step, setStep] = useState<PreviewStep>('s2');
  const panelId = useId();
  return (
    <div
      className="landing-preview-stage anim-rise"
      style={{ animationDelay: '.18s' }}
    >
      <div className="landing-preview-orbit" aria-hidden="true">
        <svg viewBox="0 0 500 500" fill="none">
          <path
            d="M-20 330C85 105 440 24 478 184c40 169-311 331-389 183C10 218 258 40 410 91"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <path d="m405 79 8 14-16 5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </div>
      <div className="landing-preview">
        <div className="landing-preview-toolbar">
          <span className="landing-preview-title">{t('hero.log.title')}</span>
          <span className="sample-chip">
            <span aria-hidden="true" />
            {t('hero.log.live')}
          </span>
        </div>
        <div className="landing-preview-nav" aria-label={t('how.title')}>
          {STEPS.map((key, i) => (
            <button
              type="button"
              key={key}
              aria-pressed={step === key}
              aria-controls={panelId}
              onClick={() => setStep(key)}
            >
              <span className="landing-preview-step" aria-hidden="true">
                0{i + 1}
              </span>
              {t(`how.steps.${key}.tag`)}
            </button>
          ))}
        </div>
        <div className="landing-preview-content" id={panelId}>
          <div className="landing-preview-context">
            <span className="landing-preview-avatar" aria-hidden="true">
              <FeatureIcon index={step === 's4' ? 3 : 1} />
            </span>
            <p>{t('hero.log.lines.l1.msg')}</p>
          </div>
          {step === 's1' ? (
            <div className="landing-preview-view">
              <div className="landing-preview-market">
                <span>1,284</span>
                <p>{t('hero.log.lines.l2.msg')}</p>
              </div>
              <div className="landing-preview-insight">
                <span className="landing-insight-mark" aria-hidden="true">
                  ↗
                </span>
                <p>{t('hero.log.lines.l3.msg')}</p>
              </div>
              <p className="landing-preview-note">
                {t('hero.log.lines.l6.msg')}
              </p>
            </div>
          ) : null}
          {step === 's2' ? (
            <div className="landing-preview-view">
              <div className="landing-match-summary">
                <div className="landing-match-score">
                  <span>87</span>
                  <small>/ 100</small>
                </div>
                <p>{t('hero.log.lines.l7.msg')}</p>
              </div>
              <div className="landing-evidence">
                <span className="landing-evidence-tag">
                  {t('hero.log.lines.l4.tag')}
                </span>
                <p>{t('hero.log.lines.l4.msg')}</p>
              </div>
              <div className="landing-evidence">
                <span className="landing-evidence-tag">
                  {t('hero.log.lines.l5.tag')}
                </span>
                <p>{t('hero.log.lines.l5.msg')}</p>
              </div>
            </div>
          ) : null}
          {step === 's3' ? (
            <div className="landing-preview-view">
              <div className="landing-preview-insight">
                <span className="landing-insight-mark" aria-hidden="true">
                  <FeatureIcon index={1} />
                </span>
                <p>{t('hero.log.lines.l8.msg')}</p>
              </div>
              <div className="landing-preview-document" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
                <span />
              </div>
              <p className="landing-preview-note">{t('how.steps.s3.body')}</p>
            </div>
          ) : null}
          {step === 's4' ? (
            <div className="landing-preview-view">
              <div className="landing-preview-wave" aria-hidden="true">
                {[
                  18, 30, 45, 25, 56, 36, 68, 48, 25, 45, 64, 38, 22, 46, 30,
                  17,
                ].map((height, i) => (
                  <span key={i} style={{ height }} />
                ))}
              </div>
              <div className="landing-preview-insight">
                <span className="landing-insight-mark" aria-hidden="true">
                  <FeatureIcon index={3} />
                </span>
                <p>{t('hero.log.lines.l9.msg')}</p>
              </div>
              <p className="landing-preview-note">
                {t('studio.features.f3.body')}
              </p>
            </div>
          ) : null}
        </div>
        <div className="landing-preview-footer">
          <span className="landing-preview-check" aria-hidden="true">
            ✓
          </span>
          {t('rules.items.r3_head')}
        </div>
      </div>
      <div className="landing-preview-caption">
        <span aria-hidden="true">↳</span>
        {t('hero.strip_summary')}
      </div>
      <p className="sr-only">{t('hero.log.aria')}</p>
    </div>
  );
}

function InterviewReport() {
  const t = useTranslations('landing');
  return (
    <div className="landing-report-stage">
      <div className="landing-report-wave" aria-hidden="true">
        {[
          20, 38, 26, 54, 78, 44, 94, 60, 40, 72, 96, 50, 30, 68, 48, 80, 32,
          54, 28, 18,
        ].map((height, i) => (
          <span key={i} style={{ height }} />
        ))}
      </div>
      <div className="landing-report">
        <div className="landing-report-header">
          <span>{t('studio.report.header')}</span>
          <span className="sample-chip">{t('hero.log.live')}</span>
        </div>
        <div className="landing-report-overall">
          <span>{t('studio.report.overall')}</span>
          <p>{t('studio.report.overall_label')}</p>
        </div>
        <div className="landing-report-rows">
          {REPORT_ROWS.map(({ key, width }) => (
            <div key={key}>
              <div className="landing-report-row-label">
                <span>{t(`studio.report.rows.${key}.k`)}</span>
                <strong>{t(`studio.report.rows.${key}.v`)}</strong>
              </div>
              <div className="report-bar">
                <span className="report-bar-fill" style={{ width }} />
              </div>
            </div>
          ))}
        </div>
        <blockquote>{t('studio.report.quote')}</blockquote>
        <p className="landing-report-attribution">
          {t('studio.report.quote_label')}
        </p>
      </div>
    </div>
  );
}

export interface LandingContentProps {
  market?: BillingMarket;
}

export function LandingContent({ market = 'other' }: LandingContentProps) {
  const locale = useLocale();
  const t = useTranslations('landing');
  const tCommon = useTranslations('common');
  return (
    <div className="landing-root">
      <header className="landing-header">
        <PageContainer maxWidth="wide" className="landing-header-inner">
          <a
            href={localePath(isLocale(locale) ? locale : 'en')}
            aria-label="RoboApply"
          >
            <BrandWordmark />
          </a>
          <nav className="landing-main-nav" aria-label={t('how.eyebrow')}>
            <a href="#how">{t('how.eyebrow')}</a>
            <a href="#studio">{t('loop.cards.studio.tag')}</a>
            <a href="#pricing">{t('pricing.eyebrow')}</a>
          </nav>
          <div className="landing-header-actions">
            <LanguageMenu label={t('header.lang_label')} />
            <ThemeToggle />
            <Link href="/login" className="landing-sign-in">
              {tCommon('sign_in')}
            </Link>
            <Link href="/signup" className="cta-primary landing-header-cta">
              {t('header.cta')}
              <Arrow />
            </Link>
          </div>
        </PageContainer>
      </header>
      <main>
        <section className="hero-fold">
          <PageContainer maxWidth="wide" className="landing-hero-container">
            <div className="landing-hero-copy">
              <p className="hero-eyebrow anim-rise">
                <span aria-hidden="true" />
                {t('hero.eyebrow')}
              </p>
              <h1
                className="hero-h1 anim-rise"
                style={{ animationDelay: '.06s' }}
              >
                {t('hero.headline')}
              </h1>
              <p
                className="landing-hero-description anim-rise"
                style={{ animationDelay: '.1s' }}
              >
                {t('hero.subheadline')}
              </p>
              <p
                className="sub-emph anim-rise"
                style={{ animationDelay: '.13s' }}
              >
                {t('hero.sub_emphasis')}
              </p>
              <div
                className="landing-hero-actions anim-rise"
                style={{ animationDelay: '.16s' }}
              >
                <Link href="/signup" className="cta-primary">
                  {t('hero.cta_primary')}
                  <Arrow />
                </Link>
                <a href="#how" className="cta-quiet">
                  {t('hero.cta_secondary')}
                  <Arrow down />
                </a>
              </div>
              <p className="landing-hero-reassure">{t('hero.reassure')}</p>
            </div>
            <ProductPreview />
          </PageContainer>
          <div className="hero-strip">
            <PageContainer maxWidth="wide" className="hero-strip-row">
              <span>{t('footer.note')}</span>
              <a href="#how">
                {t('hero.strip_scroll')}
                <Arrow down />
              </a>
            </PageContainer>
          </div>
        </section>

        <section id="how" className="landing-section landing-how">
          <PageContainer maxWidth="wide">
            <div className="landing-how-intro">
              <SectionHeading section="how" number="01" />
              <p className="landing-section-aside">{t('loop.sub')}</p>
            </div>
            <div className="landing-steps">
              {STEPS.map((key, i) => (
                <article key={key} className="landing-step">
                  <div className="landing-step-top">
                    <span className="landing-step-number">0{i + 1}</span>
                    <span className="landing-step-label">
                      {t(`how.steps.${key}.tag`)}
                    </span>
                    <Arrow />
                  </div>
                  <h3>{t(`how.steps.${key}.title`)}</h3>
                  <p>{t(`how.steps.${key}.body`)}</p>
                </article>
              ))}
            </div>
          </PageContainer>
        </section>

        <section className="landing-section landing-loop">
          <PageContainer maxWidth="wide">
            <div className="landing-loop-layout">
              <SectionHeading section="loop" number="02" />
              <div className="landing-capabilities">
                {LOOP_CARDS.map((key, i) => (
                  <article key={key} className="landing-capability">
                    <span className="landing-capability-icon">
                      <FeatureIcon index={i} />
                    </span>
                    <div>
                      <p className="landing-capability-tag">
                        {t(`loop.cards.${key}.tag`)}
                      </p>
                      <h3>{t(`loop.cards.${key}.title`)}</h3>
                      <p>{t(`loop.cards.${key}.body`)}</p>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </PageContainer>
        </section>

        <section id="studio" className="landing-section landing-studio">
          <PageContainer maxWidth="wide">
            <div className="landing-studio-layout">
              <div>
                <p className="landing-eyebrow">
                  <span>03</span>
                  {t('studio.eyebrow')}
                </p>
                <h2>
                  {t('studio.title_machine')}. {t('studio.title_human')}.
                </h2>
                <p className="landing-section-description">{t('studio.sub')}</p>
                <Link href="/signup" className="cta-primary landing-studio-cta">
                  {t('studio.cta')}
                  <Arrow />
                </Link>
              </div>
              <InterviewReport />
            </div>
            <div className="landing-studio-features">
              {STUDIO_FEATURES.map((key, i) => (
                <article key={key}>
                  <span>0{i + 1}</span>
                  <h3>{t(`studio.features.${key}.title`)}</h3>
                  <p>{t(`studio.features.${key}.body`)}</p>
                </article>
              ))}
            </div>
          </PageContainer>
        </section>

        <section className="landing-section landing-problem">
          <PageContainer maxWidth="wide">
            <div className="landing-problem-layout">
              <SectionHeading section="problem" number="04" />
              <div className="landing-stats">
                {(['s1', 's2', 's3'] as const).map((key) => (
                  <div key={key}>
                    <p className="stat-number">
                      {t(`problem.stats.${key}.value`)}
                    </p>
                    <p>{t(`problem.stats.${key}.label`)}</p>
                  </div>
                ))}
              </div>
            </div>
            <p className="landing-sources">{t('problem.source')}</p>
          </PageContainer>
        </section>

        <section className="landing-section landing-rules">
          <PageContainer maxWidth="wide">
            <div className="landing-rules-layout">
              <SectionHeading section="rules" number="05" />
              <div>
                <div className="landing-rules-label">
                  <span>{t('rules.file')}</span>
                  <span>{t('rules.badge')}</span>
                </div>
                {(['r1', 'r2', 'r3', 'r4'] as const).map((key, i) => (
                  <article key={key} className="landing-rule">
                    <span aria-hidden="true">0{i + 1}</span>
                    <div>
                      <h3>{t(`rules.items.${key}_head`)}</h3>
                      <p>{t(`rules.items.${key}_body`)}</p>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </PageContainer>
        </section>

        <section id="pricing" className="landing-section landing-pricing">
          <PageContainer maxWidth="wide">
            <SectionHeading section="pricing" number="06" />
            <div className="landing-price-grid">
              {TIERS.map((key) => (
                <article
                  key={key}
                  className={`landing-price-card${key === 'starter' ? ' is-featured' : ''}`}
                >
                  <div className="landing-price-heading">
                    <h3>{t(`pricing.tiers.${key}.name`)}</h3>
                    {key === 'starter' && (
                      <span>{t('pricing.tiers.starter.badge')}</span>
                    )}
                  </div>
                  <div className="landing-price">
                    <strong>
                      {formatMoney(
                        locale,
                        planPriceMinor(key, market),
                        MARKET_CURRENCY[market],
                      )}
                    </strong>
                    <span>{t(`pricing.tiers.${key}.per`)}</span>
                  </div>
                  <p className="landing-price-note">
                    {t(`pricing.tiers.${key}.note`)}
                  </p>
                  <div className="landing-price-credits">
                    <span>{t(`pricing.tiers.${key}.rate`)}</span>
                    <p>{t(`pricing.tiers.${key}.unit`)}</p>
                  </div>
                  <Link
                    href="/signup"
                    className={
                      key === 'starter' ? 'cta-primary' : 'cta-outline'
                    }
                  >
                    {t(`pricing.tiers.${key}.cta`)}
                    <Arrow />
                  </Link>
                </article>
              ))}
            </div>
            <p className="landing-credit-note">{t('pricing.credit_note')}</p>
          </PageContainer>
        </section>

        <section id="faq" className="landing-section landing-faq">
          <PageContainer maxWidth="wide">
            <div className="landing-faq-layout">
              <SectionHeading section="faq" number="07" />
              <div className="landing-faq-answers">
                {FAQ_ITEMS.map((key) => (
                  <article key={key}>
                    <h3>{t(`faq.items.${key}.q`)}</h3>
                    <p>{t(`faq.items.${key}.a`)}</p>
                  </article>
                ))}
              </div>
            </div>
          </PageContainer>
        </section>

        <section className="landing-final">
          <PageContainer maxWidth="wide">
            <div className="landing-final-copy">
              <p className="landing-eyebrow">
                <span aria-hidden="true">↗</span>
                {t('final.chip')}
              </p>
              <h2>
                {t('final.title_machine')} {t('final.title_human')}.
              </h2>
              <p>{t('final.sub')}</p>
            </div>
            <Link href="/signup" className="cta-primary">
              {t('final.cta')}
              <Arrow />
            </Link>
          </PageContainer>
        </section>
      </main>
      <footer className="landing-footer">
        <PageContainer maxWidth="wide">
          <div className="landing-footer-top">
            <BrandWordmark />
            <p>{t('footer.tagline')}</p>
            <span>{t('footer.status')}</span>
          </div>
          <nav
            aria-label={t('footer.lang_title')}
            className="landing-locale-links"
          >
            {SEO_READY_LOCALES.map((language) => (
              <a
                key={language}
                href={localePath(language)}
                hrefLang={language}
                lang={language}
              >
                {LOCALE_LABELS[language]}
              </a>
            ))}
          </nav>
          <p className="landing-footer-note">{t('footer.note')}</p>
        </PageContainer>
      </footer>
      <div className="landing-sticky-cta">
        <Link href="/signup" className="cta-primary">
          {t('sticky.cta')}
          <Arrow />
        </Link>
        <span>{t('sticky.note')}</span>
      </div>
    </div>
  );
}
