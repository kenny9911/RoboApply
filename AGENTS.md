<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# RoboApply repository guide

## Architecture

- The repository root is a Next.js 16 App Router frontend.
- `server/` is the Express TypeScript API. It is mounted on Vercel through
  `api/index.ts` and locally uses the port configured by `.env` (`4607` by
  default).
- `interview-agent/` is a separate, long-running LiveKit worker. It is not a
  Vercel serverless function and has its own package, environment, and build.
- Prisma's source schema is `server/prisma/schema.prisma`. The generated client
  under `server/src/generated/prisma/` is generated output; do not hand-edit it.
- Production browser requests use same-origin `/api/*` paths. In development,
  `next.config.mjs` rewrites them to `NEXT_PUBLIC_API_URL`.

## Working rules

- Preserve existing user changes and keep edits narrowly scoped to the task.
- Never commit `.env`, `.env.local`, credentials, tokens, or copied production
  data. Use `.env.example` when documenting configuration.
- Keep frontend API access behind modules in `lib/api/`; do not scatter raw API
  URLs through components.
- Keep Express route handlers thin and put reusable business logic in the
  corresponding server service or library module.
- Maintain the existing ESM conventions and `.js` suffixes in relative imports
  from server TypeScript source.
- When changing authentication, keep the frontend and backend session-cookie
  constants aligned and verify both login and `/auth/me` behavior.
- When changing user-facing copy, update every supported locale and run the
  repository's copy checks. Use the `i18n-locale-sync` skill for locale work.

## Common commands

```bash
npm run dev                 # Express + readiness-gated Next + voice-worker supervisor
npm run dev:server          # Express API only
npm run dev:web             # Next frontend only, port 3611
npm test                    # Full Vitest suite
npm run typecheck:server    # Express TypeScript check
npm run check               # Design and copy policy checks
npm run build               # Prisma generate + server build + Next production build
npm run db:generate         # Regenerate Prisma client after schema changes
```

Use Node 24.x and the committed `package-lock.json`; install dependencies with
`npm install` unless the task explicitly requires a lockfile refresh.

## Verification

- Run the smallest relevant test first, then the full affected suite.
- Frontend or shared changes: run `npm test` and the applicable `npm run check`
  commands.
- Server changes: run `npm run typecheck:server` and relevant server tests.
- Schema changes: run `npm run db:generate`, then server type-check/tests. Do
  not run `db:push` against an unknown database.
- Deployment-affecting changes: run `npm run build` when it is safe to do so.
  Avoid running a Next production build against the same `.next` directory as
  an active `next dev` process.
