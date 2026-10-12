// server/src/features/jobs/sources/atsPublic/connectors/personio.ts — Personio
// (MKT-5B, JI-8; JOB_SOURCES_INTL 4.4).
//
//   GET https://{company}.jobs.personio.de/xml?language=en
//
// Personio's public XML feed of a company's open positions
// (developer.personio.de/v1.0/reference/get_xml "Retrieve open positions",
// read 2026-10-12; the shape was confirmed on Personio's own board the same
// day, which answered without any header). One call lists the whole board
// with its texts:
//
//   <workzag-jobs>
//     <position>
//       <id> <subcompany> <office> <additionalOffices><office>…</additionalOffices>
//       <department> <recruitingCategory> <name>
//       <jobDescriptions><jobDescription><name>…</name><value><![CDATA[ HTML ]]></value></jobDescription>…</jobDescriptions>
//       <employmentType>  permanent | intern | trainee | freelance
//       <seniority>       entry-level | experienced | executive | student
//       <schedule>        full-time | part-time
//       <yearsOfExperience> <keywords> <occupation> <occupationCategory>
//       <createdAt>       2016-05-31T12:14:07+0200
//
// The board id is the tenant's sub-domain label; `<label>.com` names a tenant
// whose career site is on jobs.personio.com (contract.ts PERSONIO_COM_SUFFIX).
// A host that is not a customer's answers with a redirect: ../http.ts never
// follows one, so that read fails as 'redirect' (a hard failure that closes
// nothing).
//
// Personio states no pay and no country: none is mapped (the board's country
// tag stays the weak hint it is for every system). The apply link is the
// tenant's own job page, `https://{host}/job/{id}`, the address Personio's
// integration guide builds (developer.personio.de/docs/integration-of-open-positions).

import type { ProviderJobInput } from '../../../normalize/index.js';
import { PERSONIO_COM_SUFFIX } from '../contract.js';
import { BoardFetchError, getXml } from '../http.js';
import { str } from '../shared.js';
import { childNamed, childText, childrenNamed, elementMarkup, parseXml, type XmlElement } from '../xml.js';
import { base, countryFields, enc, uniqueStrings, wholeBoard, type AtsConnector, type BoardSource } from './common.js';

/** The tenant's career-site host for a board id (`acme` -> acme.jobs.personio.de, `acme.com` -> acme.jobs.personio.com). */
export function personioHost(boardToken: string): string {
  return boardToken.endsWith(PERSONIO_COM_SUFFIX) ? `${boardToken.slice(0, -PERSONIO_COM_SUFFIX.length)}.jobs.personio.com` : `${boardToken}.jobs.personio.de`;
}

/** "2016-05-31T12:14:07+0200" -> "…+02:00" (the offset written without its colon); any other text is passed on as written. */
export function personioTime(value: string | null): string | null {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(\d{2})$/.exec(value.trim());
  return m ? `${m[1]}${m[2]}:${m[3]}` : value.trim();
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The sections of a position's text, each under the heading the employer gave it. */
function descriptionHtml(position: XmlElement): string | null {
  const html = childrenNamed(childNamed(position, 'jobDescriptions'), 'jobDescription')
    .map((section) => {
      const value = elementMarkup(childNamed(section, 'value'));
      if (!value) return '';
      const heading = childText(section, 'name');
      return `${heading ? `<h3>${escapeHtml(heading)}</h3>` : ''}${value}`;
    })
    .join('');
  return html || null;
}

/**
 * Employment type as the feed states it, the most specific fact first: an
 * internship or freelance work is that whatever the hours; otherwise the
 * schedule (full-time / part-time), then the contract kind.
 */
function employmentTypeOf(position: XmlElement): string[] {
  const kind = childText(position, 'employmentType');
  const schedule = childText(position, 'schedule');
  const special = kind === 'intern' || kind === 'freelance';
  return uniqueStrings(special ? [kind, schedule] : [schedule, kind]);
}

export function mapPersonioPosition(position: XmlElement, source: BoardSource, now: Date): ProviderJobInput | null {
  const id = childText(position, 'id');
  const title = childText(position, 'name');
  if (!id || !title) return null;
  const office = childText(position, 'office');
  const more = childrenNamed(childNamed(position, 'additionalOffices'), 'office').map((o) => o.text);
  const page = `https://${personioHost(source.boardToken)}/job/${enc(id)}`;
  const created = personioTime(childText(position, 'createdAt'));
  const types = employmentTypeOf(position);
  return {
    ...base(source, id, now),
    title,
    applyUrl: page,
    sourceUrl: page,
    location: office,
    locations: uniqueStrings([office, ...more]),
    ...countryFields(null, source),
    employmentType: types.length ? types : null,
    seniority: str(childText(position, 'seniority')),
    descriptionHtml: descriptionHtml(position),
    postedAt: created,
    postedAtEstimated: !created,
  };
}

export const personio: AtsConnector = {
  ats: 'personio',
  boardUrl: (token) => `https://${personioHost(token)}/xml?language=en`,
  async read(source, deps, opts = {}) {
    const root = parseXml(await getXml(this.boardUrl(source.boardToken), deps));
    // The feed's root; a board with no open position is an empty <workzag-jobs/>.
    if (root.name !== 'workzag-jobs') throw new BoardFetchError('unexpected_shape');
    const listing = childrenNamed(root, 'position')
      .map((position) => mapPersonioPosition(position, source, deps.now))
      .filter((x): x is ProviderJobInput => !!x);
    // The feed states no company name for the board (`subcompany` is a legal entity of one position).
    return wholeBoard(listing, opts, 1, null);
  },
};
