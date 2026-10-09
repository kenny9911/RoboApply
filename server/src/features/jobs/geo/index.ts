// server/src/features/jobs/geo/index.ts — public surface of the geo tables
// (WP-16a). Used by the normalizers (jobs/normalize), and available to the
// feed's location filter (WP-32) and the location typeahead (WP-20) to map a
// city name in any language ("上海", "Shanghai") to one table id.

export {
  CITIES,
  CITY_TABLE_AS_OF,
  CITY_TABLE_SOURCE,
  CITY_TABLE_VERSION,
  citiesNamed,
  cityById,
  cityKey,
  cityLabel,
  distanceKm,
  findCity,
  scanCjkCities,
  validateCityTable,
} from './cities.js';
export type { CityRecord, CityTable, CityTableSource } from './cities.js';
export {
  COUNTRIES,
  SUBDIVISIONS,
  countryByCode,
  countryByName,
  geoKey,
  resolveCountry,
  subdivision,
  subdivisionCountries,
} from './countries.js';
export type { CountryRecord, SubdivisionRecord } from './countries.js';
export { parseLocation, parseLocations, statedWorkModel } from './parseLocation.js';
export type { LocationHint, ParsedLocation, StatedWorkModel } from './parseLocation.js';
// buildCities.ts (the GeoNames regeneration script) is deliberately not
// re-exported: runtime code never needs it.
