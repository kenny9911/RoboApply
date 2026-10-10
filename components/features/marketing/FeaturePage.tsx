'use client';

// /features/[slug] — one landing template for every feature page (F-MKT-01,
// F-MKT-03; PRODUCT §3.2): hero, a capability sample labelled "Example", how
// it works, FAQ (FAQPage JSON-LD from the page), CTA.
//
// A gated feature (capability off, extension not published, people data not
// opted in) has no UI entry (R-04): its body renders only once the flag is
// known to be on; when it is off the page says it isn't available.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { FEATURE_FAQ_KEYS, type FeatureDef } from './catalog';
import { useCapabilities } from '../../../lib/flags';
import { ExampleFrame, Faq } from './Sections';
import { SignupLink } from './SignupLink';
import { useFeatureVisible } from './SiteChrome';
import styles from './marketing.module.css';

const STEPS = ['s1', 's2', 's3'] as const;
const SAMPLE_LINES = ['line1', 'line2', 'line3'] as const;

function FeatureBody({ def }: { def: FeatureDef }) {
  const t = useTranslations(`landing.features.${def.brand}.${def.key}`);
  const tc = useTranslations('landing.features.common');
  const cta = useTranslations('landing.cta');
  const from = `feature:${def.slug}`;
  return (
    <>
      <section className={styles.hero} aria-labelledby="feature-title">
        <div className={`${styles.wrap} ${styles.heroGrid}`}>
          <div>
            <p className={styles.eyebrow}>{t('eyebrow')}</p>
            <h1 className={styles.pageTitle} id="feature-title">
              {t('title')}
            </h1>
            <p className={styles.heroSub}>{t('sub')}</p>
            <div className={styles.actions}>
              <SignupLink from={from}>{cta('start')}</SignupLink>
            </div>
          </div>
          <ExampleFrame title={t('eyebrow')}>
            {SAMPLE_LINES.map((k, i) => (
              <p key={k} className={i === 1 ? styles.sampleGap : styles.sampleLine}>
                {t(`sample.${k}`)}
              </p>
            ))}
          </ExampleFrame>
        </div>
      </section>
      <section className={styles.section} aria-labelledby="feature-how-title">
        <div className={styles.wrap}>
          <h2 className={styles.h2} id="feature-how-title">
            {tc('howTitle')}
          </h2>
          <ol className={`${styles.grid3} ${styles.plainList}`}>
            {STEPS.map((k, i) => (
              <li key={k} className={styles.card}>
                <span className={styles.stepNumber}>{String(i + 1).padStart(2, '0')}</span>
                <h3 className={styles.h3}>{t(`${k}.title`)}</h3>
                <p className={styles.body}>{t(`${k}.body`)}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>
      <Faq id="feature-faq" title={tc('faqTitle')} items={FEATURE_FAQ_KEYS.map((k) => ({ q: t(`${k}.q`), a: t(`${k}.a`) }))} />
      <section className={styles.sectionAlt} aria-labelledby="feature-cta-title">
        <div className={`${styles.wrap} ${styles.narrow}`}>
          <h2 className={styles.h2} id="feature-cta-title">
            {tc('ctaTitle')}
          </h2>
          <div className={`${styles.actions} ${styles.spaced}`}>
            <SignupLink from={from}>{cta('createAccount')}</SignupLink>
            <Link className={styles.textLink} href="/#features">
              {tc('allFeatures')}
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

function Unavailable() {
  const tc = useTranslations('landing.features.common');
  return (
    <section className={styles.section} data-feature-unavailable="">
      <div className={`${styles.wrap} ${styles.narrow}`}>
        <h1 className={styles.pageTitle}>{tc('unavailable')}</h1>
        <div className={`${styles.actions} ${styles.spaced}`}>
          <Link className={styles.ctaSecondary} href="/">
            {tc('backHome')}
          </Link>
        </div>
      </div>
    </section>
  );
}

export function FeaturePage({ def }: { def: FeatureDef }) {
  const visible = useFeatureVisible(def);
  const { status } = useCapabilities();
  if (def.gate === null || visible) return <FeatureBody def={def} />;
  // Fail closed: nothing until the capabilities are known, then "not available".
  if (status === 'loading') return <div className={styles.section} aria-busy="true" />;
  return <Unavailable />;
}
