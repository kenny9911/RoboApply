// server/src/features/profile/twFieldsStore.ts
//
// Typed adapter for `RAProfile.twFields` (`Json?`, schema request SR-WP19-1,
// in the schema since SCHEMA-2). The column is part of the generated client,
// so reads and writes go through the typed field: nothing here inspects the
// client at run time or casts around it any more (WP-93 removed that shim).
//
// `createTwFieldsStore(false)` remains as a plain switch for a store that
// must not persist the Taiwan section (the profile then reports
// `availability.twFields = false`, the page hides the section, and a write
// answers `501 not_implemented`); the default store is always available.

import { Prisma } from '../../generated/prisma/client.js';
import { HttpError } from '../../platform/http.js';
import { TwProfileFieldsSchema, type TwProfileFields } from '../tw/index.js';

export const TW_FIELDS_SCHEMA_REQUEST = 'SR-WP19-1';

/**
 * Always true: `RAProfile.twFields` is a typed column (this file would not
 * compile without it).
 * @deprecated Kept for callers written before SCHEMA-2; use the store's `available`.
 */
export function twFieldsColumnPresent(): boolean {
  return true;
}

export interface TwFieldsStore {
  readonly available: boolean;
  /** The stored value from a full RAProfile row (null when absent or unavailable). */
  read(row: object | null): unknown;
  /** The update data for a write; throws 501 when this store does not persist the section. */
  data(value: TwProfileFields | null): Prisma.RAProfileUncheckedUpdateInput;
}

export function createTwFieldsStore(available: boolean = true): TwFieldsStore {
  return {
    available,
    read(row) {
      if (!available || !row) return null;
      return (row as { twFields?: Prisma.JsonValue | null }).twFields ?? null;
    },
    data(value) {
      if (!available) {
        throw new HttpError('not_implemented', 'Taiwan profile fields are not stored on this deployment yet.', {
          schemaRequest: TW_FIELDS_SCHEMA_REQUEST,
        });
      }
      const checked = value === null ? null : TwProfileFieldsSchema.parse(value);
      const update: Prisma.RAProfileUncheckedUpdateInput = { twFields: checked === null ? Prisma.JsonNull : checked };
      return update;
    },
  };
}
