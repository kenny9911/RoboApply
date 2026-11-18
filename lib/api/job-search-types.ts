/** Type-only entrypoint: the browser and API share one transport contract. */
export type * from '../../server/src/job-search/types';

export interface JobSearchKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

