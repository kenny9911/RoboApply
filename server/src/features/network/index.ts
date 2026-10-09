// server/src/features/network/index.ts — public surface of NET (FND-5; owner WP-54).
// The Assistant's find_connections tool and the job-detail People tab use `connectionsForJob`.

import { NotImplementedError } from '../../platform/http.js';
import type { ConnectionsForJobResponse } from './contract.js';

export * from './contract.js';
export { createNetworkRouter, requireHiringContactsOn } from './routes.js';

export interface NetworkService {
  connectionsForJob(userId: string, jobId: string): Promise<ConnectionsForJobResponse>;
}

export const networkService: NetworkService = {
  async connectionsForJob() {
    throw new NotImplementedError('network.connectionsForJob');
  },
};
