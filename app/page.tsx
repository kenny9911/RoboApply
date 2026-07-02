'use client';

// Landing — public marketing. Single hero: "We apply. You interview."
// 3 feature cards, trust strip, pricing strip, footer.
//
// Dark brand surface (electric-lime accent on near-black) — matches the
// signed-in app (:root is dark; see app/globals.css + styles/tokens.css).
// Surfaces use `bg-bg-card` (--surface), text uses the ink-* scale (light on
// dark). Do NOT hardcode bg-white here — the app is dark by default, so a
// white panel renders light ink on white = invisible (the bug this replaced).

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  MoonIcon,
  PencilSquareIcon,
  PaperAirplaneIcon,
} from '@heroicons/react/24/outline';

import { Logo } from '../components/chrome/Logo';
import { PageContainer } from '../components/ui/PageContainer';
import { RoboButton } from '../components/ui/RoboButton';

export default function LandingPage() {
  const t = useTranslations('landing');
  const tCommon = useTranslations('common');

  return (
    <main className="min-h-screen bg-bg-page">
      {/* Header */}
      <header className="border-b border-ink-line bg-bg-page">
        <PageContainer
          maxWidth="wide"
          className="flex items-center justify-between !py-5"
        >
          <Logo />
          <Link
            href="/login"
            className="text-sm font-semibold text-accent-text hover:underline"
          >
            {tCommon('sign_in')}
          </Link>
        </PageContainer>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        {/* Ambient brand wash behind the hero (accent + violet radial glows). */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0"
          style={{ background: 'var(--grad-page-wash)' }}
        />
        <PageContainer
          maxWidth="content"
          className="relative z-10 flex flex-col items-center text-center !pt-20 !pb-24 md:!pt-28 md:!pb-32"
        >
          <h1
            className="text-4xl font-bold text-ink-900 md:text-6xl lg:text-7xl"
            style={{ letterSpacing: '-0.025em', lineHeight: 1.05 }}
          >
            {t('headline')}
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-ink-700 md:text-xl">
            {t('subheadline')}
          </p>
          <div className="mt-10">
            <Link href="/onboarding">
              <RoboButton size="lg">{t('cta_get_started')}</RoboButton>
            </Link>
          </div>
        </PageContainer>
      </section>

      {/* Features */}
      <section className="py-12 md:py-20">
        <PageContainer maxWidth="wide">
          <div className="grid gap-6 md:grid-cols-3">
            <FeatureCard
              icon={<MoonIcon className="h-6 w-6 text-accent-text" />}
              title={t('features.scout_title')}
              body={t('features.scout_body')}
            />
            <FeatureCard
              icon={<PencilSquareIcon className="h-6 w-6 text-accent-text" />}
              title={t('features.tailor_title')}
              body={t('features.tailor_body')}
            />
            <FeatureCard
              icon={<PaperAirplaneIcon className="h-6 w-6 text-accent-text" />}
              title={t('features.submit_title')}
              body={t('features.submit_body')}
            />
          </div>
        </PageContainer>
      </section>

      {/* Trust strip */}
      <section className="border-y border-ink-line bg-bg-muted">
        <PageContainer maxWidth="content" className="!py-10 text-center">
          <p className="text-sm font-medium text-ink-700 md:text-base">
            {t('trust_strip')}
          </p>
        </PageContainer>
      </section>

      {/* Pricing */}
      <section className="py-16 md:py-24">
        <PageContainer maxWidth="content">
          <h2
            className="text-center text-2xl font-bold text-ink-900 md:text-3xl"
            style={{ letterSpacing: '-0.015em' }}
          >
            {t('pricing.title')}
          </h2>
          <div className="mt-8 grid gap-3 text-center md:grid-cols-3">
            <PricingPill label={t('pricing.free')} />
            <PricingPill label={t('pricing.premium')} highlighted />
            <PricingPill label={t('pricing.premium_plus')} />
          </div>
          <div className="mt-10 flex justify-center">
            <Link href="/onboarding">
              <RoboButton size="lg">{t('cta_get_started')}</RoboButton>
            </Link>
          </div>
        </PageContainer>
      </section>

      {/* Footer */}
      <footer className="border-t border-ink-line bg-bg-page">
        <PageContainer
          maxWidth="wide"
          className="flex flex-col items-center justify-between gap-4 !py-8 text-xs text-ink-500 md:flex-row"
        >
          <Logo size="sm" />
          <p>{t('footer_note')}</p>
        </PageContainer>
      </footer>
    </main>
  );
}

function FeatureCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="group rounded-lg border border-ink-line-soft bg-bg-card p-8 text-left transition duration-200 hover:-translate-y-0.5 hover:border-accent-text hover:shadow-cta">
      <div className="flex h-12 w-12 items-center justify-center rounded-md bg-accent-50">
        {icon}
      </div>
      <h3
        className="mt-5 text-lg font-semibold text-ink-900"
        style={{ letterSpacing: '-0.015em' }}
      >
        {title}
      </h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-700">{body}</p>
    </div>
  );
}

function PricingPill({
  label,
  highlighted = false,
}: {
  label: string;
  highlighted?: boolean;
}) {
  return (
    <div
      className={
        highlighted
          ? 'rounded-md border border-accent-text bg-accent-50 px-5 py-4 text-sm font-semibold text-accent-text shadow-cta'
          : 'rounded-md border border-ink-line bg-bg-card px-5 py-4 text-sm text-ink-700'
      }
    >
      {label}
    </div>
  );
}
