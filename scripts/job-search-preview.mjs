#!/usr/bin/env node
// Actual job search components with isolated in-memory fixtures, loopback only.
process.env.ROBOAPPLY_PREVIEW = 'job-search';
await import('./design-preview.mjs');
