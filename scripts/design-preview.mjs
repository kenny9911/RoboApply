#!/usr/bin/env node
// Developer-only fixture preview. No Next server, credentials, or live API.
// Run from the repository: node scripts/design-preview.mjs
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const preview = resolve(repo, 'scripts/design-preview');
const jobSearchPreview = process.env.ROBOAPPLY_PREVIEW === 'job-search';
const output = resolve(preview, '.memory');
const assets = new Map();
const port = jobSearchPreview ? 3613 : 3612;
let buildError = '';

const build = await context({
  absWorkingDir: repo,
  entryPoints: [resolve(repo, jobSearchPreview ? 'scripts/job-search-preview/entry.tsx' : 'scripts/design-preview/entry.tsx')],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2022'],
  jsx: 'automatic',
  outdir: output,
  entryNames: 'preview',
  external: ['/fonts/*'],
  write: false,
  sourcemap: 'inline',
  logLevel: 'warning',
  define: {
    'process.env.NODE_ENV': '"development"',
    'process.env.NEXT_PUBLIC_USE_STUB_API': '"true"',
    'process.env.NEXT_PUBLIC_API_URL': '""',
    'process.env.NEXT_PUBLIC_ROBOHIRE_URL': '"http://localhost:3612"',
    'process.env': '{}',
  },
  plugins: [{
    name: 'isolated-design-preview',
    setup(builder) {
      if (jobSearchPreview) builder.onResolve({ filter: /\/api\/job-search$/ }, ({ importer }) => {
        const fixture = resolve(repo, 'scripts/job-search-preview/api.ts');
        return importer === fixture ? undefined : { path: fixture };
      });
      builder.onResolve({ filter: /^next\/(navigation|link)$/ }, ({ path }) => ({
        path: resolve(preview, path.endsWith('/link') ? 'link.tsx' : 'navigation.ts'),
      }));
      builder.onResolve({ filter: /(?:^|\/)AuthProvider(?:\.tsx)?$/ }, () => ({
        path: resolve(preview, 'auth.tsx'),
      }));
      builder.onLoad({ filter: /app\/globals\.css$/ }, async ({ path }) => ({
        contents: (await postcss([
          tailwindcss({ config: resolve(repo, 'tailwind.config.ts') }),
          autoprefixer(),
        ]).process(await readFile(path, 'utf8'), { from: path })).css,
        loader: 'css',
        resolveDir: dirname(path),
      }));
      builder.onEnd((result) => {
        buildError = result.errors.map((error) => error.text).join('\n');
        if (buildError) return;
        for (const file of result.outputFiles ?? []) {
          assets.set(`/${file.path.slice(output.length + 1)}`, file.contents);
        }
      });
    },
  }],
});
await build.rebuild();
if (buildError) throw new Error(buildError);
await build.watch();

const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; media-src 'none'; frame-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
const types = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };
const html = `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>RoboApply · Design preview</title><link rel="stylesheet" href="/preview.css"></head><body><div id="design-preview-banner" role="status">Design preview · Example data <span>Local only · Live actions disabled</span></div><div id="root"></div><script type="module" src="/preview.js"></script></body></html>`;

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const host = req.headers.host ?? '';
  if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(host)) {
    res.writeHead(403).end('Loopback host required');
    return;
  }
  const pathname = new URL(req.url ?? '/', `http://localhost:${port}`).pathname;
  if (pathname.startsWith('/api/') || !['GET', 'HEAD'].includes(req.method ?? '')) {
    res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, error: 'Live requests are disabled in the design preview.' }));
    return;
  }
  if (assets.has(pathname)) {
    res.writeHead(200, { 'Content-Type': types[extname(pathname)] ?? 'application/octet-stream' }).end(assets.get(pathname));
    return;
  }
  const documents = {
    '/design-system': resolve(repo, 'docs/design-system.html'),
    '/responsive': resolve(preview, 'responsive.html'),
  };
  if (documents[pathname]) {
    try {
      const guide = await readFile(documents[pathname], 'utf8');
      const scripts = [...guide.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
      const hashes = scripts.map((match) => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`).join(' ');
      res.setHeader('Content-Security-Policy', csp.replace("script-src 'self'", `script-src 'self' ${hashes}`).replace("font-src 'self'", "font-src 'self' data:"));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(guide);
    } catch {
      res.writeHead(404).end('Preview document not found');
    }
    return;
  }
  try {
    const assetRoot = pathname.startsWith('/fonts/') ? resolve(repo, 'app/fonts') : resolve(repo, 'public');
    const relativePath = pathname.startsWith('/fonts/') ? pathname.slice(7) : pathname.slice(1);
    const assetPath = resolve(assetRoot, decodeURIComponent(relativePath));
    if (assetPath.startsWith(assetRoot + sep) && types[extname(assetPath)]) {
      const bytes = await readFile(assetPath);
      res.writeHead(200, { 'Content-Type': types[extname(assetPath)] }).end(bytes);
      return;
    }
  } catch { /* Missing public asset falls through to an explicit 404. */ }
  if (extname(pathname)) {
    res.writeHead(404).end('Preview asset not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Design preview · Example data: http://localhost:${port}/${jobSearchPreview ? 'job-search' : 'jobs'}`);
  console.log('Actual app components, fixture API, loopback only. Source edits rebuild; reload the browser.');
});
server.on('error', async (error) => { console.error(error.message); await build.dispose(); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => { server.close(); await build.dispose(); process.exit(0); });
}
