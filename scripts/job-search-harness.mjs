#!/usr/bin/env node
/** Reproducible offline acceptance gate. Never subscribes or calls live providers. */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (Number(process.versions.node.split('.')[0]) !== 24) {
  console.error('Use Node 24.x for the RoboApply validation harness.');
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const full = process.argv.includes('--full');
const checks = [
  ['search-regressions', 'npx', ['vitest', 'run', 'server/src/job-search', 'server/src/roboapply/v2/lib/raRapidApiJobs.test.ts', 'server/src/roboapply/v2/lib/raFantasticJobs.test.ts', 'server/src/roboapply/v2/lib/raJobProviders.test.ts', '__tests__/pages/job-search.test.tsx', '__tests__/lib/job-search-format.test.ts']],
  ['server-types', 'npm', ['run', 'typecheck:server']],
  ['locale-integrity', 'node', ['scripts/check-job-search-locales.mjs']],
  ...(full ? [['repository-tests', 'npm', ['test']], ['repository-policy', 'npm', ['run', 'check']]] : []),
];
const report = { startedAt: new Date().toISOString(), node: process.version, mode: full ? 'full' : 'targeted', liveProviderCalls: false, checks: [] };
await mkdir(path.join(root, 'logs'), { recursive: true });
for (const [name, command, args] of checks) {
  const started = Date.now();
  console.log(`Running ${name}`);
  let output = '';
  const exitCode = await new Promise(resolve => {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { const value = data.toString(); output += value; process.stdout.write(value); });
    child.stderr.on('data', data => { const value = data.toString(); output += value; process.stderr.write(value); });
    child.on('error', error => { output += error.message; resolve(1); });
    child.on('close', code => resolve(code ?? 1));
  });
  const log = `logs/job-search-${name}.log`;
  await writeFile(path.join(root, log), output);
  report.checks.push({ name, command: [command, ...args], exitCode, durationMs: Date.now() - started, log });
  await writeFile(path.join(root, 'logs/job-search-harness.json'), `${JSON.stringify(report, null, 2)}\n`);
}
console.log('Report: logs/job-search-harness.json');
process.exitCode = report.checks.some(check => check.exitCode !== 0) ? 1 : 0;
