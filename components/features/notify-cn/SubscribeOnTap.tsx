'use client';

// SubscribeOnTap — wraps a "remind me" control (e.g. 截止提醒) so the tap also
// asks WeChat for a one-time subscribe-message permission (公众号 订阅通知)
// (TASK_PLAN.md WP-73; WP-58 wraps the campus calendar's 截止提醒 with it).
//
// Outside WeChat, on RoboApply, for visitors, without `WECHAT_MP_*`, when the
// template has no id, or when the account is not linked to the 公众号 (so
// nothing could ever be delivered), it renders its children unchanged.
// Otherwise WeChat's own `wx-open-subscribe` tag is laid, invisible, over the
// control: the tap opens WeChat's prompt, the answer is recorded
// (POST /notify-cn/subscribe-messages, with `eventId` when the caller names
// what the reminder is about, so the permission is kept for that reminder),
// the caller hears the answer (`onAnswer`, before its control's click, so the
// click can save the reminder as a WeChat one), and then the wrapped control's
// own click runs, whatever the person answered.
//
// Accepting the prompt is the opt-in to WeChat for these reminders: the server
// turns the WeChat channel on by itself. Only someone who turned WeChat
// reminders off in their notification settings stays off; for them one line
// says the reminder stays in the inbox and links to the settings, because an
// accepted prompt would otherwise look like a promise of a WeChat message.
//
// The invisible tag must never make the control untappable, so it is not
// laid (or is taken away) when:
//   - WeChat is older than 7.0.12 (no open tags: the tag would be an unknown
//     element covering the button);
//   - WeChat fires `WeixinOpenTagsError` (open tags unusable on this page);
//   - the wrapped control is disabled (`disabled` / `aria-disabled="true"`,
//     e.g. while the reminder is being saved): taps would re-prompt WeChat
//     while the control itself does nothing.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { subscribeWechatMessages } from '../../../lib/api/notifyCn';
import { useWechatEnabled, useWechatReady } from './useWechat';
import { currentUserAgent, onOpenTagsError, openTagsUsable, parseSubscribeDetails, supportsOpenTags } from './wechatSdk';
import styles from './notifyCn.module.css';

/** Server message templates (IDs come from env; a template without an ID never sends). */
export type SubscribeTemplate = 'deadline_reminder' | 'report_ready' | 'payment_success';

export interface SubscribeAnswer {
  /** True when the person accepted WeChat's prompt for this template (one message allowed). */
  accepted: boolean;
}

export interface SubscribeOnTapProps {
  template: SubscribeTemplate;
  children: ReactNode;
}

/** The wrapper's full props: the two every caller passes, plus what a caller with a specific reminder adds. */
export interface SubscribeOnTapOptions extends SubscribeOnTapProps {
  /**
   * What the reminder is about (e.g. the campus event id). Sent with the
   * accepted prompt so the notice about this item spends this permission and
   * not one given for another item.
   */
  eventId?: string;
  /**
   * Called with WeChat's answer right before the wrapped control's own click
   * runs (also `accepted: false` when WeChat reports an error). Not called
   * when no prompt was shown (outside WeChat, tag unusable).
   */
  onAnswer?: (answer: SubscribeAnswer) => void;
}

/** Mirrors the server's SCENE_FOR_TEMPLATE (contract.ts). */
const SCENE: Record<SubscribeTemplate, 'campus_deadline' | 'practice_report' | 'payment'> = {
  deadline_reminder: 'campus_deadline',
  report_ready: 'practice_report',
  payment_success: 'payment',
};

export const SETTINGS_HREF = '/settings#notifications';

/**
 * The open tag's own content lives in WeChat's shadow DOM, out of reach of
 * the page's CSS: a transparent block filling the tag (no colour, no text).
 */
const OPEN_TAG_TEMPLATE =
  '<script type="text/wxtag-template"><style>.hit{display:block;width:100%;height:100%;opacity:0}</style><div class="hit"></div></script>';

const CONTROL_SELECTOR = 'button, a[href], [role="button"], input[type="button"], input[type="submit"]';

/** A control that is switched off ignores taps; the open tag must not sit over it. */
export function controlDisabled(el: HTMLElement): boolean {
  return (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
}

export function SubscribeOnTap({ template, eventId, onAnswer, children }: SubscribeOnTapOptions) {
  const t = useTranslations('notifyCn.subscribe');
  // Read at tap time: a new callback or id must not tear the open tag down.
  const latest = useRef({ eventId, onAnswer });
  latest.current = { eventId, onAnswer };
  const enabled = useWechatEnabled();
  const ready = useWechatReady(enabled);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const [channelOff, setChannelOff] = useState(false);
  const [tagsBroken, setTagsBroken] = useState(false);

  const templates = ready?.config.templates ?? {};
  const templateId =
    ready && ready.config.canDeliver && !tagsBroken && supportsOpenTags(currentUserAgent()) ? (templates[template] ?? null) : null;

  useEffect(() => {
    if (!enabled) return;
    if (!openTagsUsable()) setTagsBroken(true);
    return onOpenTagsError(() => setTagsBroken(true));
  }, [enabled]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !templateId || !openTagsUsable()) return;
    const tag = document.createElement('wx-open-subscribe');
    tag.setAttribute('template', templateId);
    tag.className = styles.openTag ?? '';
    tag.innerHTML = OPEN_TAG_TEMPLATE;

    const control = () => Array.from(wrap.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)).find((el) => !tag.contains(el)) ?? null;
    // The tag sits over the control only while the control can be used.
    const sync = () => {
      const c = control();
      const want = c !== null && !controlDisabled(c) && openTagsUsable();
      if (want && !tag.isConnected) wrap.appendChild(tag);
      else if (!want && tag.isConnected) tag.remove();
      wrap.dataset.wechatSubscribe = want ? 'on' : 'off';
    };

    // Run the wrapped control's own action (the reminder itself).
    const forward = () => {
      const c = control();
      if (c && !controlDisabled(c)) c.click();
    };
    const onSuccess = (e: Event) => {
      const detail = (e as CustomEvent<{ subscribeDetails?: unknown }>).detail;
      const results = parseSubscribeDetails(detail?.subscribeDetails, { [template]: templateId });
      const about = latest.current.eventId;
      if (Object.keys(results).length) {
        subscribeWechatMessages({ templateKeys: [template], scene: SCENE[template], ...(about ? { eventId: about } : {}), results })
          // Off only when the person turned WeChat off in settings (an accepted prompt turns it on otherwise).
          .then((res) => setChannelOff(res.recorded.length > 0 && !res.wechatChannelOn))
          .catch(() => undefined);
      }
      latest.current.onAnswer?.({ accepted: results[template] === 'accept' });
      forward();
    };
    const onError = () => {
      latest.current.onAnswer?.({ accepted: false });
      forward();
    };
    tag.addEventListener('success', onSuccess);
    tag.addEventListener('error', onError);
    const observer = new MutationObserver(sync);
    observer.observe(wrap, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled'] });
    sync();
    return () => {
      observer.disconnect();
      tag.removeEventListener('success', onSuccess);
      tag.removeEventListener('error', onError);
      tag.remove();
      wrap.dataset.wechatSubscribe = 'off';
    };
  }, [templateId, template]);

  if (!enabled) return <>{children}</>;
  return (
    <>
      <span ref={wrapRef} className={styles.wrap} data-wechat-subscribe="off">
        {children}
      </span>
      {channelOff ? (
        <p className={styles.notice} role="status">
          {t('channelOff')}{' '}
          <Link href={SETTINGS_HREF} className={styles.link}>
            {t('settingsLink')}
          </Link>
        </p>
      ) : null}
    </>
  );
}

export default SubscribeOnTap;
