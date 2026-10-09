// server/src/platform/email/templates/registry.ts
//
// Template registry for the email platform (ARCHITECTURE.md §8.1). A template
// turns params into a subject and body using the brand × locale translator;
// EmailService wraps the body in the shared shell (_shell.ts), adds the
// unsubscribe link and headers for non-transactional mail, and sends.
//
// Area WPs define templates in their own modules (e.g. templates/billing/*.ts
// for WP-21a, features/alerts for WP-39a) and register them:
//
//   export const passwordReset = defineEmailTemplate<{ url: string }>({
//     key: 'auth.password_reset',
//     category: 'transactional',
//     render: ({ t, params }) => ({
//       subject: t('auth.passwordReset.subject'),
//       bodyHtml: heading(t('auth.passwordReset.heading')) + button(t('auth.passwordReset.cta'), params.url),
//       bodyText: `${t('auth.passwordReset.heading')}\n${params.url}`,
//     }),
//   });
//
// `defineEmailTemplate` registers on import. A producer that only enqueues
// `email.send` must make sure the template module is imported by the worker
// (WP-39a's notifications/workers.ts imports its senders' template modules).

import type { ProductBrand } from '../../brand/registry.js';
import type { EmailTranslator } from '../i18n.js';
import type { UnsubscribeList } from '../unsubscribe.js';
import type { EmailCategory } from './_shell.js';

export type { EmailCategory } from './_shell.js';

export interface TemplateContext<P> {
  brand: ProductBrand;
  t: EmailTranslator;
  params: P;
  /** The brand's public origin for links (no trailing slash). */
  origin: string;
  userId?: string | null;
}

export interface TemplateBody {
  subject: string;
  bodyHtml: string;
  bodyText: string;
  preheader?: string;
  /** Replaces the shell's default reason line. */
  reasonText?: string;
}

export interface EmailTemplate<P = Record<string, unknown>> {
  /** Stable key, written to RAEmailLog.template (e.g. 'auth.password_reset'). */
  key: string;
  category: EmailCategory;
  /** List an unsubscribe removes the person from; defaults by category. */
  list?: UnsubscribeList;
  render(ctx: TemplateContext<P>): TemplateBody;
}

const templates = new Map<string, EmailTemplate<any>>();

const KEY_RE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;

export function registerEmailTemplate<P>(template: EmailTemplate<P>): EmailTemplate<P> {
  if (!KEY_RE.test(template.key)) throw new Error(`email: invalid template key "${template.key}" (use "area.name")`);
  const existing = templates.get(template.key);
  if (existing && existing !== template) throw new Error(`email: template "${template.key}" is already registered`);
  templates.set(template.key, template as EmailTemplate<any>);
  return template;
}

/** Define and register in one step. */
export function defineEmailTemplate<P = Record<string, unknown>>(template: EmailTemplate<P>): EmailTemplate<P> {
  return registerEmailTemplate(template);
}

export function getEmailTemplate(key: string): EmailTemplate<any> | undefined {
  return templates.get(key);
}

export function registeredEmailTemplates(): string[] {
  return [...templates.keys()].sort();
}

/** Tests only. */
export function unregisterEmailTemplateForTests(key: string): void {
  templates.delete(key);
}

export function defaultListFor(category: EmailCategory): UnsubscribeList | undefined {
  switch (category) {
    case 'alert':
      return 'alerts';
    case 'tips':
      return 'tips';
    case 'marketing':
      return 'marketing';
    default:
      return undefined;
  }
}
