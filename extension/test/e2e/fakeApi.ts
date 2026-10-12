// extension/test/e2e/fakeApi.ts — a local stand-in for the /ext API (WP-55a's routes),
// recording every request so the spec can assert what the extension sent.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface Recorded {
  method: string;
  path: string;
  body: unknown;
  auth: string | undefined;
}

export const E2E_PORT = 4799;
export const E2E_ORIGIN = `http://127.0.0.1:${E2E_PORT}`;
export const E2E_TOKEN = `rax_${'e2e'.repeat(15)}`;

const PREFIX = '/api/v1/roboapply/ext';

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' });
  res.end(type === 'application/json' ? JSON.stringify(body) : (body as Buffer));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function startFakeApi(): Promise<{ server: Server; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, null);
    const url = new URL(req.url ?? '/', E2E_ORIGIN);
    const body = await readBody(req);
    requests.push({ method: req.method ?? 'GET', path: url.pathname, body, auth: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${E2E_TOKEN}`) return send(res, 401, { success: false, code: 'unauthorized' });
    const ok = (data: unknown) => send(res, 200, { success: true, data });
    const path = url.pathname.slice(PREFIX.length);
    switch (`${req.method} ${path.replace(/\/autofill-runs\/[^/]+$/, '/autofill-runs/:id').replace(/\/files\/.+$/, '/files/:t')}`) {
      case 'GET /me':
        return ok({ user: { id: 'u1', email: 'avery@example.test', firstName: 'Avery' }, brand: { id: 'roboapply', name: 'RoboApply' }, entitlements: null, flags: { aiAnswers: true }, profileCompleteness: 80 });
      case 'POST /page-job':
        return ok({ jobId: 'job_e2e', fit: { score: 74, tier: 'good', kind: 'pre' } });
      case 'POST /autofill-runs':
        return ok({ runId: 'run_e2e', jobId: 'job_e2e' });
      case 'PATCH /autofill-runs/:id':
        return ok(null);
      case 'GET /autofill-profile':
        return ok({
          profile: { firstName: 'Avery', lastName: 'Lin', contactEmail: 'avery@example.test', phoneE164: '+15125550100', city: 'Austin', region: 'Texas', country: 'US' },
          education: [],
          experience: [{ company: 'Prior Corp', title: 'Software Engineer', current: true }],
          links: { linkedin: 'https://www.linkedin.com/in/avery-example' },
          workAuth: [{ country: 'US', authorized: true, sponsorship: 'no' }],
          answers: [],
          sensitive: null,
        });
      case 'POST /resume-for-job':
        return ok({ variantId: 'v1', isTailored: false, fileName: 'Avery_Lin_Resume.pdf', downloadUrl: `${E2E_ORIGIN}${PREFIX}/files/signed-e2e-token` });
      case 'GET /files/:t':
        return send(res, 200, Buffer.from('%PDF-1.4\n%e2e\n'), 'application/pdf');
      case 'POST /answers':
        return ok({ answer: 'I want to run a platform that small teams rely on.', source: 'ai', saveable: true });
      case 'POST /answers/save':
        return send(res, 201, { success: true, data: { saved: true, questionKey: 'custom:0123456789abcdef' } });
      default:
        return send(res, 404, { success: false, code: 'not_found' });
    }
  });
  return new Promise((resolve) => server.listen(E2E_PORT, '127.0.0.1', () => resolve({ server, requests })));
}
