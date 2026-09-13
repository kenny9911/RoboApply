/** One bounded live website search. No subscriptions, key output, or saved job data. */
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env'), override: false, quiet: true });
dotenv.config({ path: path.join(root, '.env.local'), override: false, quiet: true });
const { jobSearchService } = await import('../server/src/job-search/service.js');
const configured = jobSearchService.providers('website');
const providers = configured.filter(provider => provider.enabled).slice(0, 2).map(provider => provider.id);
const started = Date.now();
const result = providers.length ? await jobSearchService.search({
  query: 'software engineer', country: 'tw', location: 'Taipei', limit: 10, providers,
}, { requestId: 'local-job-search-smoke', audience: 'website' }) : null;
const report = {
  checkedAt: new Date().toISOString(), kind: 'single-live-provider-smoke',
  country: 'tw', durationMs: Date.now() - started,
  configured: configured.map(({ id, enabled, reason }) => ({ id, enabled, reason })),
  attemptedProviders: providers, resultCount: result?.meta.totalReturned ?? 0,
  deduplicated: result?.meta.deduplicated ?? 0, partial: result?.meta.partial ?? true,
  outcomes: result?.meta.providers ?? [],
  dataQuality: result ? {
    withDescription: result.jobs.filter(job => job.description.length > 100).length,
    withPublicationDate: result.jobs.filter(job => job.postedAt !== null).length,
    withSalary: result.jobs.filter(job => job.salary !== null).length,
    withDirectApply: result.jobs.filter(job => job.applyIsDirect).length,
  } : null,
};
await mkdir(path.join(root, 'logs'), { recursive: true });
await writeFile(path.join(root, 'logs/job-search-live-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exitCode = result?.meta.providers.some(p => p.status === 'ok' || p.status === 'empty') ? 0 : 2;
