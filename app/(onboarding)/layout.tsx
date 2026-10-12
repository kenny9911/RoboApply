'use client';

// (onboarding) route-group layout — the setup screens (/onboarding/<stage>,
// PRODUCT_PLAN.md §4; FND-6b adds the route shells, WP-30/WP-31 the screens).
//
// No rail and no bottom bar: setup is one focused flow. But it sits INSIDE the
// themed canvas — `.dark-canvas` with a <main> child — so shared components
// pick up the dark retint and nothing renders white-on-white in the dark
// theme (the bug that hit the old /onboarding overlay route, fixed in
// 1e5b31f). The header keeps theme, language and the avatar menu, so a user
// with a stale session can always sign out from here.
//
// Gates as in (auth): AuthGate (signed-out → /login?next=…), then
// RoboApplyAccessGate.

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { AuthGate } from '../../components/AuthGate';
import { RoboApplyAccessGate } from '../../components/RoboApplyAccessGate';
import { BrandSymbol } from '../../components/chrome/BrandSymbol';
import { AvatarMenu } from '../../components/v3/shell/AvatarMenu';
import { LanguageSwitcher } from '../../components/v3/shell/LanguageSwitcher';
import { ThemeToggle } from '../../components/v3/shell/ThemeToggle';
import { Toaster } from '../../components/v3/primitives/Toast';
import { useBrand } from '../../lib/brand/BrandProvider';

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  const t = useTranslations('nav');
  const brand = useBrand();
  return (
    <AuthGate>
      <RoboApplyAccessGate>
        <div className="dark-canvas v3-root" data-shell="onboarding" style={{ minHeight: '100vh', background: 'var(--bg)' }}>
          <a className="workspace-skip" href="#main-content">
            {t('skip_content')}
          </a>
          <header className="topbar">
            <div className="crumbs">
              <span className="now" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <BrandSymbol size={20} />
                {brand.name}
              </span>
            </div>
            <div className="top-actions">
              <ThemeToggle />
              <LanguageSwitcher />
              <AvatarMenu />
            </div>
          </header>
          <main id="main-content" tabIndex={-1} className="main-inner">
            {children}
          </main>
          <Toaster />
        </div>
      </RoboApplyAccessGate>
    </AuthGate>
  );
}
