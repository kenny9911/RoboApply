// server/src/features/support/email.ts
//
// `support.contact` — the message a visitor sends from /help, delivered to
// the brand's support inbox (F-TRUST-07). The reader is our own support
// staff, not the visitor, so the template carries plain English labels and
// no bundle strings; everything the visitor typed is escaped. Transactional:
// no unsubscribe list, no preference gate.

import { defineEmailTemplate, escapeHtml, paragraph } from '../../platform/email/index.js';
import type { SupportTopic } from './contract.js';

export interface SupportContactEmailParams {
  /** The visitor's reply address (also shown in the body; the From is the brand). */
  replyEmail: string;
  name: string | null;
  topic: SupportTopic;
  message: string;
  pageUrl: string | null;
  locale: string | null;
  /** Signed-in account, when there was a session. */
  userId: string | null;
}

export const SUPPORT_CONTACT_TEMPLATE = 'support.contact';

function lines(p: SupportContactEmailParams): Array<[string, string]> {
  return [
    ['From', p.name ? `${p.name} <${p.replyEmail}>` : p.replyEmail],
    ['Topic', p.topic],
    ['Account', p.userId ?? 'not signed in'],
    ['Page', p.pageUrl ?? '—'],
    ['Language', p.locale ?? '—'],
  ];
}

export const supportContactEmail = defineEmailTemplate<SupportContactEmailParams>({
  key: SUPPORT_CONTACT_TEMPLATE,
  category: 'transactional',
  render: ({ brand, params }) => {
    const meta = lines(params);
    // The platform sets Reply-To to the brand inbox (no per-message Reply-To
    // yet; requested from the email owner), so the visitor's address leads the
    // subject: staff see whom to answer straight from the inbox list. The
    // address passed schema validation (no line breaks).
    const subject = `[${brand.name} support] ${params.replyEmail} · ${params.topic}: ${params.message.replace(/\s+/g, ' ').slice(0, 60)}`;
    const metaHtml = meta.map(([k, v]) => paragraph(`${k}: ${v}`)).join('');
    const bodyHtml = `${metaHtml}<pre style="white-space:pre-wrap;font-family:inherit;font-size:15px;line-height:1.6;margin:16px 0 0;">${escapeHtml(params.message)}</pre>`;
    const bodyText = `${meta.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${params.message}`;
    return {
      subject,
      bodyHtml,
      bodyText,
      reasonText: `Sent from the ${brand.name} support form. Reply to ${params.replyEmail}.`,
    };
  },
});
