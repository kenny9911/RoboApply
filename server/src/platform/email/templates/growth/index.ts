// server/src/platform/email/templates/growth/index.ts
//
// Invite-friends emails (TASK_PLAN.md WP-60; PRODUCT_PLAN.md F-GROW-01).
// Strings: server/src/i18n/email/staging/growth.en.json (`growth.*`).
//
//   growth.referral_reward   a practice credit was added because of an invite:
//                            role 'inviter' (a friend finished setting up) or
//                            'invitee' (the friend's own credit)
//
// Transactional: it tells the person about a change to their own account
// balance, so it carries no unsubscribe link. It names no one (the inviter is
// not told who the friend is) and promises nothing beyond the credit.

import { button, heading, paragraph } from '../_shell.js';
import { defineEmailTemplate } from '../registry.js';

export const GROWTH_EMAIL_TEMPLATES = { referralReward: 'growth.referral_reward' } as const;

export interface ReferralRewardParams {
  role: 'inviter' | 'invitee';
  /** Credits added (from the reward config, never from copy). */
  credits: number;
}

export const referralRewardEmail = defineEmailTemplate<ReferralRewardParams>({
  key: GROWTH_EMAIL_TEMPLATES.referralReward,
  category: 'transactional',
  render({ t, params, origin }) {
    const role = params.role === 'inviter' ? 'inviter' : 'invitee';
    const credits = Math.max(1, Math.floor(params.credits || 1));
    const subject = t(`growth.referralReward.${role}.subject`, { credits });
    const head = t(`growth.referralReward.${role}.heading`, { credits });
    const body = t(`growth.referralReward.${role}.body`, { credits });
    const note = t('growth.referralReward.note');
    const cta = t('growth.referralReward.cta');
    const url = `${origin}/practice`;
    return {
      subject,
      preheader: body,
      bodyHtml: heading(head) + paragraph(body) + paragraph(note) + button(cta, url),
      bodyText: `${head}\n\n${body}\n\n${note}\n\n${cta}: ${url}`,
      reasonText: t('growth.footer'),
    };
  },
});
