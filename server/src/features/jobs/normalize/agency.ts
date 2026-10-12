// server/src/features/jobs/normalize/agency.ts
//
// isAgency (ARCH §4.4): the company is on our staffing-firm list
// (data/staffing-agencies.json), or its name says it is one ("staffing",
// "recruitment agency", 猎头, 人力资源服务, 人力派遣 …), or the provider flags
// it. When none of these holds the answer is null, not false: a name that
// does not look like an agency proves nothing (D3), and the feed filter
// reads `isAgency IS NOT TRUE`.

import { STAFFING_AGENCY_NAMES } from '../data/index.js';
import { normalizeCompanyName } from './text.js';

const CJK = /[㐀-鿿]/;

const AGENCY_KEYS = STAFFING_AGENCY_NAMES.map((n) => {
  const key = normalizeCompanyName(n);
  const prefix = CJK.test(key) ? key.length >= 3 : key.replace(/\s/g, '').length >= 6;
  return { key, prefix };
}).filter((k) => k.key);

const AGENCY_NAME_RE = /\b(staffing|recruitment|recruiting|recruiters|headhunt(?:er|ers|ing)?|executive search|talent acquisition agency|employment agency|personnel services|manpower services)\b|猎头|獵頭|人力资源服务|人力資源服務|人力资源有限|人力資源有限|人力派遣|人力仲介|劳务派遣|勞務派遣|人才服务|人才服務/i;

/** True when the company name or our list marks the company as a staffing / recruitment firm, else null. */
export function agencyFromCompanyName(company: string | null | undefined): true | null {
  if (!company) return null;
  if (AGENCY_NAME_RE.test(company.normalize('NFKC'))) return true;
  const key = normalizeCompanyName(company);
  if (!key) return null;
  for (const a of AGENCY_KEYS) {
    if (key === a.key) return true;
    if (a.prefix && (key.startsWith(`${a.key} `) || (CJK.test(a.key) && key.startsWith(a.key)))) return true;
  }
  return null;
}

/** The provider's own flag wins when it says true; a provider "false" is kept; otherwise our list / name rule. */
export function resolveIsAgency(company: string | null | undefined, providerFlag: boolean | null | undefined): boolean | null {
  if (providerFlag === true) return true;
  if (agencyFromCompanyName(company)) return true;
  if (providerFlag === false) return false;
  return null;
}
