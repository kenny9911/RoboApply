// GET /manifest.webmanifest/icon/:size — the brand mark as a square PNG
// (192 or 512) for install surfaces that need a raster icon (WP-61). The
// artwork is the brand's own SVG mark (brand.assets.mark), read from the
// file in public/ (../mark.ts; never fetched over HTTP) and rasterised;
// nothing is drawn here, so the icon cannot drift from the mark.

import { ImageResponse } from 'next/og';
import type { NextRequest } from 'next/server';

import { brandIdFromRequestParts } from '../../../../lib/server/brand';
import { isManifestIconSize } from '../../manifest';
import { readBrandMark } from '../mark';

export async function GET(req: NextRequest, { params }: { params: Promise<{ size: string }> }): Promise<Response> {
  const { size } = await params;
  if (!isManifestIconSize(size)) return new Response('Not found', { status: 404 });
  const px = Number(size);
  const svg = await readBrandMark(brandIdFromRequestParts(req.headers, req.cookies));
  if (svg === null) return new Response('Not found', { status: 404 });
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} width={px} height={px} alt="" />
      </div>
    ),
    { width: px, height: px, headers: { 'cache-control': 'public, max-age=86400', vary: 'Host, X-Forwarded-Host' } },
  );
}
