// @vitest-environment node
//
// WP-76: invariants of the mainland deploy kit (deploy/cn, the deploy-cn
// workflow). Text checks on purpose: the files are small and their shape is
// owned here, and the tests must not need docker, kubectl or the network.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs script, no type declarations
import * as overlay from '../../deploy/cn/render-overlay.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const CN = 'deploy/cn';

const vercel = JSON.parse(read('vercel.json')) as {
  rewrites: Array<{ source: string; destination: string }>;
  functions: Record<string, { maxDuration?: number }>;
};

function walk(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((entry) => {
    const rel = join(dir, entry);
    if (entry === 'overlays' || entry.startsWith('.env')) return [];
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
  });
}
const KIT_FILES = [...walk(CN), '.github/workflows/deploy-cn.yml', 'scripts/gen-cn-cronjobs.mjs', 'docs/runbooks/cn-deploy.md'];

/** NAME=value pairs of an env example file. */
const envNames = (file: string) =>
  read(file)
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/=(.*)/s));

/** Strip `#` comments from nginx config / YAML / Dockerfiles. */
const code = (text: string) =>
  text
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, ''))
    .join('\n');

describe('nginx gateway mirrors vercel.json routing', () => {
  const nginx = code(read(`${CN}/nginx.conf`));
  const locations = [...nginx.matchAll(/location\s+(=|\^~)?\s*(\S+)\s*\{([^}]*)\}/g)].map((m) => ({
    modifier: m[1] ?? '',
    path: m[2]!,
    body: m[3]!,
  }));

  it('proxies every vercel.json rewrite to the API and nothing else', () => {
    const rewritePrefixes = vercel.rewrites
      .filter((r) => r.destination === '/api/index')
      .map((r) => r.source.replace(/:path\*$/, ''));
    expect(rewritePrefixes).toEqual(['/api/v1/']);
    const toApi = locations.filter((l) => /proxy_pass\s+http:\/\/ra_api;/.test(l.body)).map((l) => l.path);
    expect(toApi.sort()).toEqual([...rewritePrefixes].sort());
    for (const prefix of rewritePrefixes) expect(locations.find((l) => l.path === prefix)?.modifier).toBe('^~');
  });

  it('sends everything else to the Next.js server', () => {
    const root = locations.find((l) => l.path === '/');
    expect(root?.body).toMatch(/proxy_pass\s+http:\/\/ra_web;/);
    expect(nginx).toMatch(/server web:3000;/);
    expect(nginx).toMatch(/server api:4607;/);
  });

  it('keeps cron sweeps off the internet (CronJobs call the API Service directly)', () => {
    const cron = locations.find((l) => l.path === '/api/v1/cron/');
    expect(cron?.modifier).toBe('^~');
    expect(cron?.body).toMatch(/return 404;/);
    expect(cron?.body).not.toMatch(/proxy_pass/);
  });

  it('refuses /api/v1/cron in any letter case before location matching (Express mounts are case-insensitive)', () => {
    const server = nginx.slice(nginx.indexOf('server {'));
    const guard = /if \(\$uri ~\* "\^\/api\/v1\/cron\(\/\|\$\)"\) \{\s*return 404;\s*\}/.exec(server);
    expect(guard).not.toBeNull();
    // At server level: before the first location, so no location (^~ or not) can skip it.
    expect(guard!.index).toBeLessThan(server.indexOf('location '));
    const re = new RegExp('^/api/v1/cron(/|$)', 'i');
    for (const path of ['/api/v1/cron/queue-drain', '/api/v1/CRON/queue-drain', '/api/v1/Cron/queue-drain', '/api/v1/cron']) {
      expect(re.test(path), path).toBe(true);
    }
    for (const path of ['/api/v1/crontab', '/api/v1/health', '/api/v1/public/cron-info']) expect(re.test(path), path).toBe(false);
  });

  it('resolves the visitor from the SLB hop only and overwrites the forwarding headers (no client-forged X-Forwarded-For)', () => {
    expect(nginx).not.toMatch(/\$proxy_add_x_forwarded_for/);
    expect(nginx).toMatch(/proxy_set_header X-Forwarded-For \$remote_addr;/);
    expect(nginx).toMatch(/proxy_set_header X-Real-IP \$remote_addr;/);
    expect(nginx).toMatch(/real_ip_header X-Forwarded-For;/);
    expect(nginx).toMatch(/real_ip_recursive on;/);
    const trusted = [...nginx.matchAll(/set_real_ip_from\s+(\S+);/g)].map((m) => m[1]);
    expect(trusted).toEqual(['100.64.0.0/10']);
    expect(trusted).not.toContain('0.0.0.0/0');
  });

  it('lets API calls run as long as the Vercel function and streams them unbuffered', () => {
    const maxDuration = vercel.functions['api/index.ts']!.maxDuration!;
    const api = locations.find((l) => l.path === '/api/v1/')!;
    const timeout = Number(/proxy_read_timeout\s+(\d+)s;/.exec(api.body)?.[1]);
    expect(timeout).toBeGreaterThanOrEqual(maxDuration);
    expect(api.body).toMatch(/proxy_buffering off;/);
    const bodyMb = Number(/client_max_body_size\s+(\d+)m;/.exec(nginx)?.[1]);
    expect(bodyMb).toBeGreaterThanOrEqual(10);
  });

  it('listens on IPv6 only where the kernel has it, passes the Host and drops client-forged internal headers', () => {
    // No unconditional `listen [::]` (a node with ipv6.disable=1 would crash-loop the gateway).
    expect(nginx).not.toMatch(/listen \[::\]/);
    expect(nginx).toMatch(/^\s+listen 8080;$/m);
    expect(nginx).toMatch(/include \/tmp\/nginx-listen\.d\/\*\.conf;/);
    expect(nginx).toMatch(/proxy_set_header Host \$host;/);
    expect(nginx).toMatch(/proxy_set_header X-Forwarded-Host \$host;/);
    expect(nginx).toMatch(/proxy_set_header X-RA-Brand "";/);
    expect(nginx).toMatch(/proxy_set_header x-ra-client-ip "";/);
    expect(nginx).toMatch(/location = \/healthz/);
  });
});

describe('Dockerfiles', () => {
  const api = code(read(`${CN}/Dockerfile.api`));
  const web = code(read(`${CN}/Dockerfile.web`));
  const gateway = code(read(`${CN}/Dockerfile.gateway`));

  it('runs the API in listen mode with node-cron off', () => {
    expect(api).toMatch(/CMD \["node", "server\/dist\/app\.js"\]/);
    expect(api).toMatch(/ROBOAPPLY_CRON_DISABLED=true/);
    expect(api).toMatch(/DEPLOY_REGION=cn-mainland/);
    expect(api).toMatch(/ALLOWED_BRANDS=goapply/);
    expect(api).not.toMatch(/\bVERCEL\b/);
    expect(api).toMatch(/npm run build:server/);
    expect(api).toMatch(/COPY deploy\/cn\/cron-call\.mjs deploy\/cn\/preflight\.mjs/);
    expect(api).toMatch(/COPY content\/legal/);
  });

  it('runs the Next.js standalone server with its static assets', () => {
    expect(read('next.config.mjs')).toMatch(/output:\s*'standalone'/);
    expect(web).toMatch(/\.next\/standalone/);
    expect(web).toMatch(/COPY --from=build .*\/app\/\.next\/static \.\/\.next\/static/);
    expect(web).toMatch(/COPY --from=build .*\/app\/public \.\/public/);
    expect(web).toMatch(/CMD \["node", "server\.js"\]/);
    expect(web).toMatch(/HOSTNAME=0\.0\.0\.0/);
    expect(web).toMatch(/npm run build:web/);
    // The browser must call the API same-origin: never bake an API URL in.
    expect(web).not.toMatch(/ARG NEXT_PUBLIC_API_URL/);
    expect(web).not.toMatch(/NEXT_PUBLIC_USE_STUB_API/);
  });

  it('builds the gateway from the routed nginx.conf', () => {
    expect(gateway).toMatch(/COPY deploy\/cn\/nginx\.conf \/etc\/nginx\/nginx\.conf/);
    expect(gateway).toMatch(/COPY --chmod=0755 deploy\/cn\/gateway-listen-ipv6\.sh \/docker-entrypoint\.d\/15-goapply-listen-ipv6\.sh/);
    expect(gateway).not.toMatch(/^(CMD|ENTRYPOINT)\b/m); // keep the image's entrypoint, which runs /docker-entrypoint.d
  });

  it('writes the IPv6 listener only when the kernel has IPv6', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cn-gw-'));
    try {
      const listenDir = join(tmp, 'listen.d');
      const inet6 = join(tmp, 'if_inet6');
      const run = () =>
        execFileSync('sh', [join(ROOT, CN, 'gateway-listen-ipv6.sh')], {
          env: { ...process.env, RA_NGINX_LISTEN_DIR: listenDir, RA_IF_INET6: inet6 },
          encoding: 'utf8',
        });
      expect(run()).toMatch(/IPv4 only/);
      expect(existsSync(join(listenDir, 'ipv6.conf'))).toBe(false);
      writeFileSync(inet6, '');
      expect(run()).toMatch(/IPv6 available/);
      expect(readFileSync(join(listenDir, 'ipv6.conf'), 'utf8').trim()).toBe('listen [::]:8080 ipv6only=on;');
      rmSync(inet6);
      run(); // a restart on a node without IPv6 removes a stale listener
      expect(existsSync(join(listenDir, 'ipv6.conf'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('runs as a non-root user and can build inside the mainland (npm mirror, base-image override)', () => {
    for (const df of [api, web]) {
      expect(df).toMatch(/^USER node$/m);
      expect(df).toMatch(/ARG NPM_REGISTRY=https:\/\/registry\.npmjs\.org\//);
      expect(df).toMatch(/ARG NODE_IMAGE=node:24-slim/);
      expect(df).toMatch(/npm ci/);
    }
  });

  it('keeps .env files and local state out of every build context', () => {
    const webIgnore = read(`${CN}/Dockerfile.web.dockerignore`).split('\n');
    expect(webIgnore).toEqual(expect.arrayContaining(['**/.env', '**/.env.*', '.git', '**/node_modules', '.claude']));
    const apiIgnore = read(`${CN}/Dockerfile.api.dockerignore`).split('\n').filter((l) => l && !l.startsWith('#'));
    expect(apiIgnore[0]).toBe('*');
    expect(apiIgnore).toEqual(expect.arrayContaining(['**/.env', '**/.env.*']));
    expect(apiIgnore.filter((l) => l.startsWith('!')).sort()).toEqual(
      ['!content/legal/', '!deploy/cn/cron-call.mjs', '!deploy/cn/preflight.mjs', '!package-lock.json', '!package.json', '!prisma.config.ts', '!server/'].sort(),
    );
    const gatewayIgnore = read(`${CN}/Dockerfile.gateway.dockerignore`).split('\n').filter((l) => l && !l.startsWith('#'));
    expect(gatewayIgnore).toEqual(['*', '!deploy/cn/nginx.conf', '!deploy/cn/gateway-listen-ipv6.sh']);
  });
});

describe('Kubernetes manifests', () => {
  const k8s = (f: string) => read(`${CN}/k8s/${f}`);

  it('the kustomization lists every manifest, and every listed manifest exists', () => {
    const listed = [...code(k8s('kustomization.yaml')).matchAll(/^\s+-\s+(\S+\.yaml)$/gm)].map((m) => m[1]!).sort();
    const present = readdirSync(join(ROOT, CN, 'k8s'))
      .filter((f) => f.endsWith('.yaml') && f !== 'kustomization.yaml')
      .sort();
    expect(listed).toEqual(present);
  });

  it('pins the mainland settings on the API container and its preflight', () => {
    const api = k8s('api.yaml');
    for (const [name, value] of [
      ['ROBOAPPLY_CRON_DISABLED', 'true'],
      ['DEPLOY_REGION', 'cn-mainland'],
      ['ALLOWED_BRANDS', 'goapply'],
      ['FILE_LOGGING', 'false'],
    ]) {
      const hits = api.match(new RegExp(`\\{ name: ${name}, value: "${value}" \\}`, 'g')) ?? [];
      expect(hits, name).toHaveLength(2);
    }
    expect(api).toMatch(/command: \["node", "deploy\/cn\/preflight\.mjs"\]/);
    expect(api).toMatch(/path: \/api\/v1\/health/);
    expect(api).toMatch(/kind: Service[\s\S]*name: api[\s\S]*port: 4607/);
  });

  it('serves the web server-side reads through the API Service at runtime', () => {
    const web = k8s('web.yaml');
    expect(web).toMatch(/\{ name: NEXT_PUBLIC_API_URL, value: "http:\/\/api:4607" \}/);
    expect(web).toMatch(/\{ name: HOSTNAME, value: "0\.0\.0\.0" \}/);
    expect(web).toMatch(/\{ name: ALLOWED_BRANDS, value: "goapply" \}/);
    expect(web).toMatch(/path: \/api\/health/);
  });

  it('registers the worker as GoApply-Interview and keeps it off until voice is configured', () => {
    const worker = k8s('worker.yaml');
    expect(worker).toMatch(/\{ name: INTERVIEW_ENGINE_AGENT_NAME, value: "GoApply-Interview" \}/);
    expect(worker).toMatch(/^\s+replicas: 0$/m);
    expect(worker).toMatch(/terminationGracePeriodSeconds: 5400/);
  });

  it('exposes only the gateway, with health checks and IPv6 where the cluster has it', () => {
    const files = readdirSync(join(ROOT, CN, 'k8s')).map((f) => k8s(f));
    const lbs = files.flatMap((t) => t.match(/type: LoadBalancer/g) ?? []);
    expect(lbs).toHaveLength(1);
    const gw = k8s('gateway.yaml');
    expect(gw).toMatch(/type: LoadBalancer/);
    expect(gw).toMatch(/ipFamilyPolicy: PreferDualStack/);
    expect(gw).toMatch(/health-check-uri: "\/healthz"/);
    expect(gw).toMatch(/externalTrafficPolicy: Local/);
    expect(gw).toMatch(/xforwardedfor-proto: "on"/);
  });

  it('references images only by placeholder and secrets only by name', () => {
    for (const f of readdirSync(join(ROOT, CN, 'k8s'))) {
      const text = k8s(f);
      for (const m of text.matchAll(/^\s+image: (\S+)$/gm)) expect(m[1], f).toMatch(/^goapply-(web|api|worker|gateway)$/);
      expect(text, f).not.toMatch(/^kind: Secret$/m);
      expect(text, f).not.toMatch(/^\s+stringData:|^\s+data:/m);
    }
  });
});

describe('deploy-cn workflow', () => {
  const wf = read('.github/workflows/deploy-cn.yml');
  const body = code(wf);

  it('runs only by hand', () => {
    const triggers = /^on:\n((?:[ \t]+.*\n|\n)*)/m.exec(body)?.[1] ?? '';
    expect(triggers).toMatch(/^ {2}workflow_dispatch:/m);
    expect([...triggers.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1])).toEqual(['workflow_dispatch']);
    expect(body).toMatch(/permissions:\n\s+contents: read/);
  });

  it('skips with a notice when the ACR or ACK secrets are absent', () => {
    expect(body).toContain('ACR_REGISTRY: ${{ secrets.ALIYUN_ACR_REGISTRY }}');
    expect(body).toContain('ACK_KUBECONFIG_B64: ${{ secrets.ACK_KUBECONFIG_B64 }}');
    expect(body).toMatch(/if \[ -z "\$ACR_REGISTRY" \] \|\| \[ -z "\$ACK_KUBECONFIG_B64" \]; then\n\s+echo "::notice /);
    for (const job of ['verify', 'build', 'deploy']) {
      const block = new RegExp(`\\n  ${job}:\\n[\\s\\S]*?if: needs\\.gate\\.outputs\\.enabled == 'true'`);
      expect(body, job).toMatch(block);
    }
  });

  it('never touches a database schema or data', () => {
    expect(body).not.toMatch(/db push|db:push|migrate (deploy|dev|reset)|prisma migrate|db execute|psql|DATABASE_URL/i);
  });

  it('checks cron parity before building, and builds all four images', () => {
    expect(body).toContain('node scripts/gen-cn-cronjobs.mjs --check');
    for (const c of ['web', 'api', 'gateway', 'worker']) expect(body).toMatch(new RegExp(`component: ${c}\\n`));
    expect(body).toContain('dockerfile: interview-agent/Dockerfile');
    expect(body).toContain('node deploy/cn/render-overlay.mjs');
    expect(body).toContain('kubectl apply -k deploy/cn/overlays/release --dry-run=server');
  });

  it('uses secrets only through the secrets context, and writes the kubeconfig privately', () => {
    for (const m of body.matchAll(/\b(ALIYUN_ACR_PASSWORD|ALIYUN_ACR_USERNAME|ACK_KUBECONFIG_B64|NEXT_SERVER_ACTIONS_ENCRYPTION_KEY)\b[^\n]*/g)) {
      const line = m[0];
      if (line.includes(':')) expect(line, line).toMatch(/\$\{\{ secrets\.|"\$ACK_KUBECONFIG_B64"|^ACK_KUBECONFIG_B64: \$\{\{ secrets/);
    }
    const logins = [...body.matchAll(/^\s+(registry|username|password):\s*(.+)$/gm)];
    expect(logins).toHaveLength(3);
    for (const m of logins) expect(m[2], m[1]).toMatch(/^\$\{\{ secrets\.ALIYUN_ACR_[A-Z]+ \}\}$/);
    expect(body).toMatch(/umask 077/);
  });
});

describe('render-overlay', () => {
  const good = { registry: 'registry.cn-shanghai.aliyuncs.com', namespace: 'goapply', tag: 'abc123', slbCertId: '1234-cn-shanghai', workerReplicas: '1' };

  it('points every placeholder image at ACR and turns on HTTPS at the SLB', () => {
    const text = overlay.renderOverlay(good) as string;
    for (const c of overlay.COMPONENTS as string[]) {
      expect(text).toContain(`  - name: goapply-${c}\n    newName: registry.cn-shanghai.aliyuncs.com/goapply/goapply-${c}\n    newTag: "abc123"`);
    }
    expect(text).toContain('resources:\n  - ../../k8s');
    expect(text).toContain('value: "https:443,http:80"');
    expect(text).toContain('alibaba-cloud-loadbalancer-cert-id\n        value: "1234-cn-shanghai"');
    expect(text).toContain('  - name: worker\n    count: 1');
  });

  it('refuses incomplete or malformed input', () => {
    expect(() => overlay.renderOverlay({ ...good, slbCertId: '' })).toThrow(/slb-cert-id/);
    expect(() => overlay.renderOverlay({ ...good, registry: 'https://evil.example/x' })).toThrow(/registry/);
    expect(() => overlay.renderOverlay({ ...good, tag: 'a b' })).toThrow(/tag/);
    expect(() => overlay.renderOverlay({ ...good, workerReplicas: '-1' })).toThrow(/worker-replicas/);
    expect(overlay.overlayProblems(good)).toEqual([]);
    expect(overlay.renderOverlay({ ...good, workerReplicas: undefined })).toContain('count: 0');
  });
});

describe('no secrets in the kit', () => {
  const PATTERNS: Array<[string, RegExp]> = [
    ['AWS access key', /AKIA[0-9A-Z]{16}/],
    ['Aliyun AccessKey id', /LTAI[0-9A-Za-z]{12,}/],
    ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['Stripe key', /\b[sr]k_(live|test)_[0-9A-Za-z]{8,}/],
    ['GitHub token', /\bgh[pousr]_[0-9A-Za-z]{20,}/],
    ['database URL with a password', /postgres(ql)?:\/\/[^\s:@/]+:[^\s@/]+@(?!host|HOST|PASSWORD)/],
  ];

  it('covers the whole kit', () => {
    expect(KIT_FILES.length).toBeGreaterThanOrEqual(20);
    for (const f of KIT_FILES) expect(existsSync(join(ROOT, f)), f).toBe(true);
  });

  it.each(KIT_FILES.map((f) => [relative(ROOT, join(ROOT, f))]))('%s holds no credential', (file) => {
    const text = read(file);
    for (const [label, re] of PATTERNS) expect(re.test(text), `${label} in ${file}`).toBe(false);
  });

  it.each([`${CN}/cn.env.example`, `${CN}/cn.web.env.example`])('%s lists names only', (file) => {
    for (const [name, value = ''] of envNames(file)) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      // Only non-secret defaults may carry a value.
      if (value) expect(/(SECRET|PASSWORD|_KEY$|_KEY_ID$|TOKEN|VERIFICATION)/.test(name!), `${name} has a value`).toBe(false);
    }
  });
});

describe('web pods get every value the legal pages read', () => {
  // app/legal/legalSource.ts inlineValues(): unset, GoApply's privacy policy shows 未披露 / 草稿.
  const LEGAL = ['CN_LEGAL_ENTITY_NAME', 'CN_LEGAL_POSTAL_ADDRESS', 'CN_SUPPORT_EMAIL', 'CN_COMPLAINT_EMAIL', 'CN_COMPLAINT_PHONE', 'CN_LEGAL_DOCS_VERSION'];

  it('the legal source still reads these names', () => {
    const src = read('app/legal/legalSource.ts');
    for (const n of ['LEGAL_ENTITY_NAME', 'LEGAL_POSTAL_ADDRESS', 'SUPPORT_EMAIL', 'CN_COMPLAINT_EMAIL', 'CN_COMPLAINT_PHONE', 'LEGAL_DOCS_VERSION']) {
      expect(src, n).toContain(n);
    }
    expect(read('lib/brand/metadata.ts')).toContain('env.BAIDU_SITE_VERIFICATION');
  });

  it('the web env example, the web manifest and the runbook list them', () => {
    const web = envNames(`${CN}/cn.web.env.example`).map(([n]) => n);
    expect(web).toEqual(expect.arrayContaining(['INTERNAL_API_SECRET', 'CN_CANONICAL_ORIGIN', 'BAIDU_SITE_VERIFICATION', ...LEGAL]));
    const api = envNames(`${CN}/cn.env.example`).map(([n]) => n);
    expect(api).toEqual(expect.arrayContaining(LEGAL));
    const manifest = read(`${CN}/k8s/web.yaml`);
    const runbook = read('docs/runbooks/cn-deploy.md');
    for (const n of LEGAL) {
      expect(manifest, n).toContain(n);
      expect(runbook, n).toContain(n);
    }
    expect(runbook).toContain('cn.web.env.example');
    expect(runbook).not.toContain('CN_BAIDU_SITE_VERIFICATION');
    expect(manifest).not.toContain('CN_BAIDU_SITE_VERIFICATION');
  });
});
