// server/src/platform/email/templates/coaching/index.ts
//
// Coaching emails (TASK_PLAN.md WP-72; PRODUCT_PLAN.md §5.14 F-COACH-01).
// Strings: server/src/i18n/email/staging/coaching.en.json (`coaching.*`,
// English; INT translates into the other locales).
//
//   coaching.booking_request   transactional   a user's request for a session,
//                                              sent to the coach (Reply-To: the
//                                              user) and a copy to staff
//
// The coach agreed to be listed and receives requests by email; the email
// says plainly that the user pays the coach directly and that the platform
// takes no payment for coaching. Everything the user typed is escaped.

import { escapeHtml, heading, paragraph } from '../_shell.js';
import { defineEmailTemplate, type EmailTemplate } from '../registry.js';

export const COACHING_BOOKING_REQUEST_TEMPLATE = 'coaching.booking_request';

export const COACHING_TEMPLATE_KEYS = [COACHING_BOOKING_REQUEST_TEMPLATE] as const;

export interface CoachingRequestEmailParams {
  coachName: string;
  /** The requester's name as they typed it, or null. */
  requesterName: string | null;
  /** Where the coach answers (also the Reply-To). */
  replyEmail: string;
  /**
   * True only when `replyEmail` is the requester's own verified account email.
   * Otherwise the email says the address was typed by the user and not checked.
   */
  replyEmailVerified?: boolean;
  topic: string;
  message: string | null;
  durationMin: number | null;
  preferredTimes: string | null;
  /** 'coach' (the coach's copy) or 'admin' (the staff copy). */
  audience: 'coach' | 'admin';
  /** Staff copy only. */
  coachId?: string | null;
  requesterUserId?: string | null;
}

/** Collapse whitespace and cut, for the subject line. */
function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export const coachingBookingRequestEmail: EmailTemplate<CoachingRequestEmailParams> = defineEmailTemplate<CoachingRequestEmailParams>({
  key: COACHING_BOOKING_REQUEST_TEMPLATE,
  category: 'transactional',
  render: ({ t, params }) => {
    const who = params.requesterName || params.replyEmail;
    const admin = params.audience === 'admin';
    const subject = admin
      ? t('coaching.bookingRequest.subjectAdmin', { coach: oneLine(params.coachName, 60), topic: oneLine(params.topic, 60) })
      : t('coaching.bookingRequest.subject', { name: oneLine(who, 60), topic: oneLine(params.topic, 60) });

    const rows: Array<[string, string]> = [
      [t('coaching.bookingRequest.fieldFrom'), params.requesterName ? `${params.requesterName} <${params.replyEmail}>` : params.replyEmail],
      [t('coaching.bookingRequest.fieldTopic'), params.topic],
      [
        t('coaching.bookingRequest.fieldLength'),
        params.durationMin ? t('coaching.bookingRequest.minutes', { minutes: params.durationMin }) : t('coaching.bookingRequest.notGiven'),
      ],
      [t('coaching.bookingRequest.fieldTimes'), params.preferredTimes || t('coaching.bookingRequest.notGiven')],
    ];
    if (params.replyEmailVerified !== true) {
      rows.splice(1, 0, [t('coaching.bookingRequest.fieldAddress'), t('coaching.bookingRequest.addressUnverified')]);
    }
    if (admin) {
      rows.unshift([t('coaching.bookingRequest.fieldCoach'), params.coachId ? `${params.coachName} (${params.coachId})` : params.coachName]);
      rows.push([t('coaching.bookingRequest.fieldAccount'), params.requesterUserId ?? t('coaching.bookingRequest.notGiven')]);
    }

    const intro = admin
      ? t('coaching.bookingRequest.introAdmin', { coach: params.coachName })
      : t('coaching.bookingRequest.intro', { coach: params.coachName, name: who });
    const next = admin ? t('coaching.bookingRequest.nextAdmin') : t('coaching.bookingRequest.next', { email: params.replyEmail });
    const payment = t('coaching.bookingRequest.payment');

    const rowsHtml = rows.map(([k, v]) => paragraph(`${k}: ${v}`)).join('');
    const messageHtml = params.message
      ? `<pre style="white-space:pre-wrap;font-family:inherit;font-size:15px;line-height:1.6;margin:8px 0 16px;">${escapeHtml(params.message)}</pre>`
      : '';
    const bodyHtml =
      heading(t('coaching.bookingRequest.heading')) + paragraph(intro) + rowsHtml + messageHtml + paragraph(next) + paragraph(payment);
    const bodyText = [
      t('coaching.bookingRequest.heading'),
      '',
      intro,
      '',
      ...rows.map(([k, v]) => `${k}: ${v}`),
      ...(params.message ? ['', params.message] : []),
      '',
      next,
      payment,
    ].join('\n');

    return {
      subject,
      bodyHtml,
      bodyText,
      preheader: oneLine(params.topic, 90),
      reasonText: admin ? t('coaching.bookingRequest.reasonAdmin') : t('coaching.bookingRequest.reason'),
    };
  },
});
