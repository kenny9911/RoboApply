// server/src/features/network/OutreachDraftAgent.ts
//
// Writes ONE short message the user will copy or open in their own mail app
// and send themselves (F-NET-04, F-NET-06; GoApply 内推请求 for WeChat/脉脉).
// Grounded in the job post and the user's resume ("Written from the job post
// and your resume."): every fact about the user comes from the RESUME or
// PROFILE; the job post's requirements are the employer's facts.
//
// Privacy: the prompt carries `resumeForLlm` text with PII redacted and
// `profileSnapshotForLlm` only. The recipient's name is never sent: the model
// writes [[NAME]] and draftText.fillRecipient puts the name in afterwards. No
// signature: the user adds their own name.
//
// Runs only after `aiAllowed(user)` and the brand's `ai.text` capability
// (the service never loads this module otherwise: zero LLMService calls).

import { BaseAgent } from '../../agents/BaseAgent.js';
import { getTaskModel, getTaskReasoningEffort } from '../../lib/llm/llmTaskSettings.js';
import { currentBrandPersona } from '../../platform/brand/persona.js';
import type { OutreachChannel } from './contract.js';
import { NAME_TOKEN } from './draftText.js';

export interface OutreachWriterInput {
  channel: OutreachChannel;
  locale: string;
  market: 'intl' | 'cn';
  job: { title: string; company: string; text: string };
  /** Resume text for the prompt (resumeForLlm + PII redaction); may be empty. */
  resumeText: string;
  /** profileSnapshotForLlm().text (may be empty). */
  profileText: string;
  /** Who the message is for, without their name. */
  recipient: { kind: 'connection' | 'recruiter' | 'added' | 'none'; title: string | null };
  maxChars: number;
}

export interface OutreachWriterOutput {
  subject: string | null;
  body: string;
}

const CHANNEL_RULES: Record<OutreachChannel, string> = {
  linkedin_note:
    'A LinkedIn connection request note. Plain text, no subject. It MUST fit the character limit below, counting every character. Two or three short sentences: who the candidate is (one fact from the resume), why this role at this company, a light ask to connect.',
  email:
    'A short email to a person at the company about this role. A subject line and a body of 80–150 words in two or three short paragraphs: one concrete link between the resume and the job post, a clear small ask (a short call or where to send questions). No attachments are mentioned.',
  referral_ask:
    'A message asking the person whether they would be open to referring the candidate for this role. Subject line and a body of 80–140 words: the role (title, company), two facts from the resume that fit the post, a polite ask that makes "no" easy. Never assume they know the candidate well.',
  follow_up:
    'A follow-up to the employer after applying to this role. Subject line and a body of 60–120 words: the role applied for, one fact from the resume that fits the post, interest in the next step. Never claim an interview, a reply or a referral that is not stated.',
  wechat:
    'A 内推请求 message for WeChat or 脉脉: plain text, no subject, 2–4 short sentences, polite and direct: the role (title, company), one or two facts from the resume, the ask for a 内推 (internal referral), thanks. No emoji walls, no greeting card language.',
};

function parseJsonObject(response: string): Record<string, unknown> | null {
  if (!response || typeof response !== 'string') return null;
  const cleaned = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  for (const candidate of [cleaned, cleaned.match(/\{[\s\S]*\}/)?.[0]]) {
    if (!candidate) continue;
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** Malformed output becomes an empty body (the service answers draft_empty and releases the credit). */
export function parseOutreachOutput(response: string): OutreachWriterOutput {
  const parsed = parseJsonObject(response);
  if (!parsed) return { subject: null, body: '' };
  const subject = typeof parsed.subject === 'string' ? parsed.subject.trim().slice(0, 300) : '';
  const body = typeof parsed.body === 'string' ? parsed.body.trim().slice(0, 8_000) : '';
  return { subject: subject || null, body };
}

export class OutreachDraftAgent extends BaseAgent<OutreachWriterInput, OutreachWriterOutput> {
  constructor() {
    super('OutreachDraftAgent');
  }

  protected getTemperature(): number {
    return 0.5;
  }

  protected getMaxTokens(): number | undefined {
    return 1_500;
  }

  protected getReasoningEffort() {
    return getTaskReasoningEffort('writing');
  }

  protected getResponseFormat(): 'json_object' {
    return 'json_object';
  }

  /** The draft IS the artifact: the 'content' scope, so it is written in the requested language. */
  protected getLocaleDirective(locale: string): string | null {
    return this.language.getStrictOutputLanguageDirective(locale, 'content') ?? super.getLocaleDirective(locale);
  }

  protected getAgentPrompt(): string {
    return `${currentBrandPersona('message writer')}. You write ONE short message that a job seeker will read, edit and send themselves. Nothing is sent by anyone else.

## Hard rules
1. Never invent skills, employers, titles, dates, numbers or results. Every fact about the candidate comes from the RESUME or PROFILE below. If they are empty, say only what the job post supports about the role and keep the candidate's side general.
2. The JOB POST describes the employer. Its requirements are the employer's facts, never the candidate's.
3. You do not know the recipient's name. Where a greeting needs it, write exactly ${NAME_TOKEN} (for example "Hi ${NAME_TOKEN},"). Never invent a name.
4. Never claim that the candidate already knows the recipient, met them, was referred, has an interview or was contacted, unless the input says so. A "connection" recipient is someone the candidate is connected to on LinkedIn; that is all you know.
5. No signature, no name, no email address, no phone number, no links. The candidate adds their own details.
6. Do not say the message was sent or will be sent by a tool, and do not mention AI.
7. Plain, friendly, specific. No flattery, no clichés ("I hope this finds you well", "passionate", "synergy").

## Output (strict JSON only, no prose, no code fences)
{ "subject": "<subject line, or empty string when the channel has none>", "body": "<the message>" }`;
  }

  protected formatInput(input: OutreachWriterInput, locale?: string): string {
    const blocks: string[] = [];
    const reminder = this.outputLanguageReminder(locale ?? input.locale);
    if (reminder) blocks.push(reminder);
    blocks.push(`Message language: ${input.locale}`);
    blocks.push(`Channel: ${CHANNEL_RULES[input.channel]}\nCharacter limit for the body: ${input.maxChars}`);
    const who =
      input.recipient.kind === 'recruiter'
        ? `A recruiter at the company who chose to be contactable by candidates${input.recipient.title ? ` (${input.recipient.title})` : ''}.`
        : input.recipient.kind === 'connection'
          ? `One of the candidate's LinkedIn connections who works at the company${input.recipient.title ? ` (${input.recipient.title})` : ''}.`
          : input.recipient.kind === 'added'
            ? `A person at the company the candidate added themselves${input.recipient.title ? ` (${input.recipient.title})` : ''}.`
            : 'No specific person: write it so the candidate can address it to someone at the company.';
    blocks.push(`## RECIPIENT\n${who}`);
    blocks.push(`## JOB POST\nCompany: ${input.job.company || '(not listed)'}\nTitle: ${input.job.title}\n\n${input.job.text.slice(0, 6_000)}`);
    blocks.push(`## RESUME\n${input.resumeText.slice(0, 8_000) || '(none)'}`);
    if (input.profileText.trim()) blocks.push(`## PROFILE (the candidate's own answers)\n${input.profileText.slice(0, 2_000)}`);
    blocks.push('Write the message. Output ONLY the JSON.');
    return blocks.join('\n\n');
  }

  protected parseOutput(response: string): OutreachWriterOutput {
    return parseOutreachOutput(response);
  }

  async run(input: OutreachWriterInput, options: { requestId?: string; signal?: AbortSignal } = {}): Promise<OutreachWriterOutput> {
    return this.execute(input, input.job.text, options.requestId, input.locale, getTaskModel('writing'), options.signal);
  }
}
