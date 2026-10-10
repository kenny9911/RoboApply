// @vitest-environment node
// WP-61: the PNG manifest icons (app/manifest.webmanifest/icon/). The mark is
// read from public/ on disk (stubbed here), never fetched over HTTP.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const reads: string[] = [];
let missing = false;
vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>();
  const readFile = async (file: string) => {
    reads.push(String(file));
    if (missing) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#123456"/></svg>';
  };
  return { ...actual, readFile, default: { ...actual, readFile } };
});

import { getBrand } from '../../../../lib/brand';
import { brandMarkFile, isInsidePublic } from '../../../../app/manifest.webmanifest/icon/mark';
import { GET } from '../../../../app/manifest.webmanifest/icon/[size]/route';

const HOSTS = { roboapply: 'www.roboapply.io', goapply: 'www.goapply.top' } as const;

function request(brand: keyof typeof HOSTS, size: string) {
  const host = HOSTS[brand];
  return GET(new NextRequest(`https://${host}/manifest.webmanifest/icon/${size}`, { headers: { host } }), { params: Promise.resolve({ size }) });
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(buf: Uint8Array): { w: number; h: number } {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { w: v.getUint32(16), h: v.getUint32(20) };
}

afterEach(() => {
  reads.length = 0;
  missing = false;
  vi.unstubAllGlobals();
});

describe('brand mark file', () => {
  it('is the registry mark of each brand, inside public/, and ships in the repo', () => {
    for (const id of ['roboapply', 'goapply'] as const) {
      const file = brandMarkFile(id);
      expect(file).toBe(path.join(process.cwd(), 'public', getBrand(id).assets.mark.replace(/^\//, '')));
      expect(isInsidePublic(file)).toBe(true);
      expect(existsSync(file)).toBe(true);
    }
    expect(isInsidePublic(path.join(process.cwd(), 'public', '..', '.env'))).toBe(false);
    expect(isInsidePublic(path.join(process.cwd(), 'public-other', 'x.svg'))).toBe(false);
  });
});

describe('GET /manifest.webmanifest/icon/:size', () => {
  it('renders a 192 and 512 PNG for both brands from the mark on disk, with no network request', async () => {
    // The rasteriser may load its own wasm through a data: URL; anything
    // http(s) would be a request back to a host.
    const realFetch = globalThis.fetch;
    const httpCalls: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (/^https?:/i.test(url)) {
        httpCalls.push(url);
        return Promise.reject(new Error('no network in tests'));
      }
      return realFetch(input, init);
    });
    for (const brand of ['roboapply', 'goapply'] as const) {
      for (const size of ['192', '512']) {
        reads.length = 0;
        const res = await request(brand, size);
        expect(res.status, `${brand} ${size}`).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/png');
        expect(res.headers.get('vary')).toMatch(/Host/);
        const buf = new Uint8Array(await res.arrayBuffer());
        expect([...buf.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        expect(pngSize(buf)).toEqual({ w: Number(size), h: Number(size) });
        expect(reads).toEqual([brandMarkFile(brand)]);
      }
    }
    expect(httpCalls).toEqual([]);
  }, 30_000);

  it('answers 404 for other sizes and when the mark file is missing', async () => {
    expect((await request('roboapply', '64')).status).toBe(404);
    expect(reads).toEqual([]);
    missing = true;
    expect((await request('goapply', '192')).status).toBe(404);
  });
});
