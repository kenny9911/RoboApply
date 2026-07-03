// Parse a human duration env value into SECONDS.
//
// Why this exists: .env.example documents `SESSION_EXPIRES_IN=30d` /
// `JWT_EXPIRES_IN=7d`, but the readers did `parseInt('30d')` → 30 SECONDS.
// Every login died half a minute later — the user was bounced back to /login
// in an endless loop while the cookie itself (Max-Age 30 days) looked fine.
// Accepts: bare seconds ("2592000"), or a number with a unit suffix —
// s(econds), m(inutes), h(ours), d(ays), w(eeks). Falls back to
// `fallbackSeconds` on anything unparseable, never to a silent tiny TTL.
const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

export function parseDurationSeconds(
  raw: string | undefined,
  fallbackSeconds: number,
): number {
  if (!raw) return fallbackSeconds;
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*([smhdw]?)$/i);
  if (!match) return fallbackSeconds;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return fallbackSeconds;
  const unit = match[2].toLowerCase() || 's';
  return Math.round(value * UNIT_SECONDS[unit]);
}
