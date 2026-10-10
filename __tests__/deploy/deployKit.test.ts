// @vitest-environment node
//
// WP-76: invariants of the mainland deploy kit (deploy/cn, the deploy-cn
// workflow). Text checks on purpose: the files are small and their shape is
// owned here, and the tests must not need docker, kubectl or the network.
//
// PAR-10 (owner ruling D5, docs/jobright-clone/GOAPPLY_PARITY_PLAN.md): the
// env examples and the dev script describe a GoApply that works on the shared
// credentials alone. A China-specific value is an optional override, and no
// example file ships an off switch or half of a credential group.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs script, no type declarations
import * as overlay from '../../deploy/cn/render-overlay.mjs';
// @ts-expect-error — plain .mjs script, no type declarations
import * as preflight from '../../deploy/cn/preflight.mjs';
import { brandEnvGroupProblems, BRAND_ENV_GROUPS } from '../../server/src/platform/brand/brandEnv';
import { getBrand } from '../../server/src/platform/brand/registry';
import { allowedBrands, allowedBrandsProblem } from '../../server/src/platform/brand/runtime';
import { cnPaymentsKilled, cnRecruitmentInfoMode, cnRecruitmentInfoModeProblem, resolveFlags } from '../../server/src/platform/flags';
import { contentSafetyReadiness } from '../../server/src/platform/llm/contentSafety/config';
import { checkResidency } from '../../server/src/platform/residency/startupAssertions';
// @ts-expect-error — plain .mjs config, no type declarations
import * as nextConfigModule from '../../next.config.mjs';

type RemotePattern = { protocol: string; hostname: string; port?: string; pathname: string };
const assetRemotePattern = nextConfigModule.assetRemotePattern as (raw: unknown) => RemotePattern | null;
const imageRemotePatterns = nextConfigModule.imageRemotePatterns as (env?: Record<string, string | undefined>) => RemotePattern[];

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
const WORKER_KIT = 'interview-agent/deploy/cn';
const KIT_FILES = [
  ...walk(CN),
  ...walk(WORKER_KIT),
  '.github/workflows/deploy-cn.yml',
  '.github/workflows/ci.yml',
  'scripts/gen-cn-cronjobs.mjs',
  'docs/runbooks/cn-deploy.md',
];

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

  describe('one worker manifest (WP-76 + WP-63b reconciled)', () => {
    const worker = k8s('worker.yaml');
    const workerDockerfile = code(read(`${WORKER_KIT}/Dockerfile`));
    /** The domestic pins: the manifest, the image and the compose smoke stack must agree. */
    const PINS: Array<[string, string]> = [
      ['INTERVIEW_ENGINE_AGENT_NAME', 'GoApply-Interview'],
      ['WORKER_BRAND', 'goapply'],
      ['LLM_BACKEND', 'openai_compatible'],
      ['STT_BACKEND', 'dashscope_paraformer'],
      ['TTS_BACKEND', 'dashscope_cosyvoice'],
    ];

    it('the kustomization lists exactly one worker, and the standalone recipe is only a pointer', () => {
      const listed = [...code(k8s('kustomization.yaml')).matchAll(/^\s+-\s+(\S+\.yaml)$/gm)].map((m) => m[1]!);
      expect(listed.filter((f) => /worker/.test(f))).toEqual(['worker.yaml']);
      // One Deployment in the manifest, named `worker` (what the overlay scales and the workflow waits for).
      expect(worker.match(/^kind: Deployment$/gm)).toHaveLength(1);
      expect(worker).toMatch(/^metadata:\n {2}name: worker$/m);
      const pointer = read(`${WORKER_KIT}/k8s.yaml`);
      expect(code(pointer).trim()).toBe(''); // comments only: applying it creates nothing
      expect(pointer).toContain('deploy/cn/k8s/worker.yaml');
      // No other Deployment of the GoApply worker anywhere in the two kits.
      const deployments = [...walk(CN), ...walk(WORKER_KIT)]
        .filter((f) => /\.ya?ml$/.test(f))
        .filter((f) => /^kind: Deployment$/m.test(code(read(f))) && /GoApply-Interview/.test(code(read(f))));
      expect(deployments).toEqual([`${CN}/k8s/worker.yaml`]);
    });

    it('pins the brand guard and the domestic backends, with the same values as the image and compose', () => {
      const compose = read(`${CN}/compose.yaml`);
      const composeWorker = compose.slice(compose.indexOf('\n  worker:\n'), compose.indexOf('\nvolumes:'));
      for (const [name, value] of PINS) {
        expect(worker, name).toContain(`{ name: ${name}, value: "${value}" }`);
        expect(workerDockerfile, name).toMatch(new RegExp(`\\b${name}=${value}\\b`));
        expect(composeWorker, name).toContain(`${name}: ${value}`);
      }
      // Never a gateway backend on the mainland worker.
      expect(code(worker)).not.toMatch(/value: "?gateway"?/);
    });

    it('uses the env names the worker reads (interview-agent/src/backends)', () => {
      const backends = ['index.ts', 'llm.ts', 'speech.ts'].map((f) => read(`interview-agent/src/backends/${f}`)).join('\n');
      const NAMES = ['LLM_BACKEND', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'STT_BACKEND', 'TTS_BACKEND', 'WORKER_BRAND', 'DASHSCOPE_API_KEY'];
      for (const name of NAMES) expect(backends, name).toMatch(new RegExp(`\\b${name}\\b`));
      // The values pinned above are ones the worker accepts.
      expect(backends).toMatch(/LLM_BACKENDS = \['gateway', 'openai_compatible'\]/);
      expect(backends).toMatch(/STT_BACKENDS = \['gateway', 'dashscope_paraformer'\]/);
      expect(backends).toMatch(/TTS_BACKENDS = \['gateway', 'dashscope_cosyvoice'\]/);
      // Every name is documented for the Secret (commented-out optional ones included)…
      const example = read(`${WORKER_KIT}/worker.env.example`);
      for (const name of NAMES) expect(example, name).toMatch(new RegExp(`^#? ?${name}=`, 'm'));
      // …and the manifest names the Secret and where its names are listed.
      expect(worker).toContain('secretRef: { name: goapply-worker-env }');
      expect(worker).toContain('interview-agent/deploy/cn/worker.env.example');
      for (const name of ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'DASHSCOPE_API_KEY']) expect(worker, name).toContain(name);
    });

    it('never carries a credential value in the manifest or the example', () => {
      for (const [name, value = ''] of envNames(`${WORKER_KIT}/worker.env.example`)) {
        expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
        if (value) expect(/(SECRET|PASSWORD|_KEY$|_KEY_ID$|TOKEN)/.test(name!), `${name} has a value`).toBe(false);
      }
      expect(code(worker)).not.toMatch(/(API_KEY|SECRET), value:/);
    });
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
    // The GoApply worker is built from the mainland Dockerfile (domestic backend pins), not the generic one.
    expect(body).toMatch(/component: worker\n\s+context: interview-agent\n\s+dockerfile: interview-agent\/deploy\/cn\/Dockerfile\n/);
    expect(body).not.toContain('dockerfile: interview-agent/Dockerfile');
    expect(existsSync(join(ROOT, 'interview-agent/deploy/cn/Dockerfile'))).toBe(true);
    // Build-time values `next build` reads: the deployment id (version skew) and the GoApply image host.
    expect(body).toContain('NEXT_DEPLOYMENT_ID=${{ github.sha }}');
    expect(body).toContain('CN_PUBLIC_ASSET_BASE_URL=${{ vars.CN_PUBLIC_ASSET_BASE_URL }}');
    expect(body).toContain('node deploy/cn/render-overlay.mjs');
    expect(body).toContain('kubectl apply -k deploy/cn/overlays/release --dry-run=server');
  });

  describe('build arguments reach the web image', () => {
    // Docker drops a build argument the Dockerfile does not declare, so a name
    // the workflow passes but Dockerfile.web lacks never reaches `next build`.
    const passed = [...(/build-args: \|\n((?: {12}\S.*\n)+)/.exec(body)?.[1] ?? '').matchAll(/^ {12}([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
    const buildStage = /\nFROM \$\{NODE_IMAGE\} AS build\n([\s\S]*?)\nFROM /.exec(code(read(`${CN}/Dockerfile.web`)))?.[1] ?? '';
    const declared = new Set([...buildStage.matchAll(/^ARG ([A-Z][A-Z0-9_]*)\b/gm)].map((m) => m[1]!));
    /**
     * Names the workflow passes that deploy/cn/Dockerfile.web does not declare
     * yet (such a value is inert on the mainland build). Empty since the INT
     * gate declared NEXT_DEPLOYMENT_ID and CN_PUBLIC_ASSET_BASE_URL; a new
     * build argument goes here only until the Dockerfile declares it.
     */
    const PENDING_IN_DOCKERFILE_WEB: string[] = [];

    it('the workflow passes the five names the web build reads', () => {
      expect(passed).toEqual(['NPM_REGISTRY', 'NEXT_PUBLIC_CN_EXT_ID', 'NEXT_PUBLIC_CN_EXT_STORE_URL', 'NEXT_DEPLOYMENT_ID', 'CN_PUBLIC_ASSET_BASE_URL']);
      expect(declared.size).toBeGreaterThanOrEqual(6);
    });

    it('Dockerfile.web declares every one of them in its build stage, except the names still pending', () => {
      expect(passed.filter((name) => !declared.has(name))).toEqual(PENDING_IN_DOCKERFILE_WEB.filter((name) => !declared.has(name)));
    });

    it('the pending list holds only names that are still undeclared (delete a name once Dockerfile.web declares it)', () => {
      expect(PENDING_IN_DOCKERFILE_WEB.filter((name) => declared.has(name))).toEqual([]);
      for (const name of PENDING_IN_DOCKERFILE_WEB) expect(passed, name).toContain(name);
    });
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

describe('ci workflow (root gates + extension + interview-agent)', () => {
  const wf = read('.github/workflows/ci.yml');
  const body = code(wf);
  const scriptsOf = (pkg: string) => Object.keys((JSON.parse(read(pkg)) as { scripts: Record<string, string> }).scripts);
  const PACKAGES: Record<string, string[]> = {
    '': scriptsOf('package.json'),
    extension: scriptsOf('extension/package.json'),
    'interview-agent': scriptsOf('interview-agent/package.json'),
  };
  /** Every `npm … run <script>` / `npm … test` step, with the package it runs in. */
  const runs = [...body.matchAll(/^\s+(?:- )?run: npm(?: --prefix (\S+))? (?:run (\S+)|(test))\b.*$/gm)].map((m) => ({
    pkg: m[1] ?? '',
    script: (m[2] ?? m[3])!,
  }));

  it('runs on pull requests and on main, read-only, with no secrets and no deploy', () => {
    expect(body).toMatch(/^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]$/m);
    expect(body).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(body).not.toMatch(/secrets\./);
    expect(body).not.toMatch(/\b(deploy|kubectl|vercel|docker|db push|db:push|prisma migrate)\b/i);
  });

  it('gives the root job a placeholder DATABASE_URL (closed loopback port, no password), and no other database setting', () => {
    // A clean runner has no .env; without a connection string the Prisma client
    // throws at import and every test file that imports it fails.
    expect(read('server/src/lib/prisma.ts')).toMatch(/throw new Error\(\s*'DATABASE_URL is not set/);
    const lines = body.split('\n').filter((l) => /DATABASE_URL/.test(l));
    expect(lines).toEqual(['      DATABASE_URL: postgresql://ci@127.0.0.1:1/ci']);
    // It sits in the root job's env block (the job that runs `npm test`), not at workflow level.
    expect(body).toMatch(/\n {2}root:\n(?: {4}.*\n)*? {4}env:\n {6}DATABASE_URL: /);
    // Nothing else that could point a test at a real service.
    expect(body).not.toMatch(/\b(DIRECT_DATABASE_URL|REDIS_URL|[A-Z_]*API_KEY|[A-Z_]*SECRET)\b/);
    expect(body).not.toMatch(/neon\.tech|amazonaws|aliyuncs|:5432/);
  });

  it('runs the four root gates', () => {
    const root = runs.filter((r) => r.pkg === '').map((r) => r.script);
    expect(root).toEqual(['typecheck:server', 'typecheck:web', 'test', 'check']);
  });

  it('runs the extension and the interview-agent typecheck and tests (root npm test runs neither)', () => {
    expect(runs.filter((r) => r.pkg === 'extension').map((r) => r.script)).toEqual(['typecheck', 'test']);
    expect(runs.filter((r) => r.pkg === 'interview-agent').map((r) => r.script)).toEqual(['typecheck', 'test']);
    const exclude = /exclude: \[([^\]]*)\]/.exec(read('vitest.config.mts'))?.[1] ?? '';
    expect(exclude).toContain("'interview-agent/**'");
    expect(exclude).toContain("'extension/**'");
  });

  it('every command names a script that exists in its package.json', () => {
    expect(runs.length).toBe(8);
    for (const { pkg, script } of runs) expect(PACKAGES[pkg], `${pkg || 'root'}: ${script}`).toContain(script);
  });

  it('installs each package from its lockfile', () => {
    expect(body.match(/^\s+- run: npm ci --no-audit --no-fund$/gm)).toHaveLength(2); // root job + extension job (root sources)
    expect(body).toMatch(/npm --prefix extension ci /);
    expect(body).toMatch(/npm --prefix interview-agent ci /);
    for (const lock of ['package-lock.json', 'extension/package-lock.json', 'interview-agent/package-lock.json']) {
      expect(existsSync(join(ROOT, lock)), lock).toBe(true);
    }
  });
});

describe('next/image remote patterns (CN_PUBLIC_ASSET_BASE_URL)', () => {
  const INTL_HOSTS = ['r2.robohire.io', '**.r2.cloudflarestorage.com'];

  it('adds nothing when the variable is unset or blank', () => {
    expect(imageRemotePatterns({}).map((p) => p.hostname)).toEqual(INTL_HOSTS);
    expect(imageRemotePatterns({ CN_PUBLIC_ASSET_BASE_URL: '  ' }).map((p) => p.hostname)).toEqual(INTL_HOSTS);
    expect(assetRemotePattern(undefined)).toBeNull();
    expect(assetRemotePattern('')).toBeNull();
  });

  it('adds exactly the parsed origin and base path, never a wildcard host', () => {
    expect(assetRemotePattern('https://assets.example.cn/public/')).toEqual({ protocol: 'https', hostname: 'assets.example.cn', port: '', pathname: '/public/**' });
    expect(assetRemotePattern(' https://Bucket.oss-cn-shanghai.aliyuncs.com ')).toEqual({
      protocol: 'https',
      hostname: 'bucket.oss-cn-shanghai.aliyuncs.com',
      port: '',
      pathname: '/**',
    });
    expect(assetRemotePattern('https://cdn.example.cn:8443/a/b?x=1#y')).toEqual({ protocol: 'https', hostname: 'cdn.example.cn', port: '8443', pathname: '/a/b/**' });
    const patterns = imageRemotePatterns({ CN_PUBLIC_ASSET_BASE_URL: 'https://assets.example.cn/public' });
    expect(patterns).toHaveLength(3);
    expect(patterns[2]).toEqual({ protocol: 'https', hostname: 'assets.example.cn', port: '', pathname: '/public/**' });
    expect(patterns[2]!.hostname).not.toContain('*');
  });

  it('fails closed on anything that is not a plain https URL of a real host', () => {
    for (const bad of [
      'http://assets.example.cn',
      'assets.example.cn',
      '//assets.example.cn/x',
      'https://*.example.cn/x',
      'https://**.aliyuncs.com',
      'https://user:pass@assets.example.cn',
      'https://localhost/x',
      'https://assets.example.cn/a/*/b',
      'https://assets.example.cn/**',
      'ftp://assets.example.cn',
      'not a url',
    ]) {
      expect(assetRemotePattern(bad), bad).toBeNull();
      expect(imageRemotePatterns({ CN_PUBLIC_ASSET_BASE_URL: bad }).map((p) => p.hostname), bad).toEqual(INTL_HOSTS);
    }
  });

  it('reads only the CN_ name (a GoApply-only build value: it has no unprefixed twin)', () => {
    expect(imageRemotePatterns({ PUBLIC_ASSET_BASE_URL: 'https://assets.example.com' }).map((p) => p.hostname)).toEqual(INTL_HOSTS);
  });

  it('the config uses the builder, sets no deploymentId, and the name is documented for the mainland build', () => {
    const config = read('next.config.mjs');
    expect(config).toMatch(/remotePatterns: imageRemotePatterns\(\)/);
    // NEXT_DEPLOYMENT_ID is passed at build time instead: a config value that
    // disagrees with the platform's fails the production build on Vercel.
    expect(code(config.replace(/\/\/.*$/gm, ''))).not.toMatch(/^\s*deploymentId\s*:/m);
    // Build-time, so it is documented as a build variable, not as a line of the pods' runtime Secret.
    const webExample = read(`${CN}/cn.web.env.example`);
    expect(webExample).toMatch(/^# .*CN_PUBLIC_ASSET_BASE_URL/m);
    expect(webExample).toMatch(/^# .*NEXT_DEPLOYMENT_ID/m);
    expect(envNames(`${CN}/cn.web.env.example`).map(([n]) => n)).not.toContain('CN_PUBLIC_ASSET_BASE_URL');
  });
});

describe('env catalogue (.env.example and the mainland examples)', () => {
  const root = read('.env.example');
  /** Active (`NAME=`) and commented-out (`# NAME=`) entries of the root catalogue. */
  const active = [...root.matchAll(/^([A-Z][A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1]!, m[2]!] as const);
  const catalogue = new Set([...root.matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!));
  const mentions = (name: string) => new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`).test(root);

  it('lists each name once and holds no real value', () => {
    const names = active.map(([n]) => n);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    for (const [label, re] of [
      ['Stripe key', /\b[sr]k_(live|test)_[0-9A-Za-z]{8,}/],
      ['AWS access key', /AKIA[0-9A-Z]{16}/],
      ['Aliyun AccessKey id', /LTAI[0-9A-Za-z]{12,}/],
      ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
      ['JWT', /\beyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\./],
    ] as const) {
      expect(re.test(root), label).toBe(false);
    }
    // A secret-looking name carries no value, or an obvious placeholder.
    for (const [name, value] of active) {
      if (!/(SECRET|PASSWORD|PRIVATE_KEY|_API_KEY$|ACCESS_KEY|TOKEN$|ENCRYPTION_KEY)/.test(name)) continue;
      expect(value.replace(/\s+#.*$/, '').trim(), name).toMatch(/^(|change-me-[a-z-]+)$/);
    }
    expect(root).toMatch(/^DATABASE_URL=postgresql:\/\/USER:PASSWORD@/m);
  });

  it('every name of the mainland examples is in the root catalogue', () => {
    for (const file of [`${CN}/cn.env.example`, `${CN}/cn.web.env.example`]) {
      for (const [name] of envNames(file)) expect(catalogue.has(name!), `${file}: ${name}`).toBe(true);
    }
  });

  it('documents what the hot server and config files read', () => {
    // The files INT-13 owns: any process.env name they read is in the catalogue.
    const FILES = ['server/src/app.ts', 'server/src/roboapply/schedulers/processLifecycle.ts', 'server/src/roboapply/schedulers/RoboApplyCronService.ts', 'server/src/cron/handlers.ts', 'next.config.mjs'];
    const read_ = new Set<string>();
    for (const f of FILES) {
      for (const m of read(f).matchAll(/\b(?:process\.)?env\.([A-Z][A-Z0-9_]{2,})\b/g)) read_.add(m[1]!);
    }
    expect(read_.size).toBeGreaterThan(8);
    for (const name of read_) expect(mentions(name), name).toBe(true);
    for (const name of ['TRUST_PROXY', 'SHUTDOWN_DRAIN_TIMEOUT_MS', 'CN_PUBLIC_ASSET_BASE_URL', 'NEXT_DEPLOYMENT_ID']) expect(mentions(name), name).toBe(true);
  });

  it('lists the optional CN_ override beside each shared name and keeps removed names out', () => {
    for (const name of ['EMAIL_FROM', 'LIVEKIT_AGENT_NAME', 'CANONICAL_ORIGIN', 'SUPPORT_EMAIL', 'TOTP_ENCRYPTION_KEY', 'MIN_EXT_VERSION', 'SCORE_DAILY_BUDGET', 'COPILOT_DAILY_BUDGET_USD']) {
      expect(catalogue.has(name), name).toBe(true);
      expect(catalogue.has(`CN_${name}`), `CN_${name}`).toBe(true);
    }
    // Nothing reads these any more (INT-13 audit); RA_CROSSBANK_DAILY_CAP was a misspelling of …_DAILY_CALL_CAP.
    for (const gone of [
      'NEXT_PUBLIC_R2_PUBLIC_URL',
      'NEXT_PUBLIC_LIVEKIT_URL',
      'ALIPAY_APP_ID',
      'ALIPAY_APP_PRIVATE_KEY',
      'ALIPAY_PUBLIC_KEY',
      'CONTACT_EMAIL_PROVIDER',
      'CONTACT_EMAIL_PROVIDER_KEY',
      'ROBOHIRE_INVITE_SECRET',
      'RA_CROSSBANK_DAILY_CAP',
    ]) {
      expect(mentions(gone), gone).toBe(false);
    }
    expect(catalogue.has('RA_CROSSBANK_DAILY_CALL_CAP')).toBe(true);
    expect(read('server/src/roboapply/v2/routes/discover.ts')).toContain('process.env.RA_CROSSBANK_DAILY_CALL_CAP');
  });
});

describe('GoApply works by default (D5): env examples, mainland kit and dev script', () => {
  type Env = Record<string, string | undefined>;
  const root = read('.env.example');
  const kit = read(`${CN}/cn.env.example`);
  const kitWeb = read(`${CN}/cn.web.env.example`);
  const kitReadme = read(`${CN}/README.md`);
  const devScript = read('scripts/dev-clone.sh');

  /** `NAME=value` lines that are not commented out, with a trailing `# note` dropped. */
  const activeValues = (text: string): Env =>
    Object.fromEntries(
      [...text.matchAll(/^([A-Z][A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1]!, m[2]!.replace(/\s+#.*$/, '').trim()] as const).filter(([, v]) => v !== ''),
    );
  /** Every documented name, active (`NAME=`) or commented out (`# NAME=`). */
  const documented = (text: string) => new Set([...text.matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!));
  /** The names listed under one `# ── title ──` heading of an env example. */
  const section = (text: string, title: RegExp): string[] => {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l.startsWith('# ──') && title.test(l));
    expect(start, String(title)).toBeGreaterThanOrEqual(0);
    const names: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line.startsWith('# ──') && !line.includes('domestic providers above')) break;
      const m = /^([A-Z][A-Z0-9_]+)=/.exec(line);
      if (m) names.push(m[1]!);
    }
    return names;
  };

  /** Wording of the superseded rules (TASK_PLAN R-03 / R-13 / R-14 / R-15, "ships dark"). */
  const STALE: Array<[string, RegExp]> = [
    ['no fallback', /no fallback/i],
    ['ships dark', /ships? (it |them )?dark/i],
    ['never falls back', /never falls? back/i],
    ['R-03', /\bR-03\b/],
    ['R-13', /\bR-13\b/],
    ['R-14', /\bR-14\b/],
    ['R-15', /\bR-15\b/],
    ['nothing offshore', /nothing offshore/i],
    ['resend is refused', /resend is refused/i],
    ['AI features hidden', /AI features hidden/i],
    ['Stage switches', /stage switches/i],
    ['invite-only default', /invite \(CN-0/i],
  ];

  describe('root .env.example', () => {
    const active = activeValues(root);
    const names = documented(root);

    it('carries none of the superseded "GoApply is off until configured" wording', () => {
      for (const [label, re] of STALE) expect(re.test(root), label).toBe(false);
    });

    it('states the rule: CN_ values are optional overrides, by class of name', () => {
      expect(root).toMatch(/CN_NAME\s+→ OPTIONAL override for GoApply/);
      expect(root).toMatch(/GoApply\s+#? ?needs NO variable of its own/);
      // The three classes of GOAPPLY_PARITY_PLAN §3.1, with every group anchor named.
      for (const phrase of ['Per key', 'Grouped', 'Brand-own']) expect(root, phrase).toContain(phrase);
      const rule = root.slice(root.indexOf('# Naming rule (server/src/platform/brand/brandEnv.ts)'), root.indexOf('# Vendor-only keys stay unprefixed'));
      expect(rule.length).toBeGreaterThan(500);
      for (const anchor of Object.values(BRAND_ENV_GROUPS).flatMap((g) => g.anchors)) {
        expect(new RegExp(`anchors? (CN_[A-Z_]+ and\\s+#\\s+)?CN_${anchor}\\b`).test(rule), `anchor CN_${anchor}`).toBe(true);
      }
      // Every member of every group is named in the rule, so a reader can tell which values travel together.
      for (const group of Object.values(BRAND_ENV_GROUPS)) {
        for (const member of group.members) expect(new RegExp(`(?<![A-Z0-9_])${member}(?![A-Z0-9_])`).test(rule), member).toBe(true);
      }
      // Every member of every group has its CN_ twin documented.
      for (const group of Object.values(BRAND_ENV_GROUPS)) {
        for (const member of group.members) expect(names.has(`CN_${member}`), `CN_${member}`).toBe(true);
      }
      // Sections of China-specific providers are labelled as overrides.
      expect((root.match(/OPTIONAL overrides?; unset = (the )?shared stack/g) ?? []).length).toBeGreaterThanOrEqual(5);
    });

    it('documents every variable the parity plan introduces or redefines, each once', () => {
      // GOAPPLY_PARITY_PLAN §4.
      const PLAN_VARIABLES = [
        'CN_LLM_DOMESTIC_ONLY',
        'CN_RESIDENCY_STRICT',
        'CN_STORAGE_MODE',
        'CN_INTERVIEW_CAMERA_PUBLISH',
        'CN_RECRUITMENT_INFO_MODE',
        'CN_CAMPUS_CALENDAR_ENABLED',
        'CN_SIGNUP_MODE',
        'CN_PAYMENTS_ENABLED',
        'CN_PAYMENT_REQUIRE_ENTITY',
        'CN_EMAIL_TRANSPORT',
        'GOHIRE_BANK_TRANSPORT',
        'GOHIRE_SYNDICATION_URL',
        'GOHIRE_PUBLIC_JOB_URL_TEMPLATE',
        'ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE',
        'JOB_PROVIDERS_ROBOAPPLY',
        'JOB_PROVIDERS_GOAPPLY',
        'ALLOWED_BRANDS',
        'CN_PRICE_PRO_WEEK_PASS_FEN',
        'CN_PRICE_PRO_MONTHLY_FEN',
        'CN_PRICE_PRO_QUARTERLY_FEN',
        'CN_PRICE_PRACTICE_PACK_5_FEN',
        'CN_PRICE_PRACTICE_PACK_15_FEN',
        'CN_PRICE_STUDENT_MONTHLY_FEN',
        'CN_PRICE_STUDENT_QUARTERLY_FEN',
        'CN_VAPID_PUBLIC_KEY',
        'CN_VAPID_PRIVATE_KEY',
        'CN_VAPID_SUBJECT',
        // Shared names GoApply reads since the per-key rule (brandEnv('goapply', 'LLM_CAMPUS_MODEL' | 'LLM_FRAUD_MODEL')).
        'LLM_CAMPUS_MODEL',
        'LLM_FRAUD_MODEL',
        'CN_LLM_CAMPUS_MODEL',
        'CN_LLM_FRAUD_MODEL',
      ];
      for (const name of PLAN_VARIABLES) {
        const entries = root.match(new RegExp(`^#? ?${name}=`, 'gm')) ?? [];
        expect(entries, name).toHaveLength(1);
      }
      // Defaults are written next to the switch, as the commented-out value.
      for (const line of [
        '# CN_SIGNUP_MODE=open',
        '# CN_RECRUITMENT_INFO_MODE=licensed',
        '# CN_CAMPUS_CALENDAR_ENABLED=true',
        '# CN_PAYMENTS_ENABLED=true',
        '# CN_EMAIL_TRANSPORT=resend',
        '# CN_STORAGE_MODE=store',
        '# CN_INTERVIEW_CAMERA_PUBLISH=true',
        '# CN_RESIDENCY_STRICT=false',
        '# CN_LLM_DOMESTIC_ONLY=false',
        '# CN_PAYMENT_REQUIRE_ENTITY=false',
      ]) {
        expect(root, line).toMatch(new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
      }
      expect(root).toMatch(/open \| invite \| closed/);
      expect(root).toMatch(/aliyun_dm \| resend \| none/);
      expect(root).toMatch(/store \| redact \| discard/);
      expect(root).toMatch(/db \| api \| off/);
      // The bank page templates have no default: commented out, no value.
      expect(root).toMatch(/^# GOHIRE_PUBLIC_JOB_URL_TEMPLATE=$/m);
      expect(root).toMatch(/^# ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE=$/m);
      // Each CN_ task model names the shared name it falls back to.
      expect(root).toMatch(/unset = LLM_FRAUD_MODEL, then the\s+# enrichment model/);
      expect(root).toMatch(/unset =\s+# LLM_CAMPUS_MODEL, then the enrichment model/);
      // The command that shows which stack each GoApply task resolves to exists.
      expect(root).toContain('`npm run verify:llm`');
      expect((JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts['verify:llm']).toBeTruthy();
    });

    it('every FLAG_GOAPPLY_ example does what the text says: an off switch switches something off, an on switch on', () => {
      // The shared credentials, so that a capability is on unless its switch says otherwise.
      const shared: Env = {
        LLM_PROVIDER: 'openrouter',
        LLM_MODEL: 'openrouter/google/gemini-3-flash-preview',
        OPENROUTER_API_KEY: 'llm-key-for-tests',
        RESEND_API_KEY: 'resend-key-for-tests',
        LIVEKIT_URL: 'wss://shared.livekit.example',
        LIVEKIT_API_KEY: 'lk-key-for-tests',
        LIVEKIT_API_SECRET: 'lk-secret-for-tests',
        VAPID_PUBLIC_KEY: 'vapid-public-for-tests',
        VAPID_PRIVATE_KEY: 'vapid-private-for-tests',
        VAPID_SUBJECT: 'mailto:support@goapply.top',
        SMS_DEV_CONSOLE: 'true', // the phone demo, so the phone sign-in switch has something to switch off
      };
      const goapply = getBrand('goapply');
      const before = resolveFlags(goapply, shared) as Record<string, unknown>;
      const changedBy = (name: string, value: string) => {
        const after = resolveFlags(goapply, { ...shared, [name]: value }) as Record<string, unknown>;
        return Object.keys(before).filter((k) => before[k] !== after[k]);
      };
      const block = root.slice(root.indexOf('# Per-brand capability overrides'), root.indexOf('# System user for system-owned records'));
      expect(block.length).toBeGreaterThan(300);
      // Off switches: written as FLAG_GOAPPLY_<KEY>=false.
      const offExamples = [...block.matchAll(/\b(FLAG_GOAPPLY_[A-Z_]+)=false\b/g)].map((m) => m[1]!);
      expect(offExamples.length).toBeGreaterThanOrEqual(5);
      for (const name of offExamples) expect(changedBy(name, 'false'), `${name}=false`).not.toEqual([]);
      // Off by default on both brands: named without a value, turned on with =true.
      const onNames = [...block.slice(block.indexOf('Off by default on both brands')).matchAll(/\b(FLAG_GOAPPLY_[A-Z_]+)\b(?!=)/g)].map((m) => m[1]!);
      expect(onNames).toEqual(expect.arrayContaining(['FLAG_GOAPPLY_VISITOR_ASSISTANT', 'FLAG_GOAPPLY_COMPANY_NEWS', 'FLAG_GOAPPLY_SEO_BROWSE']));
      for (const name of onNames) {
        expect(changedBy(name, 'true'), `${name}=true`).not.toEqual([]);
        expect(changedBy(name, 'false'), `${name}=false`).toEqual([]);
      }
    });

    it('no longer lists the removed names as settings, and says why they went', () => {
      for (const gone of ['CN_EXTERNAL_PROVIDERS', 'GOHIRE_PUBLIC_JOB_BASE_URL', 'ROBOHIRE_PUBLIC_JOB_BASE_URL', 'GOAPPLY_PREVIEW']) {
        expect(names.has(gone), gone).toBe(false);
        expect(root, gone).toContain(gone); // named once, in the "no longer read" note
      }
      expect(root).toMatch(/does not\s+#? ?exist on either site/);
    });

    it('says a deployment serves both brands unless narrowed, and that a mistyped scope fails closed', () => {
      expect(root).toMatch(/Unset: BOTH brands, in every environment/);
      expect(root).toContain('ALLOWED_BRANDS=roboapply');
      expect(root).toMatch(/serves RoboApply only/);
      expect(active.ALLOWED_BRANDS).toBeUndefined();
      expect(active.BRAND_LOCK).toBeUndefined();
      // The behaviour the text describes (PAR-1's seam).
      expect(allowedBrands({})).toEqual(['roboapply', 'goapply']);
      expect(allowedBrands({ NODE_ENV: 'production' })).toEqual(['roboapply', 'goapply']);
      expect(allowedBrands({ ALLOWED_BRANDS: 'roboaply' })).toEqual(['roboapply']);
      expect(allowedBrandsProblem({ ALLOWED_BRANDS: 'roboaply' })?.failedClosed).toBe(true);
    });

    it('copied as it is, switches no GoApply capability off and sets no half of a credential group', () => {
      // An off switch is a deliberate operator choice: the example never ships one.
      for (const name of ['CN_SIGNUP_MODE', 'CN_RECRUITMENT_INFO_MODE', 'CN_PAYMENTS_ENABLED', 'CN_CAMPUS_CALENDAR_ENABLED', 'CN_EMAIL_TRANSPORT', 'CN_INTERVIEW_CAMERA_PUBLISH', 'CN_STORAGE_MODE', 'CN_RESIDENCY_STRICT', 'CN_LLM_DOMESTIC_ONLY', 'CN_PAYMENT_REQUIRE_ENTITY', 'CN_CONTENT_SAFETY_PROVIDER', 'RA_ONBOARDING_EXTERNAL_JOBS_DISABLED', 'ATS_PUBLIC_SOURCES_DISABLED']) {
        expect(active[name], name).toBeUndefined();
      }
      expect(Object.keys(active).filter((n) => /^FLAG_GOAPPLY_/.test(n))).toEqual([]);
      expect(cnRecruitmentInfoMode(active)).toBe('licensed');
      expect(cnRecruitmentInfoModeProblem(active)).toBeNull();
      expect(cnPaymentsKilled(active)).toBe(false);
      expect(allowedBrandsProblem(active)).toBeNull();
      // No CN_ member of a group carries a value while its anchor is empty.
      expect(brandEnvGroupProblems('goapply', active)).toEqual([]);
      // No CN_ name carries a value at all, except GoApply's own origin.
      expect(Object.keys(active).filter((n) => n.startsWith('CN_'))).toEqual(['CN_CANONICAL_ORIGIN']);
    });
  });

  describe('mainland kit (deploy/cn)', () => {
    const active = activeValues(kit);
    /** What the manifests pin on the API container (asserted in "Kubernetes manifests" above). */
    const MANIFEST: Env = { NODE_ENV: 'production', PORT: '4607', DEPLOY_REGION: 'cn-mainland', ALLOWED_BRANDS: 'goapply', ROBOAPPLY_CRON_DISABLED: 'true', FILE_LOGGING: 'false' };
    /** Test values for the names the example calls required or shared. Never real credentials. */
    const FILL: Env = {
      DATABASE_URL: 'postgresql://goapply@172.16.3.4:5432/goapply',
      JWT_SECRET: 'jwt-secret-value-for-tests',
      CRON_SECRET: 'cron-secret-value-for-tests',
      INTERNAL_API_SECRET: 'internal-secret-value-for-tests',
      LLM_PROVIDER: 'openrouter',
      LLM_MODEL: 'openrouter/google/gemini-3-flash-preview',
      OPENROUTER_API_KEY: 'llm-key-for-tests',
      RESEND_API_KEY: 'resend-key-for-tests',
      ROBOAPPLY_EMAIL_FROM: 'Shared Sender <noreply@mail.example>',
      LIVEKIT_URL: 'wss://shared.livekit.example',
      LIVEKIT_API_KEY: 'lk-key-for-tests',
      LIVEKIT_API_SECRET: 'lk-secret-for-tests',
      LIVEKIT_AGENT_CALLBACK_SECRET: 'lk-callback-secret-for-tests',
      INTERVIEW_ENGINE_AGENT_NAME: 'Shared-Interview',
      INTERVIEW_ENGINE_CALLBACK_BASE_URL: 'https://www.goapply.top',
      S3_ENDPOINT: 'https://objects.example',
      S3_REGION: 'auto',
      S3_BUCKET: 'shared-bucket',
      S3_ACCESS_KEY_ID: 's3-id-for-tests',
      S3_SECRET_ACCESS_KEY: 's3-secret-for-tests',
      VAPID_PUBLIC_KEY: 'vapid-public-for-tests',
      VAPID_PRIVATE_KEY: 'vapid-private-for-tests',
      VAPID_SUBJECT: 'mailto:support@goapply.top',
      ALIPAY_CALLBACK_SECRET: 'alipay-callback-secret-for-tests',
    };
    const shared = section(kit, /Shared stack/);
    /** The example as an operator would fill it: required topology + the shared credentials, no CN_ provider. */
    const env: Env = { ...MANIFEST, ...active, ...FILL };

    /**
     * Problems that concern a China-specific provider or filing, not topology.
     * They are warnings on a default mainland deployment and failures only
     * under CN_RESIDENCY_STRICT (GOAPPLY_PARITY_PLAN §3.6; the preflight and
     * the boot check are PAR-5's). Listed here so this test holds both before
     * and after that change: none of them may be a topology code.
     */
    const STRICT_ONLY = new Set([
      'icp_missing',
      'cn_llm_off_allowlist',
      'cn_storage_missing',
      'cn_storage_offshore',
      'content_safety_not_aliyun_green',
      'content_safety_not_ready',
      'content_safety_not_cn1_ready',
      'cn_email_offshore',
    ]);
    const TOPOLOGY = ['deploy_region_not_mainland', 'deploy_region_unknown', 'db_url_missing', 'db_host_not_allowed', 'intl_brand_on_mainland', 'cron_secret_missing', 'node_cron_enabled', 'vercel_env_set'];
    const runKitPreflight = (e: Env) =>
      preflight.runPreflight({ env: e, checkResidency, contentSafetyReadiness }) as { ok: boolean; failures: Array<{ code: string }>; warnings: string[] };
    const failureCodes = (e: Env) => runKitPreflight(e).failures.map((f) => f.code);
    /**
     * True once the boot check and the preflight read CN_RESIDENCY_STRICT
     * (PAR-5, GOAPPLY_PARITY_PLAN §3.6). Decided from the source, not from
     * what the preflight reports, so a provider code that starts failing by
     * default again cannot switch the strict assertions below off.
     */
    const STRICT_POSTURE_BUILT = ['server/src/platform/residency/startupAssertions.ts', `${CN}/preflight.mjs`].every((f) => /CN_RESIDENCY_STRICT|cnResidencyStrict/.test(read(f)));

    it('carries none of the superseded prerequisites or their wording', () => {
      for (const text of [kit, kitWeb, kitReadme]) {
        for (const [label, re] of STALE) expect(re.test(text), label).toBe(false);
        expect(text).not.toMatch(/no fallback to S3_|startup refuses without CN_ICP_NUMBER|preflight requires aliyun_green/i);
      }
      // The former "Stage switches" block is gone: no off switch, no closed route.
      for (const name of ['CN_RECRUITMENT_INFO_MODE', 'CN_PAYMENTS_ENABLED', 'RA_V2_DISCOVER_DISABLED', 'CN_SIGNUP_MODE', 'CN_CAMPUS_CALENDAR_ENABLED']) {
        expect(kit, name).not.toMatch(new RegExp(`^#? ?${name}=`, 'm'));
      }
      // A provider is never selected by the example while its keys are blank.
      for (const name of ['CN_EMAIL_TRANSPORT', 'CN_CONTENT_SAFETY_PROVIDER', 'CN_SMS_PROVIDER', 'CN_INTERVIEW_ENGINE_AGENT_NAME']) {
        expect(active[name], name).toBeUndefined();
        expect(kit, name).toMatch(new RegExp(`^# ${name}=`, 'm')); // still shown, as an opt-in
      }
    });

    it('labels every China-specific provider section an optional override', () => {
      const headings = kit.split('\n').filter((l) => l.startsWith('# ──'));
      for (const topic of [/object storage/i, /domestic LLMs/i, /content safety/i, /email/i, /media plane/i]) {
        const heading = headings.find((h) => topic.test(h));
        expect(heading, String(topic)).toBeDefined();
        expect(heading, String(topic)).toMatch(/Optional override/);
      }
      expect(headings.find((h) => /sign-in methods/i.test(h))).toMatch(/Optional additional/);
      expect(kit).toMatch(/Every CN_<NAME> value below is an OPTIONAL override of <NAME>/);
      expect(kit).toMatch(/No China-specific provider, licence number or stage switch is a prerequisite/);
    });

    it('lists the shared stack GoApply runs on, and keeps the deployment scope', () => {
      expect(shared).toEqual(
        expect.arrayContaining(['LLM_PROVIDER', 'LLM_MODEL', 'RESEND_API_KEY', 'ROBOAPPLY_EMAIL_FROM', 'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']),
      );
      expect(shared.filter((n) => n.startsWith('CN_'))).toEqual([]);
      // Every shared name a test value is given for is one the example lists.
      const listed = new Set(envNames(`${CN}/cn.env.example`).map(([n]) => n));
      for (const name of Object.keys(FILL)) expect(listed.has(name), name).toBe(true);
      // The scope stays pinned by the manifests, and the examples say so.
      for (const text of [kit, kitWeb]) expect(text).toMatch(/ALLOWED_BRANDS=goapply/);
      expect(active.ALLOWED_BRANDS).toBeUndefined();
      expect(active.DEPLOY_REGION).toBeUndefined();
      expect(kit).toContain('intl_brand_on_mainland');
    });

    it('names the shared verified sender beside the Resend key (mail from an unverified goapply.top address is refused)', () => {
      // GoApply on Resend sends from CN_EMAIL_FROM, else the shared verified
      // sender, else noreply@goapply.top (GOAPPLY_PARITY_PLAN §3.4). The last
      // one is not a verified domain on the shared account, so a kit that
      // lists only the key describes a GoApply whose mail is not delivered.
      const lines = kit.split('\n');
      const key = lines.indexOf('RESEND_API_KEY=');
      expect(key).toBeGreaterThan(0);
      expect(lines[key + 1]).toBe('ROBOAPPLY_EMAIL_FROM=');
      expect(lines.slice(key - 6, key).join('\n')).toMatch(/verified sender/);
      expect(kit).toContain(getBrand('goapply').email.fromAddress); // the address that is refused while unverified
      expect(kitReadme).toContain('ROBOAPPLY_EMAIL_FROM');
      // The root example ships the shared sender as an active line, so GoApply mail has a verified address by default.
      expect(activeValues(root).ROBOAPPLY_EMAIL_FROM).toBeTruthy();
      expect(activeValues(root).CN_EMAIL_FROM).toBeUndefined();
    });

    it('offers the strict mainland posture as a commented-out block, never as a default', () => {
      const strict = kit.slice(kit.indexOf('Strict mainland posture'));
      expect(strict.length).toBeGreaterThan(100);
      for (const line of ['# CN_RESIDENCY_STRICT=true', '# CN_LLM_DOMESTIC_ONLY=true', '# CN_STORAGE_MODE=redact']) expect(strict, line).toContain(`\n${line}\n`);
      for (const name of ['CN_RESIDENCY_STRICT', 'CN_LLM_DOMESTIC_ONLY', 'CN_STORAGE_MODE']) expect(active[name], name).toBeUndefined();
      expect(strict).toMatch(/never implied by a missing value/);
    });

    it('with a database, the secrets and the shared credentials, the preflight passes (with warnings) and refuses only topology', () => {
      const report = runKitPreflight(env);
      const codes = report.failures.map((f) => f.code);
      expect(codes.filter((c) => TOPOLOGY.includes(c))).toEqual([]);
      // A code outside these two lists would be a new kind of refusal the example runs into.
      expect(codes.filter((c) => !STRICT_ONLY.has(c))).toEqual([]);
      if (STRICT_POSTURE_BUILT) {
        // The item's ACCEPT line: no failure at all, the provider and filing problems are warnings.
        expect(codes).toEqual([]);
        expect(report.ok).toBe(true);
        expect(report.warnings.length).toBeGreaterThan(0);
        // The same environment under the strict posture is refused again, and only for provider or filing reasons.
        const strictCodes = failureCodes({ ...env, CN_RESIDENCY_STRICT: 'true' });
        expect(strictCodes).toEqual(expect.arrayContaining(['icp_missing', 'cn_storage_missing']));
        expect(strictCodes.filter((c) => !STRICT_ONLY.has(c))).toEqual([]);
      }
      // Before the strict posture is built (this bundle's base) the provider
      // codes above still fail by default; the two assertions before the
      // branch are all that can hold on both sides of the merge.
      // Topology is still refused.
      expect(failureCodes({ ...env, DATABASE_URL: undefined })).toContain('db_url_missing');
      expect(failureCodes({ ...env, ALLOWED_BRANDS: 'goapply,roboapply' })).toContain('intl_brand_on_mainland');
      // A mistyped scope leaves RoboApply as the only brand, which the mainland stack refuses.
      expect(failureCodes({ ...env, ALLOWED_BRANDS: 'gopply' })).toContain('intl_brand_on_mainland');
      expect(failureCodes({ ...env, CRON_SECRET: undefined })).toContain('cron_secret_missing');
    });

    it('that same environment describes a working GoApply: every shared capability is on', () => {
      const flags = resolveFlags(getBrand('goapply'), env);
      for (const key of ['ai.text', 'ai.vision', 'copilot', 'notify.email', 'auth.passwordReset', 'jobs.feed', 'jobs.recommendations', 'jobs.alerts', 'campusCalendar', 'interviewVoice', 'ai.interviewVoice', 'webPush', 'coaching', 'student', 'pay.alipay'] as const) {
        expect(flags[key], key).toBe(true);
      }
      // Market differences stay different (D5): no Stripe, Google or LINE on GoApply.
      for (const key of ['pay.stripe', 'auth.google', 'auth.line'] as const) expect(flags[key], key).toBe(false);
      expect(brandEnvGroupProblems('goapply', env)).toEqual([]);
      expect(cnRecruitmentInfoMode(env)).toBe('licensed');
      expect(cnPaymentsKilled(env)).toBe(false);
    });

    it('the README names what the preflight refuses (topology) and what it only warns about', () => {
      expect(kitReadme).toMatch(/exits 1 only on topology/);
      expect(kitReadme).toMatch(/CN_RESIDENCY_STRICT=true/);
      expect(kitReadme).toMatch(/optional override, never a prerequisite/);
      expect(kitReadme).toContain('GOAPPLY_PARITY_PLAN.md');
      for (const anchor of ['CN_S3_BUCKET', 'CN_LIVEKIT_URL', 'CN_VAPID_PUBLIC_KEY']) expect(kitReadme, anchor).toContain(anchor);
    });
  });

  describe('clone dev script (scripts/dev-clone.sh)', () => {
    it('is valid bash', () => {
      expect(() => execFileSync('bash', ['-n', join(ROOT, 'scripts/dev-clone.sh')], { encoding: 'utf8' })).not.toThrow();
    });

    it('sets no GoApply preview profile: no CN_ export, and SMS_DEV_CONSOLE is the one optional line', () => {
      const body = code(devScript);
      const exported = [...body.matchAll(/^\s*export ([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
      expect(exported.filter((n) => n.startsWith('CN_'))).toEqual([]);
      expect(exported.sort()).toEqual(['INTERVIEW_ENGINE_AGENT_NAME', 'NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_SHOW_ALL_NAV', 'PORT', 'SMS_DEV_CONSOLE']);
      expect(body).toMatch(/export SMS_DEV_CONSOLE="\$\{SMS_DEV_CONSOLE:-true\}"/);
      // GOAPPLY_PREVIEW gates nothing any more: it is only acknowledged.
      expect(body).not.toMatch(/GOAPPLY_PREVIEW:-1/);
      expect(body).not.toMatch(/if \[ "\$\{GOAPPLY_PREVIEW/);
      for (const [label, re] of STALE) expect(re.test(devScript), label).toBe(false);
      expect(devScript).not.toMatch(/ships with them off|stay off|never falls/i);
    });

    it('keeps the ports, the worker agent name and the three processes', () => {
      const body = code(devScript);
      expect(body).toMatch(/export PORT=4621/);
      expect(body).toMatch(/NEXT_PUBLIC_API_URL=http:\/\/localhost:4621/);
      expect(body).toMatch(/next dev -p 3621/);
      expect(body).toMatch(/INTERVIEW_ENGINE_AGENT_NAME="\$\{INTERVIEW_ENGINE_AGENT_NAME_CLONE:-RoboApply-Interview-Clone\}"/);
      expect(body).toMatch(/--names api,web,agent/);
      expect(body).toMatch(/npx tsx watch server\/src\/app\.ts/);
      expect(body).toMatch(/\.\/scripts\/dev-interview-agent\.sh/);
    });
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
