// server/src/platform/email/templates/auth/index.ts
//
// Auth emails (WP-10; PRODUCT_PLAN.md §7.3 rows 1 and 12; F-NOTIF-05,
// F-TRUST-01, F-ACCT-06). All are transactional: no unsubscribe link, the
// shell's "about your account" reason line. Strings: server/src/i18n/email/
// staging/auth.en.json (`auth.*`), substituted per brand. Links always use
// the brand's canonical origin passed by EmailService.

import { button, heading, paragraph } from '../_shell.js';
import { defineEmailTemplate } from '../registry.js';

export const AUTH_EMAIL_KEYS = {
  passwordReset: 'auth.password_reset',
  emailVerify: 'auth.email_verify',
  oauthEmail: 'auth.oauth_email_verify',
  newDevice: 'auth.new_device',
  otherBrand: 'auth.other_brand_notice',
  accountDeleted: 'auth.account_deleted',
} as const;

/** Relative path (`/reset-password/<token>`) joined to the brand origin. */
function link(origin: string, path: string): string {
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}

export const passwordResetEmail = defineEmailTemplate<{ path: string }>({
  key: AUTH_EMAIL_KEYS.passwordReset,
  category: 'transactional',
  render: ({ t, params, origin }) => {
    const url = link(origin, params.path);
    return {
      subject: t('auth.passwordReset.subject'),
      preheader: t('auth.passwordReset.preheader'),
      bodyHtml:
        heading(t('auth.passwordReset.heading')) +
        paragraph(t('auth.passwordReset.body')) +
        button(t('auth.passwordReset.cta'), url) +
        paragraph(t('auth.passwordReset.sessions')) +
        paragraph(t('auth.passwordReset.ignore')),
      bodyText: [
        t('auth.passwordReset.heading'),
        t('auth.passwordReset.body'),
        url,
        t('auth.passwordReset.sessions'),
        t('auth.passwordReset.ignore'),
      ].join('\n\n'),
    };
  },
});

export const emailVerifyEmail = defineEmailTemplate<{ path: string }>({
  key: AUTH_EMAIL_KEYS.emailVerify,
  category: 'transactional',
  render: ({ t, params, origin }) => {
    const url = link(origin, params.path);
    return {
      subject: t('auth.emailVerify.subject'),
      preheader: t('auth.emailVerify.preheader'),
      bodyHtml:
        heading(t('auth.emailVerify.heading')) +
        paragraph(t('auth.emailVerify.body')) +
        button(t('auth.emailVerify.cta'), url) +
        paragraph(t('auth.emailVerify.expiry')),
      bodyText: [t('auth.emailVerify.heading'), t('auth.emailVerify.body'), url, t('auth.emailVerify.expiry')].join('\n\n'),
    };
  },
});

export const oauthEmailVerifyEmail = defineEmailTemplate<{ path: string }>({
  key: AUTH_EMAIL_KEYS.oauthEmail,
  category: 'transactional',
  render: ({ t, params, origin }) => {
    const url = link(origin, params.path);
    return {
      subject: t('auth.oauthEmail.subject'),
      preheader: t('auth.oauthEmail.preheader'),
      bodyHtml:
        heading(t('auth.oauthEmail.heading')) +
        paragraph(t('auth.oauthEmail.body')) +
        button(t('auth.oauthEmail.cta'), url) +
        paragraph(t('auth.oauthEmail.ignore')),
      bodyText: [t('auth.oauthEmail.heading'), t('auth.oauthEmail.body'), url, t('auth.oauthEmail.ignore')].join('\n\n'),
    };
  },
});

export const newDeviceEmail = defineEmailTemplate<{ browser: string; os: string; at: string }>({
  key: AUTH_EMAIL_KEYS.newDevice,
  category: 'transactional',
  render: ({ t, params, origin }) => {
    const p = { browser: params.browser, os: params.os, time: params.at };
    const url = link(origin, '/forgot-password');
    return {
      subject: t('auth.newDevice.subject'),
      preheader: t('auth.newDevice.preheader', p),
      bodyHtml:
        heading(t('auth.newDevice.heading')) +
        paragraph(t('auth.newDevice.body', p)) +
        paragraph(t('auth.newDevice.ifYou')) +
        paragraph(t('auth.newDevice.ifNot')) +
        button(t('auth.newDevice.cta'), url),
      bodyText: [
        t('auth.newDevice.heading'),
        t('auth.newDevice.body', p),
        t('auth.newDevice.ifYou'),
        t('auth.newDevice.ifNot'),
        url,
      ].join('\n\n'),
    };
  },
});

/**
 * Sent by the brand the visitor signed up on, naming the brand that holds the
 * account (H34: signup never reveals it on screen). `otherOrigin` is the
 * other brand's canonical origin.
 */
export const otherBrandNoticeEmail = defineEmailTemplate<{ otherOrigin: string }>({
  key: AUTH_EMAIL_KEYS.otherBrand,
  category: 'transactional',
  render: ({ t, params }) => {
    const url = link(params.otherOrigin, '/login');
    return {
      subject: t('auth.otherBrand.subject'),
      bodyHtml:
        heading(t('auth.otherBrand.heading')) +
        paragraph(t('auth.otherBrand.body')) +
        paragraph(t('auth.otherBrand.useOther')) +
        button(t('auth.otherBrand.cta'), url) +
        paragraph(t('auth.otherBrand.ignore')),
      bodyText: [t('auth.otherBrand.heading'), t('auth.otherBrand.body'), t('auth.otherBrand.useOther'), url, t('auth.otherBrand.ignore')].join(
        '\n\n',
      ),
    };
  },
});

export const accountDeletedEmail = defineEmailTemplate<{ days: number }>({
  key: AUTH_EMAIL_KEYS.accountDeleted,
  category: 'transactional',
  render: ({ t, params }) => ({
    subject: t('auth.accountDeleted.subject'),
    bodyHtml:
      heading(t('auth.accountDeleted.heading')) +
      paragraph(t('auth.accountDeleted.body')) +
      paragraph(t('auth.accountDeleted.when', { days: params.days })) +
      paragraph(t('auth.accountDeleted.notYou')),
    bodyText: [
      t('auth.accountDeleted.heading'),
      t('auth.accountDeleted.body'),
      t('auth.accountDeleted.when', { days: params.days }),
      t('auth.accountDeleted.notYou'),
    ].join('\n\n'),
  }),
});
