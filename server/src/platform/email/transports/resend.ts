// server/src/platform/email/transports/resend.ts
//
// Resend HTTP transport (refactored from the legacy server/src/services/EmailService.ts
// call, which is now a shim over this file). RoboApply always sends through
// Resend. GoApply sends through it too, on the shared account, unless
// `CN_EMAIL_TRANSPORT` is `aliyun_dm` (Aliyun DirectMail, transports/
// aliyunDirectMail.ts) or `none` (D5; `transportNameFor` in EmailService.ts).
// The API key is a vendor key shared by both brands, read unprefixed
// (`RESEND_API_KEY`).

export interface EmailMessage {
  /** RFC 5322 From, e.g. `RoboApply <noreply@roboapply.io>`. */
  from: string;
  to: string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

export type TransportResult = { ok: true; providerId?: string } | { ok: false; error: string; status?: number };

export interface EmailTransport {
  /** Provider name written to RAEmailLog.provider. */
  readonly name: string;
  isConfigured(): boolean;
  send(message: EmailMessage): Promise<TransportResult>;
}

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface ResendTransportOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

export function createResendTransport(options: ResendTransportOptions = {}): EmailTransport {
  const apiKey = () => options.apiKey ?? process.env.RESEND_API_KEY;
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  return {
    name: 'resend',
    isConfigured: () => Boolean(apiKey()),
    async send(message: EmailMessage): Promise<TransportResult> {
      const key = apiKey();
      if (!key) return { ok: false, error: 'not_configured' };
      try {
        const res = await doFetch(options.endpoint ?? RESEND_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            from: message.from,
            to: message.to,
            subject: message.subject,
            html: message.html,
            ...(message.text ? { text: message.text } : {}),
            ...(message.replyTo ? { reply_to: message.replyTo } : {}),
            ...(message.headers && Object.keys(message.headers).length ? { headers: message.headers } : {}),
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          return { ok: false, status: res.status, error: `resend_${res.status}${body ? `: ${body.slice(0, 300)}` : ''}` };
        }
        const json = (await res.json().catch(() => null)) as { id?: unknown } | null;
        return { ok: true, providerId: typeof json?.id === 'string' ? json.id : undefined };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/** Shared default instance (reads RESEND_API_KEY at send time). */
export const resendTransport: EmailTransport = createResendTransport();
