// GET /i18n/<brand>.<locale>.<hash>.js — the client's message bundle
// (lib/i18nBundle.ts, lib/server/messagesBundle.ts).
//
// The URL carries the hash of the content, so the current bundle is cached
// for a year by the browser and the CDN. A request for another hash (a page
// rendered by an earlier deployment) still gets the current copy, cached for
// a minute only. The copy is the same public UI text for every visitor.

import { isBrandId } from '../../../lib/brand/registry.generated';
import { isLocale } from '../../../lib/localeConfig';
import { messagesBundle } from '../../../lib/server/messagesBundle';

const FILE = /^([a-z]+)\.([A-Za-z-]+)\.([a-f0-9]{16})\.js$/;

const YEAR = 'public, max-age=31536000, s-maxage=31536000, immutable';
const MINUTE = 'public, max-age=60, s-maxage=60';

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const m = FILE.exec(file);
  if (!m || !isBrandId(m[1]) || !isLocale(m[2])) {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const bundle = messagesBundle(m[2], m[1]);
  return new Response(bundle.js, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': bundle.hash === m[3] ? YEAR : MINUTE,
      'x-content-type-options': 'nosniff',
    },
  });
}
