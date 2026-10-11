// scripts/board-seeds/places.mjs: which country a posting's location names.
//
// Used by the seed validator (./validate.mjs) to count a board's postings per
// ISO country. It reads LOCATION FIELDS ONLY (a location line, a stated
// country code or name), never a title or a posting text.
//
// The rule that matters is the one that routes a board to a market: "does this
// board list a posting located in mainland China, or in Taiwan?". The server
// decides a posting's market with its own parser (server/src/features/jobs/geo,
// `marketOfPosting`). This file cannot import it (plain Node, no dependency),
// so it is deliberately NARROWER than that parser where mainland China and
// Taiwan are concerned, never wider:
//
//   - mainland and Taiwan cities come ONLY from the server's own city table
//     (server/src/features/jobs/geo/cities.json, read at run time), so a city
//     the server would not place is not placed here either;
//   - a province alone ("Guangdong") places nothing, as on the server;
//   - Hong Kong, Macao and Taiwan are never mainland, whatever follows them
//     ("Hong Kong, China" is Hong Kong);
//   - mainland China and Taiwan are named only when every place in the line
//     agrees and the line ends on a place there (`countryOfLocation` below
//     has the rule and its examples). Where the server lets one part of a
//     line win ("Shanghai, Taipei"), this file places nothing.
//
// So a board's mainland and Taiwan counts are a floor: a posting counted here
// is one the server routes the same way, and a posting whose line this file
// does not understand is counted for the international market only. The test
// beside the server (server/src/features/jobs/sources/atsPublic/seeds.test.ts)
// holds that property on tens of thousands of generated location lines.
//
// Everything else (the ISO country names, US states, Canadian provinces and a
// short list of other large cities) only makes the per-country statistics of
// the report more complete. It never moves a board between seed files.
//
// Sources (public facts, D3): ISO 3166-1 alpha-2 codes and English short
// names; USPS state abbreviations; Canada Post province abbreviations.

import { readFileSync } from 'node:fs';

/** ISO 3166-1: `CODE|English name|other spelling|…`. */
const ISO_LINES = `
AD|Andorra
AE|United Arab Emirates|UAE|U.A.E.|Emirates
AF|Afghanistan
AG|Antigua and Barbuda
AI|Anguilla
AL|Albania
AM|Armenia
AO|Angola
AR|Argentina
AS|American Samoa
AT|Austria|Österreich
AU|Australia
AW|Aruba
AZ|Azerbaijan
BA|Bosnia and Herzegovina|Bosnia
BB|Barbados
BD|Bangladesh
BE|Belgium|Belgique|België
BF|Burkina Faso
BG|Bulgaria
BH|Bahrain
BI|Burundi
BJ|Benin
BM|Bermuda
BN|Brunei|Brunei Darussalam
BO|Bolivia
BR|Brazil|Brasil
BS|Bahamas|The Bahamas
BT|Bhutan
BW|Botswana
BY|Belarus
BZ|Belize
CA|Canada
CD|Democratic Republic of the Congo|DR Congo|DRC
CF|Central African Republic
CG|Republic of the Congo|Congo
CH|Switzerland|Schweiz|Suisse
CI|Côte d'Ivoire|Cote d'Ivoire|Ivory Coast
CL|Chile
CM|Cameroon
CN|China|People's Republic of China|PRC|Mainland China|China Mainland|中国|中國|中国大陆|中國大陸
CO|Colombia
CR|Costa Rica
CU|Cuba
CV|Cabo Verde|Cape Verde
CW|Curaçao|Curacao
CY|Cyprus
CZ|Czechia|Czech Republic
DE|Germany|Deutschland
DJ|Djibouti
DK|Denmark|Danmark
DM|Dominica
DO|Dominican Republic
DZ|Algeria
EC|Ecuador
EE|Estonia
EG|Egypt
ER|Eritrea
ES|Spain|España
ET|Ethiopia
FI|Finland|Suomi
FJ|Fiji
FO|Faroe Islands
FR|France
GA|Gabon
GB|United Kingdom|UK|U.K.|Great Britain|Britain|England|Scotland|Wales|Northern Ireland
GD|Grenada
GE|Georgia (country)
GF|French Guiana
GG|Guernsey
GH|Ghana
GI|Gibraltar
GL|Greenland
GM|Gambia|The Gambia
GN|Guinea
GP|Guadeloupe
GQ|Equatorial Guinea
GR|Greece
GT|Guatemala
GU|Guam
GW|Guinea-Bissau
GY|Guyana
HK|Hong Kong|Hong Kong SAR|香港
HN|Honduras
HR|Croatia
HT|Haiti
HU|Hungary
ID|Indonesia
IE|Ireland|Republic of Ireland
IL|Israel
IM|Isle of Man
IN|India
IQ|Iraq
IR|Iran
IS|Iceland
IT|Italy|Italia
JE|Jersey
JM|Jamaica
JO|Jordan
JP|Japan|日本
KE|Kenya
KG|Kyrgyzstan
KH|Cambodia
KN|Saint Kitts and Nevis
KR|South Korea|Korea|Republic of Korea|Korea, Republic of
KW|Kuwait
KY|Cayman Islands
KZ|Kazakhstan
LA|Laos
LB|Lebanon
LC|Saint Lucia
LI|Liechtenstein
LK|Sri Lanka
LR|Liberia
LS|Lesotho
LT|Lithuania
LU|Luxembourg
LV|Latvia
LY|Libya
MA|Morocco
MC|Monaco
MD|Moldova
ME|Montenegro
MG|Madagascar
MK|North Macedonia|Macedonia
ML|Mali
MM|Myanmar
MN|Mongolia
MO|Macao|Macau|Macao SAR|Macau SAR|澳門|澳门
MQ|Martinique
MR|Mauritania
MT|Malta
MU|Mauritius
MV|Maldives
MW|Malawi
MX|Mexico|México
MY|Malaysia
MZ|Mozambique
NA|Namibia
NC|New Caledonia
NE|Niger
NG|Nigeria
NI|Nicaragua
NL|Netherlands|The Netherlands|Holland|Nederland
NO|Norway|Norge
NP|Nepal
NZ|New Zealand
OM|Oman
PA|Panama
PE|Peru
PF|French Polynesia
PG|Papua New Guinea
PH|Philippines|The Philippines
PK|Pakistan
PL|Poland|Polska
PR|Puerto Rico
PS|Palestine
PT|Portugal
PY|Paraguay
QA|Qatar
RE|Réunion|Reunion
RO|Romania
RS|Serbia
RU|Russia|Russian Federation
RW|Rwanda
SA|Saudi Arabia|KSA|Kingdom of Saudi Arabia
SC|Seychelles
SD|Sudan
SE|Sweden|Sverige
SG|Singapore|新加坡
SI|Slovenia
SK|Slovakia
SL|Sierra Leone
SM|San Marino
SN|Senegal
SO|Somalia
SR|Suriname
SS|South Sudan
SV|El Salvador
SY|Syria
SZ|Eswatini
TC|Turks and Caicos Islands
TD|Chad
TG|Togo
TH|Thailand
TJ|Tajikistan
TM|Turkmenistan
TN|Tunisia
TO|Tonga
TR|Türkiye|Turkey|Turkiye
TT|Trinidad and Tobago
TW|Taiwan|台灣|臺灣|台湾|Taiwan, Province of China|Republic of China|R.O.C.
TZ|Tanzania
UA|Ukraine
UG|Uganda
US|United States|USA|U.S.|U.S.A.|United States of America|America
UY|Uruguay
UZ|Uzbekistan
VC|Saint Vincent and the Grenadines
VE|Venezuela
VG|British Virgin Islands
VI|U.S. Virgin Islands
VN|Vietnam|Viet Nam
VU|Vanuatu
WS|Samoa
XK|Kosovo
YE|Yemen
ZA|South Africa
ZM|Zambia
ZW|Zimbabwe
`;

/** USPS abbreviations and names. "Georgia" is left out as a name: it is also a country, and the line alone decides nothing. */
const US_STATE_LINES =
  'AL|Alabama,AK|Alaska,AZ|Arizona,AR|Arkansas,CA|California,CO|Colorado,CT|Connecticut,DE|Delaware,DC|District of Columbia,FL|Florida,GA|,HI|Hawaii,' +
  'ID|Idaho,IL|Illinois,IN|Indiana,IA|Iowa,KS|Kansas,KY|Kentucky,LA|Louisiana,ME|Maine,MD|Maryland,MA|Massachusetts,MI|Michigan,MN|Minnesota,' +
  'MS|Mississippi,MO|Missouri,MT|Montana,NE|Nebraska,NV|Nevada,NH|New Hampshire,NJ|New Jersey,NM|New Mexico,NY|New York State,NC|North Carolina,' +
  'ND|North Dakota,OH|Ohio,OK|Oklahoma,OR|Oregon,PA|Pennsylvania,RI|Rhode Island,SC|South Carolina,SD|South Dakota,TN|Tennessee,TX|Texas,UT|Utah,' +
  'VT|Vermont,VA|Virginia,WA|Washington State,WV|West Virginia,WI|Wisconsin,WY|Wyoming';

/** Canada Post abbreviations and names. NL and PE are left to the Netherlands and Peru, the commoner reading in a job location. */
const CA_PROVINCE_LINES = 'AB|Alberta,BC|British Columbia,MB|Manitoba,NB|New Brunswick,NS|Nova Scotia,ON|Ontario,QC|Quebec,SK|Saskatchewan';

/**
 * Large cities outside the server's city table, for the statistics only. None
 * is in mainland China, Taiwan, Hong Kong or Macao: those come from the
 * server's table alone (see the header).
 */
const EXTRA_CITY_LINES = `
DE|Leipzig|Dresden|Nuremberg|Nürnberg|Hanover|Hannover|Karlsruhe|Bonn|Dortmund|Essen|Bremen|Darmstadt|Heidelberg|Mannheim|Aachen|Potsdam
FR|Grenoble|Nantes|Bordeaux|Lille|Montpellier|Rennes|Strasbourg|Sophia Antipolis
NL|Delft|Groningen|Leiden|Haarlem|Hoofddorp
ES|Málaga|Malaga|Seville|Sevilla|Bilbao|Zaragoza
PT|Braga|Coimbra
IT|Turin|Torino|Bologna|Florence|Firenze|Naples|Napoli
CH|Lausanne|Zug|Bern|Lugano
SE|Malmö|Malmo|Uppsala|Lund
DK|Aarhus|Odense
NO|Bergen|Trondheim|Stavanger
FI|Espoo|Tampere|Oulu|Turku
PL|Wrocław|Wroclaw|Gdańsk|Gdansk|Poznań|Poznan|Łódź|Lodz|Katowice
CZ|Brno|Ostrava
BE|Antwerp|Antwerpen|Ghent|Gent|Leuven
AT|Graz|Linz|Salzburg
IE|Limerick
RO|Bucharest|București|Cluj-Napoca|Cluj|Iași|Iasi|Timișoara|Timisoara|Brașov|Brasov
HU|Budapest
GR|Athens|Thessaloniki
BG|Sofia|Plovdiv
RS|Belgrade|Novi Sad
HR|Zagreb
SI|Ljubljana
SK|Bratislava|Košice|Kosice
LT|Vilnius|Kaunas
LV|Riga
EE|Tallinn|Tartu
UA|Kyiv|Kiev|Lviv|Kharkiv|Odesa
TR|Ankara|Izmir
LU|Luxembourg City
CY|Limassol|Nicosia|Larnaca
MT|Valletta|Sliema
IS|Reykjavik|Reykjavík
IL|Herzliya|Haifa|Jerusalem|Petah Tikva|Ramat Gan|Ra'anana|Netanya|Yokneam
AE|Sharjah
SA|Riyadh|Jeddah|Dhahran
QA|Doha
KW|Kuwait City
BH|Manama
JO|Amman
LB|Beirut
MA|Casablanca|Rabat
GH|Accra
TN|Tunis
RW|Kigali
UG|Kampala
TZ|Dar es Salaam
ET|Addis Ababa
SN|Dakar
ZA|Durban|Pretoria
MY|Penang|George Town|Johor Bahru|Petaling Jaya|Cyberjaya
TH|Chiang Mai
VN|Da Nang
PH|Makati|Taguig|Cebu|Cebu City|Quezon City|Pasig
ID|Bandung|Surabaya|Yogyakarta
AU|Hobart|Gold Coast|Newcastle NSW
NZ|Christchurch
PK|Karachi|Lahore|Islamabad
BD|Dhaka
LK|Colombo
NP|Kathmandu
KH|Phnom Penh
IN|Kochi|Coimbatore|Jaipur|Indore|Chandigarh|Thiruvananthapuram|Trivandrum|Nagpur|Lucknow|Vadodara|Mysuru|Mysore|Navi Mumbai|Thane
JP|Kobe|Sendai|Hiroshima|Kawasaki|Chiba
KR|Daejeon|Daegu|Suwon|Pangyo
BR|Belo Horizonte|Florianópolis|Florianopolis|Curitiba|Porto Alegre|Recife|Brasília|Brasilia|Campinas
MX|Tijuana|Querétaro|Queretaro|Puebla
AR|Córdoba|Cordoba|Rosario|Mendoza
CO|Medellín|Medellin|Cali|Barranquilla
PE|Lima
UY|Montevideo
EC|Quito|Guayaquil
PA|Panama City
DO|Santo Domingo
GT|Guatemala City
CA|Kitchener|Hamilton|Markham|Burnaby|Surrey|Saskatoon|Regina|London ON|Laval|Gatineau|Kelowna
US|Brooklyn|Manhattan|Queens|Bronx|San Bruno|South San Francisco|Fremont|Berkeley|Emeryville|San Rafael|Santa Barbara|Culver City|El Segundo|Burbank|Glendale|Torrance|Hawthorne|Costa Mesa|Carlsbad|Los Gatos|Foster City|Milpitas|Pleasanton|San Ramon|Walnut Creek|Santa Cruz|Fort Collins|Colorado Springs|Lehi|Provo|Draper|Tacoma|Spokane|Hillsboro|Beaverton|Chandler|Mesa|Gilbert|Henderson|Reno|Frisco|Round Rock|The Woodlands|Sugar Land|Richardson|Alpharetta|Sandy Springs|Durham NC|Cary|Chapel Hill|Morrisville|Charleston|Greenville|Savannah|Fort Lauderdale|Boca Raton|West Palm Beach|St. Petersburg|Tallahassee|Gainesville|Hoboken|Brookline|Somerville|Waltham|Burlington|Lexington|Worcester|New Haven|Wilmington|King of Prussia|Bethesda|Rockville|Silver Spring|Tysons|Herndon|Chantilly|Alexandria|Fairfax|Norfolk|Virginia Beach|Annapolis|Troy|Dearborn|Grand Rapids|Southfield|Evanston|Naperville|Schaumburg|Bloomington|St. Paul|Saint Paul|Overland Park|Lincoln|Tulsa|Little Rock|Baton Rouge|Knoxville|Chattanooga|Lexington KY|Dayton|Akron|Toledo|Syracuse|Albany|White Plains|Long Island City|Fargo|Sioux Falls|Bozeman|Missoula|Cheyenne|Santa Fe|Wichita|Bentonville|Fayetteville|Greensboro|Winston-Salem|Columbia|Mobile|Jackson|Lansing|Green Bay|Cedar Rapids|Iowa City|Champaign|South Bend|Fort Wayne|Harrisburg|Allentown|Trenton|Camden|Manchester NH|Portsmouth|Burlington VT|Bangor|Juneau|Hilo
`;

const fold = (s) =>
  String(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[.’'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** ISO alpha-2 codes that are valid. */
export const ISO_CODES = new Set();
/** folded name or spelling -> ISO code. */
const COUNTRY_BY_NAME = new Map();
/** ISO code -> English name. */
export const COUNTRY_NAMES = new Map();
for (const line of ISO_LINES.trim().split('\n')) {
  const [code, ...names] = line.split('|');
  ISO_CODES.add(code);
  COUNTRY_NAMES.set(code, names[0].replace(' (country)', ''));
  for (const name of names) COUNTRY_BY_NAME.set(fold(name), code);
}
// "Georgia" alone is the country OR the US state: the line decides nothing (the server's parser places nothing either).
COUNTRY_BY_NAME.delete(fold('Georgia (country)'));

const US_STATE_CODES = new Set();
const REGION_BY_NAME = new Map();
for (const pair of US_STATE_LINES.split(',')) {
  const [code, name] = pair.split('|');
  US_STATE_CODES.add(code);
  if (name) REGION_BY_NAME.set(fold(name.replace(/ State$/, '')), 'US');
}
// "New York" and "Washington" are cities in the server's table; as a state name they say the same country.
const CA_PROVINCE_CODES = new Set();
for (const pair of CA_PROVINCE_LINES.split(',')) {
  const [code, name] = pair.split('|');
  CA_PROVINCE_CODES.add(code);
  REGION_BY_NAME.set(fold(name), 'CA');
}

/** The countries whose cities come only from the server's own table. */
const SERVER_ONLY = new Set(['CN', 'TW', 'HK', 'MO']);

/** Where the server keeps its city table, seen from this file. */
export const SERVER_CITIES_URL = new URL('../../server/src/features/jobs/geo/cities.json', import.meta.url);

/**
 * folded city name -> ISO code. The server's table first (names, Chinese names
 * and aliases), then the extra list for other countries. Without the server's
 * table (`serverCities` null) no mainland or Taiwan city is known, and the
 * caller is told so (`serverTable: false`).
 */
export function buildCityIndex(serverCities) {
  const index = new Map();
  // folded city name -> folded name of its province or state, for the server's cities that state one.
  index.regions = new Map();
  // every such province or state name.
  index.regionNames = new Set();
  const add = (name, country, region = null) => {
    const key = fold(name);
    if (!key || index.has(key)) return;
    index.set(key, country);
    if (region) {
      index.regions.set(key, fold(region));
      index.regionNames.add(fold(region));
    }
  };
  for (const city of serverCities ?? []) {
    if (!city || typeof city.country !== 'string' || typeof city.name !== 'string') continue;
    for (const name of [city.name, city.zh, city.zhHant, ...(Array.isArray(city.aliases) ? city.aliases : [])]) {
      if (typeof name === 'string') add(name, city.country, typeof city.region === 'string' ? city.region : null);
    }
  }
  for (const line of EXTRA_CITY_LINES.trim().split('\n')) {
    const [country, ...names] = line.split('|');
    if (SERVER_ONLY.has(country)) continue;
    for (const name of names) add(name, country);
  }
  return index;
}

/** Reads the server's city table; null when it is not there (the script was copied out of the repository). */
export function loadServerCities(url = SERVER_CITIES_URL) {
  try {
    const parsed = JSON.parse(readFileSync(url, 'utf8'));
    return Array.isArray(parsed?.cities) ? parsed.cities : null;
  } catch {
    return null;
  }
}

let defaultIndex = null;
function cityIndex() {
  if (!defaultIndex) defaultIndex = buildCityIndex(loadServerCities());
  return defaultIndex;
}

/** An ISO alpha-2 code or a country name ("cn", "TW", "United States") -> the code, else null. For fields that state a country. */
export function countryFromField(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (/^[A-Za-z]{2}$/.test(text)) {
    const code = text.toUpperCase();
    if (code === 'UK') return 'GB';
    return ISO_CODES.has(code) ? code : null;
  }
  return COUNTRY_BY_NAME.get(fold(text)) ?? null;
}

/** How a posting is worked, written into a location line. It says nothing about where, and nothing against a place beside it. */
const WORK_MODE_WORDS = /^(remote|hybrid|onsite|on-site)$/;
const WORDS_THAT_PLACE_NOTHING = /^(remote|hybrid|onsite|on-site|in office|anywhere|global|worldwide|multiple locations|various|emea|apac|amer|americas|latam|europe|asia|nordics|dach|benelux|mena|anz|greater china|eu|na)$/;

/** Two-letter codes that are an Australian state when the line names an Australian city ("Perth, WA"). */
const AU_STATE_CODES = new Set(['WA', 'SA', 'NT']);
for (const [name, country] of [['nsw', 'AU'], ['vic', 'AU'], ['qld', 'AU'], ['tas', 'AU'], ['new south wales', 'AU'], ['queensland', 'AU'], ['western australia', 'AU'], ['south australia', 'AU'], ['tasmania', 'AU']]) {
  REGION_BY_NAME.set(name, country);
}

const one = (set) => (set.size === 1 ? [...set][0] : null);

/**
 * The country one location line names, or null.
 *
 * A line is read as ONE place, as the server reads it. It is split where the
 * server splits it (commas, semicolons, slashes, bars, brackets, a dash with
 * spaces around it), and each part is looked up whole: a country name, a
 * country code, a state or province (name, code, or code with a postal code),
 * a city.
 *
 * Mainland China and Taiwan are named only when every place in the line
 * agrees and the line ENDS on a place there (the country, one of the server's
 * cities, the province of such a city) or on a word for how the job is worked
 * (remote, hybrid, on-site). The server reads a line from its end and skips
 * what it does not know before the place; this reading does the same and is
 * otherwise narrower on purpose (the server lets one part win), so a board is
 * never counted for the mainland or for Taiwan on a line the server would
 * place elsewhere or nowhere:
 *
 *   "Shanghai", "Shanghai, China", "Remote - China"     CN
 *   "Shenzhen, Guangdong, China"                        CN (Guangdong is Shenzhen's province)
 *   "Taipei, Taiwan", "Taiwan (Remote)"                 TW
 *   "Home based - Asia Pacific, Taipei"                 TW (what precedes the place is skipped)
 *   "CH - Shanghai, China"                              CN (a two-letter label that opens the line is skipped)
 *   "Hong Kong, China"                                  HK (never mainland)
 *   "Shanghai, Taipei", "Shanghai / Tokyo"              nothing
 *   "China, APAC", "Shanghai, Jiangsu", "Guangdong"     nothing (the line ends on something that is not understood, or not that city's province)
 *   "Shanghai or Beijing", "Shanghai-CN"                nothing (not split, so not a known place)
 *   "Canton, MA", "110 Albany Turnpike, Canton, CT 06019"   US (the server's table knows Canton
 *                                                       as an old name of Guangzhou; a state says otherwise)
 *
 * For every other country, in this order: a state or province code
 * ("Paris, TX"), a country name, a state or province name, a country code, a
 * city. A two-letter code with two readings ("CA", "IN", "DE", "WA") is the
 * one a city or country of the same line agrees with ("Toronto, CA",
 * "Berlin, DE", "Perth, WA"), else the US state or Canadian province.
 */
export function countryOfLocation(line, index = cityIndex()) {
  if (typeof line !== 'string') return null;
  const text = line.normalize('NFKC').trim();
  if (!text) return null;
  const split = text
    .split(/[,;|/()[\]\n]|\s[-–—]\s|[–—]/)
    .map((p) => p.trim())
    .filter(Boolean);
  // A two-letter code that opens a line is a board's own label more often than a place ("CH - Shanghai, China"
  // on a board that writes CH for China). The server reads from the end and never lets it decide; when the rest
  // of the line is mainland China or Taiwan by the rule below, so it is here. Not for HK, MO and TW: a line that
  // opens with one of them is never mainland.
  if (split.length > 1 && /^[A-Z]{2}$/.test(split[0]) && !['HK', 'MO', 'TW'].includes(split[0])) {
    const rest = placeOfParts(split.slice(1), null, index);
    if (rest === 'CN' || rest === 'TW') return rest;
  }
  return placeOfParts(split, text, index);
}

function placeOfParts(split, text, index) {
  const names = new Set(); // country names
  const regionNames = new Set(); // state or province names
  const cities = new Set();
  const codes = []; // two-letter codes and their readings
  // The parts in the order of the line, for the mainland and Taiwan rule: 'place', 'mode' (how the job is
  // worked), 'province' (of one of the server's cities), 'unknown'.
  const sequence = [];
  const look = (part, counted) => {
    const key = fold(part);
    if (!key) return;
    const note = (kind, extra = {}) => {
      if (counted) sequence.push({ kind, key, ...extra });
    };
    if (WORDS_THAT_PLACE_NOTHING.test(key)) return note(WORK_MODE_WORDS.test(key) ? 'mode' : 'unknown');
    // A state or province code followed by its postal code ("CT 06019", "ON M5V 2T6") is that state: an address line.
    const withZip = /^([A-Z]{2})\s+(?:\d{5}(?:-\d{4})?|[A-Z]\d[A-Z]\s?\d[A-Z]\d)$/.exec(part);
    if (withZip && (US_STATE_CODES.has(withZip[1]) || CA_PROVINCE_CODES.has(withZip[1]))) {
      codes.push([{ country: US_STATE_CODES.has(withZip[1]) ? 'US' : 'CA', region: true }]);
      return note('place');
    }
    if (/^[A-Z]{2}$/.test(part)) {
      const readings = [];
      if (US_STATE_CODES.has(part)) readings.push({ country: 'US', region: true });
      if (CA_PROVINCE_CODES.has(part)) readings.push({ country: 'CA', region: true });
      if (AU_STATE_CODES.has(part)) readings.push({ country: 'AU', region: true, needsCity: true });
      const iso = part === 'UK' ? 'GB' : ISO_CODES.has(part) ? part : null;
      if (iso) readings.push({ country: iso, region: false });
      if (readings.length > 0) {
        codes.push(readings);
        return note('place');
      }
    }
    const byName = COUNTRY_BY_NAME.get(key);
    if (byName) {
      names.add(byName);
      return note('place');
    }
    const byCity = index.get(key);
    if (byCity) {
      cities.add(byCity);
      return note('place', { province: index.regions?.get(key) ?? null });
    }
    const byRegion = REGION_BY_NAME.get(key);
    if (byRegion) {
      regionNames.add(byRegion);
      return note('place');
    }
    if (index.regionNames?.has(key)) return note('province');
    // Not understood. If a word in it is a place on its own ("Greater Shanghai Area"), the server may read it as one.
    const words = key.split(/[\s-]+/).filter(Boolean);
    const grams = [...words, ...words.slice(1).map((w, i) => `${words[i]} ${w}`)];
    return note('unknown', { namesAPlace: grams.some((g) => index.has(g) || COUNTRY_BY_NAME.has(g) || index.regionNames?.has(g)) });
  };
  for (const part of split) look(part, true);
  // The line as a whole may be a name the split broke ("Korea, Republic of"); it is not a part of the sequence.
  if (text && (split.length !== 1 || split[0] !== text)) look(text, false);

  const regionCodes = new Set();
  const countryCodes = new Set();
  for (const readings of codes) {
    const pick = readings.find((r) => cities.has(r.country) || names.has(r.country)) ?? readings.find((r) => !r.needsCity);
    if (pick) (pick.region ? regionCodes : countryCodes).add(pick.country);
  }

  const all = new Set([...names, ...regionNames, ...cities, ...regionCodes, ...countryCodes]);
  if (all.size === 0) return null;

  const guarded = ['CN', 'TW'].filter((c) => all.has(c));
  if (guarded.length > 0) {
    if (all.size === 1) return endsOnThePlace(sequence) ? one(all) : null;
    const said = new Set([...names, ...countryCodes]);
    // Hong Kong or Macao beside "China" is Hong Kong or Macao.
    if (!all.has('TW') && all.size === 2 && (all.has('HK') || all.has('MO'))) return all.has('HK') ? 'HK' : 'MO';
    // The line itself says China or Taiwan and something else: nothing.
    if (guarded.some((c) => said.has(c))) return null;
    // Only a city name pointed there ("Canton"): what the line says otherwise decides, a state code first.
    for (const level of [regionCodes, names, regionNames, countryCodes]) {
      const rest = new Set([...level].filter((c) => c !== 'CN' && c !== 'TW'));
      if (rest.size > 0) return one(rest);
    }
    return null;
  }
  for (const level of [regionCodes, names, regionNames, countryCodes, cities]) {
    if (level.size > 0) return one(level);
  }
  return null;
}

/**
 * The mainland and Taiwan rule on the parts of a line whose places all agree.
 * The server reads a line from its end, so:
 *   - after the last place only a way of working may follow ("Taiwan (Remote)");
 *   - a province is fine only right after a city of that province
 *     ("Shenzhen, Guangdong, China"; not "Shanghai, Jiangsu", not
 *     "China, Guangdong, Shenzhen");
 *   - a part that is not understood is skipped when it comes before the place
 *     ("Home based - Asia Pacific, Taipei") and names no place itself (not
 *     "Greater Shanghai Area, Taipei").
 */
function endsOnThePlace(sequence) {
  let lastPlace = -1;
  sequence.forEach((part, i) => {
    if (part.kind === 'place') lastPlace = i;
  });
  if (lastPlace < 0) return false;
  for (let i = 0; i < sequence.length; i += 1) {
    const part = sequence[i];
    if (part.kind === 'province') {
      const previous = sequence[i - 1];
      if (!previous || previous.kind !== 'place' || previous.province !== part.key) return false;
    } else if (part.kind === 'unknown') {
      if (i > lastPlace || part.namesAPlace) return false;
    }
  }
  return true;
}

/**
 * The country of a posting's FIRST location when the board also states a
 * country for it (Lever `country`, Ashby's postal country, SmartRecruiters
 * `location.country`). The server weighs the stated country against the line's
 * own text; this file cannot repeat that weighing, so mainland China and
 * Taiwan are named only when the two do not disagree:
 *
 *   stated CN, "Shanghai" / "Remote" / "Greater China" / an unknown town   CN
 *   stated CN, "Hong Kong"                                                  HK (the text names another place)
 *   stated CN, "Taipei"; stated TW, "Shanghai"; stated US, "Shanghai"       nothing
 *   stated US, "London"                                                     GB (statistics only)
 *   no stated country                                                       the line alone (`countryOfLocation`)
 */
export function countryOfStatedLocation(line, stated, index = cityIndex()) {
  const byText = countryOfLocation(line, index);
  if (!stated || byText === stated) return byText ?? null;
  const guarded = (c) => c === 'CN' || c === 'TW';
  if (guarded(stated)) {
    // The text names a place somewhere else: that place when this file can name it, never the stated country.
    if (namesAnotherPlace(line, stated, index)) return byText && !guarded(byText) ? byText : null;
    return stated;
  }
  // Another country is stated: the text never makes it mainland China or Taiwan.
  if (guarded(byText)) return null;
  return byText ?? stated;
}

/** Does the line hold a word (or two or three words together) that is a place outside `country`? */
function namesAnotherPlace(line, country, index) {
  if (typeof line !== 'string') return false;
  const raw = line.normalize('NFKC').split(/[\s,;|/()[\]:·•–—-]+/).filter(Boolean);
  for (let i = 0; i < raw.length; i += 1) {
    if (/^[A-Z]{2}$/.test(raw[i])) {
      const code = raw[i] === 'UK' ? 'GB' : raw[i];
      if ((ISO_CODES.has(code) || US_STATE_CODES.has(code) || CA_PROVINCE_CODES.has(code)) && code !== country) return true;
    }
    for (let n = 1; n <= 3 && i + n <= raw.length; n += 1) {
      const gram = fold(raw.slice(i, i + n).join(' '));
      const place = COUNTRY_BY_NAME.get(gram) ?? index.get(gram) ?? REGION_BY_NAME.get(gram);
      if (place && place !== country) return true;
    }
  }
  return false;
}

/** How many cities the default index knows, and whether the server's table was found. */
export function gazetteerInfo() {
  const server = loadServerCities();
  return { serverTable: server !== null, serverCities: server?.length ?? 0, names: cityIndex().size, countries: ISO_CODES.size };
}
