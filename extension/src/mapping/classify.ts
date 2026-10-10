// extension/src/mapping/classify.ts — label / name / autocomplete → canonical FieldKey.
//
// The adapter's own hint wins, then the HTML autocomplete token, then label
// patterns (English and Chinese). Long labels are questions, not fields.

import { normalizeText } from '../adapters/_kit/options';
import type { FieldHandle, FieldKey } from '../adapters/types';

const AUTOCOMPLETE: Record<string, FieldKey> = {
  'given-name': 'firstName',
  'family-name': 'lastName',
  name: 'fullName',
  nickname: 'preferredName',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  'address-line1': 'addressLine1',
  'street-address': 'addressLine1',
  'address-level2': 'city',
  'address-level1': 'region',
  'postal-code': 'postalCode',
  country: 'country',
  'country-name': 'country',
  organization: 'currentCompany',
  'organization-title': 'currentTitle',
  url: 'website',
};

// Patterns are anchored: a label IS the field ("Email address"), it does not
// merely mention it ("Can we email you about future roles?").
const LABELS: Array<[RegExp, FieldKey]> = [
  [/^preferred (first )?name|^nickname/, 'preferredName'],
  [/^(legal )?first name|^given name|^名字?$/, 'firstName'],
  [/^(legal )?last name|^surname|^family name|^姓$/, 'lastName'],
  [/^(full |legal |your )?name$|^姓名$/, 'fullName'],
  [/^(your |contact |personal |work )?(e-?mail|email)( address)?$|^(邮箱|郵箱|电子邮件|電子郵件|电子邮箱|電子郵箱)(地址)?$/, 'email'],
  [/^(your |contact )?((mobile|cell|home|work|primary) )?(phone|mobile|cell|telephone|tel)( (phone|number|no))*$|^(联系|聯絡)?(手机|手機|电话|電話)(号码|號碼|号)?$/, 'phone'],
  [/^(your )?linkedin( (profile|url|link|page|address))*$/, 'linkedin'],
  [/^(your )?github( (profile|url|link|username|handle|address))*$/, 'github'],
  [/^(your )?(portfolio|作品集)( (url|link|website|site|address))*$/, 'portfolio'],
  [/^twitter|^x( profile| handle| url)?$/, 'x'],
  [/^(personal |other )?(website|web site|blog)( url)?$|^个人网站|^個人網站/, 'website'],
  [/^(current )?location$|^where are you (currently )?(located|based)|^current city|^所在地|^现居/, 'location'],
  [/^(street )?address( line 1)?$|^地址$/, 'addressLine1'],
  [/^city$|^城市$/, 'city'],
  [/^(state|province|region)( \/ province)?$|^省份?$/, 'region'],
  [/^(zip|postal)( code)?$|^zip \/ postal code$|^postal \/ zip code$|^(邮编|郵遞區號|邮政编码|郵政編碼)$/, 'postalCode'],
  [/^country( of residence)?$|^国家$|^國家$/, 'country'],
  [/^(current |most recent )?(company|employer)( name)?$/, 'currentCompany'],
  [/^(current |most recent )?(job )?title$/, 'currentTitle'],
  [/^(school|university|college)( name)?$|^学校$|^學校$/, 'school'],
  [/^degree$|^学位$/, 'degree'],
  [/^(discipline|major|field of study)$|^专业$|^主修$/, 'discipline'],
];

/** Contact and link keys never go into a choice (radio / checkbox). */
const CONTACT_KEYS: ReadonlySet<FieldKey> = new Set(['email', 'phone', 'linkedin', 'github', 'portfolio', 'x', 'website']);
const CHOICE_KINDS: ReadonlySet<FieldHandle['kind']> = new Set(['radio', 'checkbox']);

const RESUME_RE = /resume|cv\b|curriculum|简历|簡歷|履歷|履历/;
const COVER_RE = /cover letter|求职信|求職信|自荐信/;

/** Labels longer than this are questions, not profile fields. */
export const MAX_FIELD_LABEL = 48;

export function classifyField(field: FieldHandle): FieldKey | null {
  if (field.hint) return field.hint;
  const ac = (field.element.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/).pop() ?? '';
  if (ac && AUTOCOMPLETE[ac]) return AUTOCOMPLETE[ac];
  const label = normalizeText(field.label);
  if (field.kind === 'file') {
    if (COVER_RE.test(label)) return 'coverLetter';
    if (RESUME_RE.test(label)) return 'resume';
    return null;
  }
  if (!label || label.length > MAX_FIELD_LABEL) return null;
  // A label written as a question is a question, not a profile field.
  if (/[?？]\s*\*?\s*$/.test(field.label.trim())) return null;
  for (const [re, key] of LABELS) {
    if (!re.test(label)) continue;
    if (CONTACT_KEYS.has(key) && CHOICE_KINDS.has(field.kind)) return null;
    return key;
  }
  return null;
}
