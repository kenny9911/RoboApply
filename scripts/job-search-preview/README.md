# Job search visual harness

Run `node scripts/job-search-preview.mjs` using Node 24, then open:

- `http://localhost:3613/job-search`
- `http://localhost:3613/job-search/developers`
- `http://localhost:3613/developers/job-search`

This imports the actual website components with a fixture API at build time. The shared preview server binds to loopback, rejects live API requests, and uses a CSP that blocks network connections. Every role, employer, and generated credential is explicitly labeled as example data. No provider call, database mutation, or authentication is performed.

Describe a role and location to inspect the agent results. The fixture always returns a clearly fictional two-query plan; it does not call a language model. Add `?scenario=partial`, `empty`, `error`, `agent_unavailable`, `rate_limited`, or `unconfigured` to inspect alternate states. Add `&locale=zh-TW` or `&theme=dark` for locale/theme review. The preview retains keys only in browser memory.

Automated UI coverage: `npx vitest run __tests__/pages/job-search.test.tsx __tests__/lib/job-search-format.test.ts`.
