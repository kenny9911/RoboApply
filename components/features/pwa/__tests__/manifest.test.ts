// WP-61: the host-aware web app manifest (app/manifest.webmanifest/).

import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { getBrand } from '../../../../lib/brand';
import { MANIFEST_ICON_SIZES, buildManifest, isManifestIconSize } from '../../../../app/manifest.webmanifest/manifest';
import { GET } from '../../../../app/manifest.webmanifest/route';

describe('buildManifest', () => {
  it('names, colours and icons come from the brand', () => {
    for (const id of ['roboapply', 'goapply'] as const) {
      const brand = getBrand(id);
      const m = buildManifest(brand);
      expect(m.name).toBe(brand.name);
      expect(m.short_name).toBe(brand.name);
      expect(m.lang).toBe(brand.defaultLocale);
      expect(m.theme_color).toBe(brand.theme.themeColorLight);
      expect(m.display).toBe('standalone');
      expect(m.start_url).toBe('/');
      expect(m.icons[0]).toEqual({ src: brand.assets.mark, sizes: 'any', type: 'image/svg+xml', purpose: 'any' });
      expect(m.icons.slice(1).map((i) => i.sizes)).toEqual(MANIFEST_ICON_SIZES.map((s) => `${s}x${s}`));
    }
  });

  it('accepts only the published icon sizes', () => {
    expect(isManifestIconSize('192')).toBe(true);
    expect(isManifestIconSize('512')).toBe(true);
    expect(isManifestIconSize('64')).toBe(false);
    expect(isManifestIconSize('192.0')).toBe(false);
    expect(isManifestIconSize('abc')).toBe(false);
  });
});

describe('GET /manifest.webmanifest', () => {
  it('serves the brand of the request host', async () => {
    const robo = await GET(new NextRequest('https://www.roboapply.io/manifest.webmanifest'));
    expect(robo.headers.get('content-type')).toMatch(/application\/manifest\+json/);
    expect(robo.headers.get('vary')).toMatch(/Host/);
    expect((await robo.json()).name).toBe(getBrand('roboapply').name);

    const go = await GET(new NextRequest('https://www.goapply.top/manifest.webmanifest', { headers: { host: 'www.goapply.top' } }));
    const body = await go.json();
    expect(body.name).toBe(getBrand('goapply').name);
    expect(body.lang).toBe('zh');
  });
});
