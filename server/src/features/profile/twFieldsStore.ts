// server/src/features/profile/twFieldsStore.ts
//
// Narrow typed adapter for `RAProfile.twFields` — schema request SR-WP19-1
// (`twFields Json?` on RAProfile, additive). Until SCHEMA-2 adds the column
// the generated client does not know the field, so:
//   - `columnPresent` is read from the generated client's field list, never
//     assumed;
//   - without the column, reads return null and writes are refused with
//     `501 not_implemented` (details name the schema request), and the
//     profile reports `availability.twFields = false` so the page hides the
//     Taiwan section instead of losing what the user types.
// After SCHEMA-2 nothing here changes: the column appears in the enum and the
// same code path persists it. This file is the only place that names the
// column outside the typed client.

import { Prisma } from '../../generated/prisma/client.js';
import { HttpError } from '../../platform/http.js';
import { TwProfileFieldsSchema, type TwProfileFields } from '../tw/index.js';

export const TW_FIELDS_SCHEMA_REQUEST = 'SR-WP19-1';
const COLUMN = 'twFields';

/** True when the generated client has `RAProfile.twFields`. */
export function twFieldsColumnPresent(): boolean {
  return Object.prototype.hasOwnProperty.call(Prisma.RAProfileScalarFieldEnum, COLUMN);
}

export interface TwFieldsStore {
  readonly available: boolean;
  /** The stored value from a full RAProfile row (null when absent or unavailable). */
  read(row: object | null): unknown;
  /** The update data for a write; throws 501 when the column is not there yet. */
  data(value: TwProfileFields | null): Prisma.RAProfileUncheckedUpdateInput;
}

export function createTwFieldsStore(columnPresent: boolean = twFieldsColumnPresent()): TwFieldsStore {
  return {
    available: columnPresent,
    read(row) {
      if (!columnPresent || !row) return null;
      return (row as Record<string, unknown>)[COLUMN] ?? null;
    },
    data(value) {
      if (!columnPresent) {
        throw new HttpError('not_implemented', 'Taiwan profile fields are not stored on this deployment yet.', {
          schemaRequest: TW_FIELDS_SCHEMA_REQUEST,
        });
      }
      const checked = value === null ? null : TwProfileFieldsSchema.parse(value);
      // The one cast in this area: the field is not in the generated input type until SR-WP19-1 lands.
      return { [COLUMN]: checked === null ? Prisma.JsonNull : (checked as Prisma.InputJsonValue) } as unknown as Prisma.RAProfileUncheckedUpdateInput;
    },
  };
}
