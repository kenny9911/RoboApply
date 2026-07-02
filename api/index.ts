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

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — resolved at build time from the compiled server output.
import app from '../server/dist/app.js';

export default app;
