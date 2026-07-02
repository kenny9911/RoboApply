// api/index.ts — Vercel Serverless Function entry for the RoboApply API.
//
// Vercel builds a root-level /api directory as Serverless Functions even for a
// Next.js framework project. `vercel.json` rewrites `/api/v1/:path*` to this
// function; the Express app then routes on the original URL. @vercel/node
// invokes a default-exported Express app as (req, res), so raw-body webhooks
// and SSE/NDJSON streaming work exactly as they do on a normal Node server.
//
// The Express app is pre-compiled to server/dist by the Vercel build command
// (`prisma generate && tsc -p server/tsconfig.json && next build`), so this
// tiny function file only re-exports it — no heavy TS graph is bundled here.
//
// ESM invariants (every prod API route 500'd at boot until these held —
// "Cannot use import statement outside a module"):
//  - The ROOT package.json must carry `"type": "module"` so the compiled
//    /var/task/api/index.js (which keeps this ESM `import`) is classified as
//    ESM by Node. (An `.mts` entry is NOT an alternative — vercel.json's
//    `functions` pattern doesn't match .mts in the api/ directory.)
//  - vercel.json includeFiles must be "server/**" (not just server/dist/**)
//    so server/package.json — whose only job is marking server/dist/**.js as
//    ESM — actually ships inside the function bundle.

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — resolved at build time from the compiled server output.
import app from '../server/dist/app.js';

export default app;
