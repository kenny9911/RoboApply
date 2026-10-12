// server/src/features/network/draftText.ts — pure helpers around an outreach draft (WP-54).
//
// The writer never sees the recipient's name: it writes the token [[NAME]]
// where the greeting goes and `fillRecipient` puts the first name in after
// the model ran (or drops the token when there is no named recipient). The
// LinkedIn note is clamped to LinkedIn's limit at a sentence or word
// boundary, never mid-word.

import { LINKEDIN_NOTE_MAX_CHARS, OUTREACH_BODY_MAX_CHARS, type OutreachChannel } from './contract.js';

export const NAME_TOKEN = '[[NAME]]';

/** Channels whose draft carries a subject line (email-like). */
export const SUBJECT_CHANNELS: ReadonlySet<OutreachChannel> = new Set(['email', 'referral_ask', 'follow_up']);

export function maxCharsFor(channel: OutreachChannel): number {
  return channel === 'linkedin_note' ? LINKEDIN_NOTE_MAX_CHARS : channel === 'wechat' ? 600 : OUTREACH_BODY_MAX_CHARS;
}

/** First name for a greeting: the stored first name, else the first word of the full name. */
export function greetingName(contact: { firstName: string | null; fullName: string } | null): string | null {
  if (!contact) return null;
  const first = contact.firstName?.trim() || contact.fullName.trim().split(/\s+/)[0] || '';
  return first || null;
}

/**
 * Replace the [[NAME]] token. Without a name, "Hi [[NAME]]," becomes "Hi,"
 * and a bare token disappears; stray whitespace and punctuation are tidied.
 */
export function fillRecipient(text: string, name: string | null): string {
  if (!text.includes(NAME_TOKEN)) return text;
  if (name) return text.split(NAME_TOKEN).join(name);
  return text
    .replace(/[ \t]*\[\[NAME\]\][ \t]*(?=[,，!！:：])/g, '')
    .replace(/[ \t]*\[\[NAME\]\][ \t]*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,，!！:：])/g, '$1')
    .trim();
}

/** Remove fences, stray JSON quoting and trailing whitespace on each line. */
export function cleanDraftText(text: string): string {
  return text
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/, '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Clamp to `max` characters (code points) at the last sentence end, else the last word boundary. */
export function clampDraft(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = chars.slice(0, max).join('');
  const sentenceEnd = Math.max(...['. ', '! ', '? ', '。', '！', '？', '.\n', '!\n', '?\n'].map((p) => head.lastIndexOf(p)));
  if (sentenceEnd >= Math.floor(max * 0.5)) {
    const cut = head.slice(0, sentenceEnd + 1).trim();
    return cut;
  }
  const space = head.lastIndexOf(' ');
  const cut = (space >= Math.floor(max * 0.5) ? head.slice(0, space) : head.slice(0, max - 1)).replace(/[\s,;:，；：]+$/, '');
  return Array.from(`${cut}…`).length <= max ? `${cut}…` : cut;
}

/** Final shape of a draft: tidy, name in, subject only where the channel has one, within the channel's limit. */
export function finalizeDraft(
  raw: { subject: string | null; body: string },
  channel: OutreachChannel,
  recipientName: string | null,
): { subject: string | null; body: string } {
  const body = clampDraft(fillRecipient(cleanDraftText(raw.body), recipientName), maxCharsFor(channel));
  const subjectRaw = SUBJECT_CHANNELS.has(channel) ? fillRecipient(cleanDraftText(raw.subject ?? ''), recipientName).replace(/\s+/g, ' ') : '';
  const subject = subjectRaw ? Array.from(subjectRaw).slice(0, 200).join('') : null;
  return { subject, body };
}
