import type { Metadata } from 'next';
import { loadMessages } from '../../lib/i18n';
import { resolveLocale } from '../../lib/serverLocale';

export async function jobSearchMetadata(surface: 'search' | 'keys' | 'api'): Promise<Metadata> {
  const messages = loadMessages(await resolveLocale());
  const search = messages.jobSearch as Record<string, string>;
  const api = messages.jobSearchApi as Record<string, string>;
  const title = surface === 'api' ? `${api.docs} · ${search.title}` : surface === 'keys' ? api.keys_title : search.title;
  return {
    title: `${title} | RoboApply`,
    description: surface === 'api' ? api.intro : surface === 'keys' ? api.keys_intro : search.intro,
    ...(surface === 'api' ? { alternates: { canonical: '/developers/job-search' } } : { robots: { index: false, follow: false } }),
  };
}
