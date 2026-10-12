// extension/src/content/pageUrl.ts — the page URL we send to the API.
//
// The /ext schemas accept at most 2000 characters. Most URLs fit and keep
// their query (Greenhouse embeds name the job in `?gh_jid=`); a longer one
// (tracking parameters) is cut to origin + path, which still names the page.

export const MAX_URL = 2000;

export function apiPageUrl(href: string): string {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return href.slice(0, MAX_URL);
  }
  u.hash = '';
  const full = u.toString();
  if (full.length <= MAX_URL) return full;
  return `${u.origin}${u.pathname}`.slice(0, MAX_URL);
}
