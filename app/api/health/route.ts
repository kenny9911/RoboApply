// Liveness probe for Render. Returns 200 OK with the current timestamp.
// Render's health check polls this every 30s.

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  return NextResponse.json({
    ok: true,
    ts: new Date().toISOString(),
    service: 'roboapply-app',
  });
}
