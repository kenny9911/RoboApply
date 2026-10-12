// server/src/features/jobs/geo/buildCities.ts
//
// Regenerates geo/cities.json from a GeoNames `cities15000.txt` export that
// someone has already downloaded (https://download.geonames.org/export/dump/,
// CC BY 4.0, attribution "GeoNames, geonames.org"). This module never
// downloads anything. The current cities.json is a hand-compiled seed; run
// this to replace it with GeoNames data:
//
//   npx tsx server/src/features/jobs/geo/buildCities.ts <cities15000.txt> [minPopulation] > cities.json
//
// Chinese names, aliases and non-US regions are carried over from the
// existing table (matched by country + name), because cities15000 has no
// language-tagged names and uses numeric admin1 codes outside the US.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { cityKey, type CityRecord, type CityTable } from './cities.js';

export const GEONAMES_SOURCE = {
  id: 'geonames_cities15000',
  name: 'GeoNames cities15000 (cities with a population of 15,000 or more)',
  publisher: 'GeoNames',
  url: 'https://www.geonames.org/',
  license: 'CC BY 4.0. Attribution: GeoNames, geonames.org.',
} as const;

export interface BuildOptions {
  /** ISO alpha-2 codes to keep (default: every country in the export). */
  countries?: readonly string[];
  /** Minimum population (default 15,000). */
  minPopulation?: number;
  /** The current table, whose Chinese names, aliases and regions are kept. */
  seed?: CityTable;
  asOf: string;
}

function slug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Pure: GeoNames tab-separated text → a city table (largest population first). */
export function buildCityTableFromGeoNames(tsv: string, options: BuildOptions): CityTable {
  const keep = options.countries ? new Set(options.countries.map((c) => c.toUpperCase())) : null;
  const minPop = options.minPopulation ?? 15_000;
  const seedByKey = new Map<string, CityRecord>();
  for (const c of options.seed?.cities ?? []) seedByKey.set(`${c.country}|${cityKey(c.name)}`, c);

  const rows: { rec: CityRecord; pop: number }[] = [];
  for (const line of tsv.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    if (f.length < 15) continue;
    const [, name, ascii, , lat, lng, featureClass, , cc, , admin1, , , , pop] = f;
    if (featureClass !== 'P') continue;
    const country = cc.toUpperCase();
    if (keep && !keep.has(country)) continue;
    const population = Number(pop);
    if (!Number.isFinite(population) || population < minPop) continue;
    const seed = seedByKey.get(`${country}|${cityKey(name)}`) ?? seedByKey.get(`${country}|${cityKey(ascii)}`);
    const rec: CityRecord = {
      id: seed?.id ?? `${country.toLowerCase()}-${slug(ascii || name)}`,
      name: seed?.name ?? name,
      ...(seed?.zh ? { zh: seed.zh } : {}),
      ...(seed?.zhHant ? { zhHant: seed.zhHant } : {}),
      ...(seed?.aliases?.length ? { aliases: seed.aliases } : ascii && ascii !== name ? { aliases: [ascii] } : {}),
      country,
      ...(country === 'US' && admin1 ? { region: admin1 } : seed?.region ? { region: seed.region } : {}),
      lat: round2(Number(lat)),
      lng: round2(Number(lng)),
    };
    rows.push({ rec, pop: population });
  }
  rows.sort((a, b) => b.pop - a.pop);

  // Unique ids: a later (smaller) namesake gets its region or a counter appended.
  const used = new Set<string>();
  const cities = rows.map(({ rec }) => {
    let id = rec.id;
    if (used.has(id) && rec.region) id = `${id}-${slug(rec.region)}`;
    for (let n = 2; used.has(id); n++) id = `${rec.id}-${n}`;
    used.add(id);
    return { ...rec, id };
  });
  return { version: (options.seed?.version ?? 0) + 1, asOf: options.asOf, source: { ...GEONAMES_SOURCE }, cities };
}

/* c8 ignore start — CLI wrapper, exercised by hand only. */
async function main(argv: string[]): Promise<void> {
  const [file, minPop] = argv;
  if (!file) throw new Error('usage: buildCities.ts <cities15000.txt> [minPopulation]');
  const seed = (await import('./cities.json', { with: { type: 'json' } })).default as CityTable;
  const table = buildCityTableFromGeoNames(readFileSync(file, 'utf8'), {
    seed,
    minPopulation: minPop ? Number(minPop) : undefined,
    asOf: new Date().toISOString().slice(0, 10),
  });
  process.stdout.write(`${JSON.stringify(table, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
/* c8 ignore stop */
