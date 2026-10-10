'use client';

// /about, /security, /help, /help/ranking — F-MKT-04, F-TRUST-01, F-TRUST-07,
// WP-32's public "How ranking works" (H14).
//
// Honesty: /about shows the operating entity only when ops configured it
// (LEGAL_ENTITY_NAME / CN_LEGAL_ENTITY_NAME), no team bios, ratings or user
// counts. /security lists only what the code does today (bcrypt password
// hashes, httpOnly secure cookies, new-device sign-in email, DB-backed rate
// limits, export + delete, no third-party pixels, AI routing per brand).
// /help/ranking prints every Recommended factor with its weight.

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { useBrand } from '../../../lib/brand';
import { CancelFooterLink } from '../credits';
import { COMPANY_SPREAD, FIT_PARTS, FIT_TIER_FLOORS, HELP_FAQ_KEYS, RANKING_FACTORS } from './catalog';
import { ContactForm } from './ContactForm';
import { Faq } from './Sections';
import styles from './marketing.module.css';

function Intro({ title, lead, id }: { title: string; lead: string; id: string }) {
  return (
    <section className={styles.intro} aria-labelledby={id}>
      <div className={`${styles.wrap} ${styles.narrow}`}>
        <h1 className={styles.pageTitle} id={id}>
          {title}
        </h1>
        <p className={styles.lead}>{lead}</p>
      </div>
    </section>
  );
}

function Block({ title, children, id }: { title: string; children: ReactNode; id: string }) {
  return (
    <section className={styles.section} aria-labelledby={id}>
      <div className={`${styles.wrap} ${styles.narrow}`}>
        <h2 className={styles.h2} id={id}>
          {title}
        </h2>
        {children}
      </div>
    </section>
  );
}

function MailLink({ email }: { email: string }) {
  return (
    <a className={styles.inlineLink} href={`mailto:${email}`}>
      {email}
    </a>
  );
}

// ── /about ───────────────────────────────────────────────────────────────

export interface AboutPageProps {
  /** Operating entity from config; null → not shown (D3). */
  entity: string | null;
  supportEmail: string;
}

export function AboutPage({ entity, supportEmail }: AboutPageProps) {
  const t = useTranslations('landing.about');
  const brand = useBrand();
  return (
    <>
      <Intro id="about-title" title={t('title')} lead={brand.market === 'cn' ? t('leadCn') : t('lead')} />
      <Block id="about-rules" title={t('rulesTitle')}>
        <ul className={styles.list}>
          {(['rule1', 'rule2', 'rule3', 'rule4', 'rule5'] as const).map((k) => (
            <li key={k}>{t(k)}</li>
          ))}
        </ul>
      </Block>
      <Block id="about-who" title={t('whoTitle')}>
        <p className={styles.body}>{entity ? t('entity', { entity }) : t('noEntity')}</p>
      </Block>
      <Block id="about-contact" title={t('contactTitle')}>
        <p className={styles.body}>{t('contactBody')} <MailLink email={supportEmail} /></p>
        <p className={styles.spaced}>
          <Link className={styles.inlineLink} href="/help">
            {t('helpLink')}
          </Link>
        </p>
      </Block>
    </>
  );
}

// ── /security ────────────────────────────────────────────────────────────

export function SecurityPage({ supportEmail }: { supportEmail: string }) {
  const t = useTranslations('landing.security');
  const brand = useBrand();
  return (
    <>
      <Intro id="security-title" title={t('title')} lead={t('lead')} />
      <Block id="security-account" title={t('accountTitle')}>
        <ul className={styles.list}>
          {(['account1', 'account2', 'account3', 'account4'] as const).map((k) => (
            <li key={k}>{t(k)}</li>
          ))}
        </ul>
      </Block>
      <Block id="security-data" title={t('dataTitle')}>
        <ul className={styles.list}>
          {(['data1', 'data2', 'data3'] as const).map((k) => (
            <li key={k}>{t(k)}</li>
          ))}
        </ul>
      </Block>
      <Block id="security-ai" title={t('aiTitle')}>
        <ul className={styles.list}>
          <li>{brand.market === 'cn' ? t('aiCn') : t('aiIntl')}</li>
          <li>{t('aiSensitive')}</li>
        </ul>
        <p className={styles.spaced}>
          <a className={styles.inlineLink} href={brand.legal.privacyPath}>
            {t('privacyLink')}
          </a>
        </p>
      </Block>
      <Block id="security-report" title={t('reportTitle')}>
        <p className={styles.body}>{t('reportBody')} <MailLink email={supportEmail} /></p>
      </Block>
    </>
  );
}

// ── /help ────────────────────────────────────────────────────────────────


export function HelpPage({ supportEmail }: { supportEmail: string }) {
  const t = useTranslations('landing.help');
  return (
    <>
      <section className={styles.intro} aria-labelledby="help-title">
        <div className={`${styles.wrap} ${styles.narrow}`}>
          <h1 className={styles.pageTitle} id="help-title">
            {t('title')}
          </h1>
          <p className={styles.lead}>{t('sub')}</p>
          <p className={`${styles.body} ${styles.spaced}`}>{t('emailLine')} <MailLink email={supportEmail} /></p>
        </div>
      </section>
      <Faq id="help-faq" title={t('faqTitle')} items={HELP_FAQ_KEYS.map((k) => ({ q: t(`${k}.q`), a: t(`${k}.a`) }))} />
      <Block id="help-links" title={t('linksTitle')}>
        <ul className={styles.footerLinks}>
          <li>
            <Link className={styles.footerLink} href="/help/ranking">
              {t('rankingLink')}
            </Link>
          </li>
          <li>
            <Link className={styles.footerLink} href="/pricing">
              {t('pricingLink')}
            </Link>
          </li>
          <li>
            <Link className={styles.footerLink} href="/security">
              {t('securityLink')}
            </Link>
          </li>
          <li>
            <CancelFooterLink className={styles.footerLink} />
          </li>
        </ul>
      </Block>
      <section className={styles.sectionAlt} id="contact" aria-labelledby="contact-title">
        <div className={`${styles.wrap} ${styles.narrow}`}>
          <ContactForm supportEmail={supportEmail} />
        </div>
      </section>
    </>
  );
}

// ── /help/ranking ────────────────────────────────────────────────────────

export function RankingPage() {
  const t = useTranslations('landing.ranking');
  const brand = useBrand();
  const tiers = FIT_TIER_FLOORS;
  return (
    <>
      <Intro id="ranking-title" title={t('title')} lead={t('lead')} />
      <Block id="ranking-factors" title={t('factorsTitle')}>
        <ol className={`${styles.plainList} ${styles.form}`}>
          {RANKING_FACTORS.map((f) => (
            <li key={f.key} className={styles.card} data-factor={f.key}>
              <h3 className={styles.h3}>{t(`${f.key}.title`)}</h3>
              <p className={styles.stepNumber}>{t('weight', { pct: f.pct })}</p>
              <p className={styles.body}>{t(`${f.key}.body`)}</p>
            </li>
          ))}
        </ol>
      </Block>
      <Block id="ranking-fit" title={t('fitParts.title')}>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <tbody>
              {FIT_PARTS.map((p) => (
                <tr key={p.key}>
                  <th scope="row">{t(`fitParts.${p.key}`)}</th>
                  <td>{t('fitParts.weight', { pct: p.pct })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={`${styles.body} ${styles.spaced}`}>
          {t('fitParts.tiers', {
            great: tiers.great,
            good: tiers.good,
            goodTop: tiers.great - 1,
            possible: tiers.possible,
            possibleTop: tiers.good - 1,
          })}
        </p>
        <p className={styles.muted}>{t('fitParts.notChance')}</p>
      </Block>
      <Block id="ranking-goal" title={t('goalTitle')}>
        <ul className={styles.list}>
          <li>{t('goal1')}</li>
          <li>{t('goal2')}</li>
        </ul>
      </Block>
      <Block id="ranking-spread" title={t('spreadTitle')}>
        <p className={styles.body}>{t('spread', { max: COMPANY_SPREAD.max, window: COMPANY_SPREAD.window })}</p>
      </Block>
      <Block id="ranking-never" title={t('neverTitle')}>
        <ul className={styles.list}>
          {(['never1', 'never2', 'never3', 'never4'] as const).map((k) => (
            <li key={k}>{t(k)}</li>
          ))}
        </ul>
      </Block>
      <Block id="ranking-other" title={t('otherSortsTitle')}>
        <p className={styles.body}>{t('otherSorts')}</p>
        {brand.market === 'cn' ? <p className={`${styles.body} ${styles.spaced}`}>{t('cnNote')}</p> : null}
      </Block>
    </>
  );
}
