// server/src/features/compliance/emails.ts — email templates of the compliance area.
//
// Registered on import (workers.ts imports this module, and the queue
// registry imports every area's workers.ts, so the email worker sees it).
// Strings: server/src/i18n/email/staging/compliance.en.json (English; INT
// merges and translates them; keys below). The link opens Settings → Privacy,
// where the signed-in user downloads the file — no file link in the email.

import { button, defineEmailTemplate, heading, paragraph } from '../../platform/email/index.js';

export const DATA_EXPORT_READY_TEMPLATE = 'compliance.data_export_ready';

export const COMPLIANCE_EMAIL_KEYS = [
  'compliance.dataExport.subject',
  'compliance.dataExport.heading',
  'compliance.dataExport.body',
  'compliance.dataExport.cta',
] as const;

export interface DataExportReadyParams {
  /** Days the file stays available. */
  days: number;
}

export const dataExportReadyEmail = defineEmailTemplate<DataExportReadyParams>({
  key: DATA_EXPORT_READY_TEMPLATE,
  category: 'transactional',
  render: ({ t, params, origin }) => {
    const url = `${origin}/settings#privacy`;
    const body = t('compliance.dataExport.body', { days: params.days });
    return {
      subject: t('compliance.dataExport.subject'),
      bodyHtml: heading(t('compliance.dataExport.heading')) + paragraph(body) + button(t('compliance.dataExport.cta'), url),
      bodyText: `${t('compliance.dataExport.heading')}\n\n${body}\n\n${url}`,
    };
  },
});
