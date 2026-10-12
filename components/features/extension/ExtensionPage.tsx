'use client';

// ExtensionPage — /extension (PRODUCT_PLAN.md F-EXT-02, F-ACCT-03;
// ARCHITECTURE.md §6.3): what the extension does and does not do, the
// three-state setup card with install / version check / connect, and the
// in-context sensitive-answers consent. Public page inside HybridShell:
// signed-out visitors get the explanation, the install link and "Sign in".
//
// D1 copy: the extension fills; the user checks every field and submits.
// Nothing here is shown when the brand has no published extension or the
// `extension` capability is off (no UI for a disabled feature, R-04).

import { useLocale, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import { WechatBrowserBanner } from '../auth-cn';
import { useAuth } from '../../../lib/auth/useAuth';
import { useCapabilities } from '../../../lib/flags';
import { useBrandId } from '../../../lib/brand/BrandProvider';
import { EXTENSION_ATS_BY_BRAND, extensionIdFor, extensionStoreUrl } from '../../../hooks/extension';
import { ExtensionStatusCard } from './ExtensionStatusCard';
import { SensitiveFillConsent } from './SensitiveFillConsent';
import s from './extension.module.css';

/** "A, B and C" in the page's language. */
function listFormat(locale: string, items: string[]): string {
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

export function ExtensionPage() {
  const t = useTranslations('extensionWeb');
  const brand = useBrandId();
  const { status } = useAuth();
  const { flags } = useCapabilities();
  const published = !!extensionIdFor(brand);
  const storeUrl = extensionStoreUrl(brand);
  const locale = useLocale();
  const atsNames = (EXTENSION_ATS_BY_BRAND[brand] ?? []).map((a) => a.name);
  const sites = atsNames.length ? listFormat(locale, atsNames) : null;

  if (!flags) return null;
  if (flags.extension !== true || !published) {
    return (
      <div className={s.page}>
        <section className={s.hero}>
          <h1 className={s.title}>{t('page.title')}</h1>
          <p className={s.lead}>{t('page.unavailable')}</p>
        </section>
      </div>
    );
  }

  const signedIn = status === 'authenticated';
  return (
    <div className={s.page}>
      <section className={s.hero} aria-labelledby="ext-title">
        <h1 className={s.title} id="ext-title">
          {t('page.title')}
        </h1>
        <p className={s.lead}>{t('page.intro')}</p>
      </section>
      <WechatBrowserBanner action="extension" />

      <div className={s.columns}>
        <div className={s.stack}>
          <section className={s.card} aria-labelledby="ext-how">
            <h2 className={s.cardSub} id="ext-how">
              {t('page.howTitle')}
            </h2>
            <ol className={s.steps}>
              <li>{t('page.how.step1')}</li>
              <li>{t('page.how.step2')}</li>
              <li>{t('page.how.step3')}</li>
              <li>{t('page.how.step4')}</li>
            </ol>
          </section>
          <section className={s.card} aria-labelledby="ext-privacy">
            <h2 className={s.cardSub} id="ext-privacy">
              {t('page.privacyTitle')}
            </h2>
            <p className={s.body}>{t('page.privacy')}</p>
            <h3 className={s.cardSub}>{t('page.factsTitle')}</h3>
            <p className={s.body}>{t('page.facts')}</p>
            {sites ? (
              <>
                <h3 className={s.cardSub}>{t('page.sitesTitle')}</h3>
                <p className={s.body}>{t('page.sites', { sites })}</p>
              </>
            ) : null}
          </section>
        </div>

        <div className={s.stack}>
          {signedIn ? (
            <>
              <ExtensionStatusCard />
              <SensitiveFillConsent />
            </>
          ) : status === 'loading' ? null : (
            <section className={s.status} aria-labelledby="ext-signed-out">
              <h2 className={s.cardTitle} id="ext-signed-out">
                {t('page.signedOutTitle')}
              </h2>
              <p className={s.body}>{t('page.signedOut')}</p>
              <div className={s.actions}>
                {storeUrl ? (
                  <Btn as="a" href={storeUrl} target="_blank" rel="noopener noreferrer" variant="primary">
                    {t('status.install.cta')}
                  </Btn>
                ) : null}
                <Btn as="a" href="/login?next=%2Fextension">
                  {t('page.signIn')}
                </Btn>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

export default ExtensionPage;
