// components/features/network/links.ts — links the user opens themselves (WP-54).
//
// `mailto:` carries no address: the user picks the recipient in their own
// mail app (ruling C44; we never look up or store anyone's email). LinkedIn
// links are a profile the user added or a people search; nothing is fetched.

/** Mail apps truncate very long mailto URLs; keep the body within this many characters. */
const MAILTO_BODY_MAX = 1_800;

export function mailtoHref(subject: string | null | undefined, body: string): string {
  const params: string[] = [];
  if (subject?.trim()) params.push(`subject=${encodeURIComponent(subject.trim())}`);
  const text = Array.from(body).slice(0, MAILTO_BODY_MAX).join('').replace(/\r?\n/g, '\r\n');
  params.push(`body=${encodeURIComponent(text)}`);
  return `mailto:?${params.join('&')}`;
}

export function linkedinPeopleSearch(...terms: Array<string | null | undefined>): string {
  const keywords = terms.map((t) => (t ?? '').trim()).filter(Boolean).join(' ');
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`;
}

/** A stored LinkedIn profile URL, or a people search for the person at the company. */
export function linkedinHrefFor(person: { linkedinUrl: string | null; fullName: string } | null, companyName: string): string {
  if (person?.linkedinUrl && /^https:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\//i.test(person.linkedinUrl)) return person.linkedinUrl;
  return linkedinPeopleSearch(person?.fullName, companyName);
}

export const CONNECTIONS_SETTINGS_HREF = '/settings#connections';
export const REFERRALS_HREF = '/referrals';
