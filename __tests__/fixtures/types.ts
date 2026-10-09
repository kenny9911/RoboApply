// __tests__/fixtures/types.ts — the shape of a request fixture (FND-7).

/** A request body/query that must parse with `schema` from server/src/features/<contract>/contract.ts. */
export interface RequestFixture {
  /** Contract folder under server/src/features (e.g. 'feed', 'jobs/detail'). */
  contract: string;
  /** Exported zod schema name in that contract. */
  schema: string;
  value: unknown;
  /** false = the schema must REJECT this value (negative fixture). */
  valid?: boolean;
}
