import prisma from '../lib/prisma.js';

interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  /** Optional per-call From override (e.g. brand-aware display name).
   *  Must keep a Resend-verified sending address. Defaults to EMAIL_FROM. */
  from?: string;
  /** Optional plain-text alternative. Sending multipart text+HTML (rather than
   *  HTML-only) materially improves inbox placement — HTML-only mail is a spam
   *  signal. Always provide this for transactional auth emails. */
  text?: string;
}

class EmailService {
  private apiKey: string | undefined;
  private from: string;

  constructor() {
    this.apiKey = process.env.RESEND_API_KEY;
    this.from = process.env.EMAIL_FROM || 'RoboHire <noreply@updates.robohire.io>';
  }

  get isConfigured(): boolean {
    return !!this.apiKey;
  }

  /** The configured default From header (EMAIL_FROM or the built-in fallback).
   *  Exposed so brand-aware senders can swap the display name while keeping
   *  the Resend-verified address. */
  get defaultFrom(): string {
    return this.from;
  }

  async send(options: SendEmailOptions): Promise<boolean> {
    if (!this.apiKey) return false;

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          from: options.from || this.from,
          to: Array.isArray(options.to) ? options.to : [options.to],
          subject: options.subject,
          html: options.html,
          ...(options.text ? { text: options.text } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error('EmailService send failed:', res.status, body);
      }
      return res.ok;
    } catch (err) {
      console.error('EmailService send error:', err);
      return false;
    }
  }

  /**
   * Send an evaluation report to a hiring manager or client. Pre-rendered
   * HTML body (use `renderEmailDigest()` from
   * `lib/evaluationReportRenderer.ts` to produce it). Subject defaults to
   * a sensible "RoboHire candidate report" string.
   */
  async sendEvaluationReport(opts: {
    to: string | string[];
    subject?: string;
    html: string;
    candidateName?: string | null;
    jobTitle?: string | null;
  }): Promise<boolean> {
    if (!this.isConfigured) return false;
    const subject = opts.subject
      || `[RoboHire] Candidate report — ${opts.candidateName || 'candidate'}${opts.jobTitle ? ' · ' + opts.jobTitle : ''}`;
    return this.send({ to: opts.to, subject, html: opts.html });
  }

  async sendInterviewCompletedDigestEmail(opts: {
    to: string;
    count: number;
    candidateNames: string[];
    jobTitles: string[];
    actionUrl: string;
  }): Promise<boolean> {
    if (!this.isConfigured) return false;

    const frontendUrl = process.env.FRONTEND_URL || 'https://robohire.io';
    const fullUrl = opts.actionUrl.startsWith('http') ? opts.actionUrl : `${frontendUrl}${opts.actionUrl}`;

    const previewNames = opts.candidateNames.slice(0, 3).map(escapeHtml);
    const remaining = Math.max(0, opts.count - previewNames.length);
    const namesLine = remaining > 0
      ? `${previewNames.join(', ')} and ${remaining} more`
      : previewNames.join(', ');

    const distinctJobs = Array.from(new Set(opts.jobTitles.filter(Boolean))).slice(0, 4).map(escapeHtml);
    const jobsLine = distinctJobs.length > 0 ? distinctJobs.join(' · ') : '';

    return this.send({
      to: opts.to,
      subject: `[RoboHire] ${opts.count} new interviews completed`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
          <h2 style="margin: 0 0 12px; font-size: 20px; color: #0f172a;">${opts.count} new interviews completed</h2>
          <p style="margin: 0 0 8px; color: #334155; font-size: 14px;">${namesLine}</p>
          ${jobsLine ? `<p style="margin: 0 0 20px; color: #64748b; font-size: 13px;">${jobsLine}</p>` : ''}
          <a href="${fullUrl}" style="display: inline-block; padding: 10px 20px; background: #2563eb; color: white; text-decoration: none; border-radius: 6px; font-weight: 500; font-size: 14px;">View interviews</a>
          <p style="margin-top: 32px; color: #94a3b8; font-size: 12px;">— RoboHire</p>
        </div>
      `,
    });
  }

  async notifyAdminsOfSignup(user: {
    name?: string | null;
    email: string;
    company?: string | null;
    createdAt: Date;
  }): Promise<void> {
    if (!this.isConfigured) return;

    const admins = await prisma.user.findMany({
      where: { role: 'admin' },
      select: { email: true },
    });

    if (admins.length === 0) return;

    const adminEmails = admins.map((a) => a.email);
    const time = user.createdAt.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

    await this.send({
      to: adminEmails,
      subject: `New RoboHire signup: ${user.email}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #1e293b; margin-bottom: 16px;">New User Signup</h2>
          <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="padding: 8px 0; color: #64748b; width: 100px;">Name</td><td style="padding: 8px 0; color: #1e293b;">${escapeHtml(user.name || '(not provided)')}</td></tr>
            <tr><td style="padding: 8px 0; color: #64748b;">Email</td><td style="padding: 8px 0; color: #1e293b;">${escapeHtml(user.email)}</td></tr>
            <tr><td style="padding: 8px 0; color: #64748b;">Company</td><td style="padding: 8px 0; color: #1e293b;">${escapeHtml(user.company || '(not provided)')}</td></tr>
            <tr><td style="padding: 8px 0; color: #64748b;">Time</td><td style="padding: 8px 0; color: #1e293b;">${time}</td></tr>
          </table>
          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
          <p style="color: #94a3b8; font-size: 12px;">This is an automated notification from RoboHire.</p>
        </div>
      `,
    });
  }
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const emailService = new EmailService();
export default emailService;
