// server/src/features/account-v2/emails.ts
//
// Account V2 emails. Transactional: the student verification code (sent to
// the school address the user typed). Strings: `accountV2.*` in
// server/src/i18n/email/staging/accountV2.en.json — proposed in
// ./i18n/email.accountV2.en.json until INT moves it there (WP-79 handoff).

import { heading, paragraph } from '../../platform/email/templates/_shell.js';
import { defineEmailTemplate } from '../../platform/email/templates/registry.js';
import { STUDENT_CODE_EMAIL } from './student.js';

export const studentCodeEmail = defineEmailTemplate<{ code: string; minutes: number }>({
  key: STUDENT_CODE_EMAIL,
  category: 'transactional',
  render: ({ t, params }) => ({
    subject: t('accountV2.studentCode.subject', { code: params.code }),
    preheader: t('accountV2.studentCode.preheader'),
    bodyHtml:
      heading(t('accountV2.studentCode.heading')) +
      paragraph(t('accountV2.studentCode.body', { minutes: params.minutes })) +
      paragraph(t('accountV2.studentCode.codeLine', { code: params.code })) +
      paragraph(t('accountV2.studentCode.ignore')),
    bodyText: [
      t('accountV2.studentCode.heading'),
      t('accountV2.studentCode.body', { minutes: params.minutes }),
      t('accountV2.studentCode.codeLine', { code: params.code }),
      t('accountV2.studentCode.ignore'),
    ].join('\n\n'),
  }),
});
