'use client';

// messageText — the localized title/body of one inbox message (ARCHITECTURE.md §8.3).
//
// Producers store a `templateKey` + ICU `params` and an English title/body as
// fallbacks. The client renders `inbox.templates.<templateKey>.{title,body}`
// when that key exists AND every argument it names is present in `params`;
// otherwise the stored text. Nothing is invented: a template that would need
// a missing number falls back to what the producer wrote.

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';

import type { NotificationView } from '../../../lib/api/contracts/notifications';

const KEY_RE = /^[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const ARG_RE = /\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\}|,\s*(?:plural|select|selectordinal|number|date|time)\b)/g;

/** Top-level and nested ICU argument names in a message (`{count, plural, …}`, `{company}`). */
export function icuArguments(message: string): string[] {
  const out = new Set<string>();
  for (const m of message.matchAll(ARG_RE)) out.add(m[1]!);
  return [...out];
}

type Params = Record<string, string | number | Date>;

function icuParams(params: Record<string, unknown> | null): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
  }
  return out;
}

export interface MessageText {
  title: string;
  body: string | null;
}

export function useMessageText(): (n: NotificationView) => MessageText {
  const t = useTranslations('inbox');
  return useCallback(
    (n: NotificationView) => {
      const fallbackTitle = n.title ?? t(`categories.${n.category}`);
      const params = icuParams(n.params);
      const render = (part: 'title' | 'body'): string | null => {
        if (!n.templateKey || !KEY_RE.test(n.templateKey)) return null;
        const key = `templates.${n.templateKey}.${part}`;
        if (!t.has(key)) return null;
        const raw = t.raw(key);
        if (typeof raw !== 'string') return null;
        if (icuArguments(raw).some((a) => !(a in params))) return null;
        try {
          return t(key, params);
        } catch {
          return null;
        }
      };
      const title = render('title');
      // Template and stored text are never mixed: a templated title gets its templated body.
      if (title) return { title, body: render('body') ?? null };
      return { title: fallbackTitle, body: n.body };
    },
    [t],
  );
}
