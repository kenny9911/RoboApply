// @vitest-environment node
import express from 'express';
import type { Server } from 'node:http';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { handleJobSearchBodyError } from './request-errors.js';

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '1kb' }));
  app.use((_req, res) => res.json({ ok: true }));
  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (!handleJobSearchBodyError(err, req, res)) res.status(500).json({ otherRoute: true });
  });
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

describe('body parser failures before route middleware', () => {
  it.each(['/api/v1/job-search/search', '/api/v1/roboapply/v2/job-search/keys'])('returns sanitized JSON and request id for malformed body at %s', async (path) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"secret":"do-not-echo"' });
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toMatchObject({ code: 'invalid_request', requestId: response.headers.get('x-request-id') });
    expect(JSON.stringify(body)).not.toContain('do-not-echo');
  });
  it('returns 413 for an oversized search body', async () => {
    const response = await fetch(base + '/api/v1/job-search/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'x'.repeat(2000) }) });
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe('request_too_large');
  });
  it('leaves unrelated existing route handling unchanged', async () => {
    const response = await fetch(base + '/api/v1/other', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    expect(response.status).toBe(500);
  });
});
