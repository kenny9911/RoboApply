// server/src/features/jobs/sources/userAgent.ts — the identifying User-Agent
// (MKT-1C; MARKET_STRATEGY §1.2 tier 0, §1.3, §1.4; JI-4).
//
// Every adapter that reads a public job-board or open-data endpoint says who
// is asking and where to reach us:
//
//   RoboApplyJobs/1.0 (+<contact>)     market intl
//   GoApplyJobs/1.0 (+<contact>)       market cn
//
// <contact> is the brand's own contact variable (a URL or a mailto: address
// an operator of the source can use), else the brand's own site from the brand
// registry:
//
//   RoboApply   JOB_SOURCES_CONTACT
//   GoApply     CN_JOB_SOURCES_CONTACT
//
// The contact is identity, and identity does not cross brands (the brandEnv
// rule for sender and support mailboxes): one process runs both brands'
// ingest, so GoApply never sends RoboApply's contact to a mainland board. With
// no value of its own it names its own site. We never pose as a browser and
// never hide behind a library default.
//
// The value goes into an HTTP header, so it is printable ASCII on one line
// (only the first line of the variable is used, so a line break can never add
// a header), holds exactly one comment, and is at most 200 characters.

import { BRANDS, brandOwnEnv, type EnvSource, type Market, type ProductBrand } from '../../../platform/brand/index.js';

/** The unprefixed name; GoApply reads `CN_JOB_SOURCES_CONTACT` (brandOwnEnv). */
export const JOB_SOURCES_CONTACT_ENV = 'JOB_SOURCES_CONTACT';
export const SOURCE_USER_AGENT_VERSION = '1.0';
/** Longest value we send. */
export const SOURCE_USER_AGENT_MAX = 200;

function brandOfMarket(market: Market): ProductBrand {
  return Object.values(BRANDS).find((b) => b.market === market) ?? BRANDS.roboapply;
}

/** First line only, printable ASCII, no brackets (the contact sits inside the header's one comment). */
function cleanContact(value: string | undefined): string {
  if (typeof value !== 'string') return '';
  const firstLine = value.split(/[\r\n]+/).find((line) => line.trim()) ?? '';
  return firstLine
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The User-Agent of a job-source request for the market. Pure; never throws. */
export function sourceUserAgent(market: Market, env: EnvSource = process.env): string {
  const brand = brandOfMarket(market);
  const head = `${cleanContact(brand.name).replace(/\s+/g, '')}Jobs/${SOURCE_USER_AGENT_VERSION} (+`;
  const tail = ')';
  // The brand's own variable only: never the other brand's contact.
  const contact = cleanContact(brandOwnEnv(brand, JOB_SOURCES_CONTACT_ENV, env)) || cleanContact(brand.canonicalOrigin);
  return `${head}${contact.slice(0, SOURCE_USER_AGENT_MAX - head.length - tail.length).trimEnd()}${tail}`;
}
