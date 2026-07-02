// api/index.mts — Vercel Serverless Function entry for the RoboApply API.
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
// MUST be `.mts`, not `.ts`: the root package.json has no `"type": "module"`
// (postcss.config.js is CJS), so a compiled `api/index.js` is classified as
// CommonJS by Node and its ESM `import` crashes the function at boot
// ("Cannot use import statement outside a module" — every API route 500'd).
// `.mts` compiles to `.mjs`, which Node always runs as ESM. The companion
// half of the fix is vercel.json's includeFiles: "server/**" (not just
// server/dist/**) so server/package.json — whose only job is to mark
// server/dist/**.js as ESM — actually ships inside the function bundle.

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — resolved at build time from the compiled server output.
import app from '../server/dist/app.js';

export default app;
