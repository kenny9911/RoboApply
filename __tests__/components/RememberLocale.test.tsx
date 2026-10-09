// Opening a localized landing URL stores its language, so /signup, /login and
// the app that follow stay in it rather than reverting to an older cookie or
// the browser's language.

import { afterEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { RememberLocale } from '../../components/landing/RememberLocale';
import { getCookieLocale, setLocaleCookie } from '../../lib/locale';

afterEach(() => {
  document.cookie = 'robo_locale=; path=/; max-age=0';
});

describe('RememberLocale', () => {
  it('replaces an older language choice with the landing page language', () => {
    setLocaleCookie('zh');
    render(<RememberLocale locale="en" />);
    expect(getCookieLocale()).toBe('en');
  });

  it('stores the landing page language when there is no choice yet', () => {
    render(<RememberLocale locale="ja" />);
    expect(getCookieLocale()).toBe('ja');
  });
});
