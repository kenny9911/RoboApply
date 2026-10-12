// server/src/platform/billing/rails/alipayWorker.ts
//
// AlipayWorkerRail (GoApply, CNY one-time passes and packs) over the existing
// GoHire payment worker. ARCHITECTURE.md §7.4; owner ruling D6: mainland
// China pays with Alipay through THIS implementation, and its request,
// callback and verification path is kept as it is. The twelve "do not break"
// rules (docs/jobright-clone/market/MARKET_STRATEGY.md §5.2) are frozen by
// the tests named "Alipay contract A1 … A12"; read them before editing here.
//
//   - Only GoApply sells through it (RoboApply's rails are ['stripe']; old
//     RoboApply Alipay passes are honoured to expiry by the callback path).
//   - The rail opens with one credential, ALIPAY_CALLBACK_SECRET (the
//     `pay.alipay` capability, platform/flags.ts; D5). The worker URL has a
//     default (ALIPAY_API_URL overrides it) and there is no master switch:
//     CN_PAYMENTS_ENABLED=false is the kill switch.
//   - The worker bills whole yuan; a price that is not a whole yuan is refused
//     rather than rounded.
//   - `platform` stays 'gohire' (the only merchant the worker has) until a
//     GoApply platform exists (`CN_ALIPAY_PLATFORM`).
//   - The collecting entity is NOT a gate. When CN_PAYMENT_COLLECTING_ENTITY
//     is set, the order body and the receipt name it; when it is unset the
//     order is created without it and one warning is logged per process
//     (`warnIfAlipayEntityUnset`), the first time the running deployment asks
//     whether GoApply can charge. Not at module import: an entry point that
//     loads `.env` in its own body (server/src/app.ts) evaluates every static
//     import first, so the credentials are not in the environment yet and the
//     notice would be skipped. CN_PAYMENT_REQUIRE_ENTITY=true restores the
//     hard gate: the rail then reports itself unconfigured and a checkout
//     answers `rail_not_configured` until the entity is named.
//   - Callbacks prove themselves with ALIPAY_CALLBACK_SECRET echoed back by
//     the worker (constant-time compare). Without the secret every callback
//     is refused (503), including legacy RoboApply orders: the buyer sees the
//     order number, so an unauthenticated callback could fulfil an unpaid
//     order.
//
// Wire parity with production and callback tolerance (MARKET_STRATEGY §5.3
// G4, G6 to G10; requirements AL-3, AL-4). All additive: nothing here changes
// an answer code of rule A2, the claim, the table or `fulfilPass`.
//   - G7: the order number is `RAORDER_…` for both brands, as production's
//     is. The brand of an order is in `AlipayOrder.brand`.
//   - G6: `body` is sent only when a collecting entity is configured;
//     production sends none.
//   - G10: `package_data.package_id` is the plan key. With
//     CN_ALIPAY_PACKAGE_ID_MODE=legacy it is production's `starter` and the
//     plan key stays in `package_name` (the fallback if the worker validates
//     the id).
//   - G8: GoApply's `notify_url` is on GoApply's own host
//     (`alipayNotifyOrigin`: CN_ALIPAY_NOTIFY_ORIGIN, else CN_BACKEND_URL,
//     else https://www.goapply.top), never on BACKEND_URL or another brand's
//     host. The resolved host is logged (`logAlipayNotifyHostOnce`) so the
//     cut-over pre-flight can prove it answers before any order is created.
//   - G9: `total_amount` is yuan. A value that can only be fen for this order
//     (exactly 100 times its price) is accepted as fen; a malformed or
//     implausible value is "not stated" and logged; a real mismatch is still
//     refused by `fulfilPass`. The order is read here ONLY when the value can
//     be a fen amount, and that read never throws.
//   - G4: with a secret configured, a callback that carries no `cb` at all is
//     accepted only for an order PRODUCTION created (an Alipay row with no
//     brand: this code writes the brand on every order it creates) before
//     ALIPAY_SECRETLESS_UNTIL, and only until 7 days after that instant. A
//     `cb` that does not match is always refused, before any database access.
//     The state of the window is logged at startup
//     (`logAlipaySecretlessWindowOnce`).

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { brandEnv, parseBoolEnv, type EnvSource } from '../../brand/brandEnv.js';
import { getBrand, type ProductBrand } from '../../brand/registry.js';
import { allowedBrands } from '../../brand/runtime.js';
import { requirementsMet } from '../../flags.js';
import type { ExtendedPrismaClient } from '../../../lib/prisma.js';
import { logger } from '../../../services/LoggerService.js';
import { BillingError } from '../errors.js';
import {
  ALIPAY_NOTIFY_ORIGIN_ENV,
  alipayNotifyOrigin,
  appOrigin,
  originHost,
  resolveAlipayNotifyOrigin,
  withQueryParam,
  type AlipayNotifyOverrideProblem,
} from '../origins.js';
import { assertStudentOrder } from '../studentPlans.js';
import { CallbackRejectedError, type CallbackInput, type CallbackVerification, type CheckoutOrder, type CheckoutResult, type PaymentRailImpl } from './types.js';

export const ALIPAY_DEFAULT_WORKER_URL = 'https://worker.gohire.top/payment/payment/create';
export const ALIPAY_CALLBACK_PATH = '/api/v1/roboapply/billing/alipay/callback';

export type AlipayRailDb = Pick<ExtendedPrismaClient, 'alipayOrder'>;

export interface AlipayRailDeps {
  fetch?: typeof fetch;
  getDb?: () => Promise<AlipayRailDb>;
  env?: EnvSource;
  now?: () => Date;
}

const defaultGetDb = async (): Promise<AlipayRailDb> => (await import('../../../lib/prisma.js')).default;

/**
 * The entity that actually collects the money (named on the order body and
 * the receipt), or null when none is configured. Brand-own: GoApply reads
 * CN_PAYMENT_COLLECTING_ENTITY only, never another brand's value (D3).
 */
export function collectingEntity(brand: ProductBrand, env: EnvSource = process.env): string | null {
  return brandEnv(brand, 'PAYMENT_COLLECTING_ENTITY', env) ?? null;
}

/**
 * The opt-in hard gate (`CN_PAYMENT_REQUIRE_ENTITY=true`): a GoApply order is
 * refused until the collecting entity is named. Off by default (D5): the
 * entity is printed when set and is otherwise simply absent.
 */
export function alipayEntityRequired(brand: ProductBrand, env: EnvSource = process.env): boolean {
  return brand.market === 'cn' && parseBoolEnv(env.CN_PAYMENT_REQUIRE_ENTITY);
}

/**
 * What to tell the operator when GoApply can charge through Alipay but no
 * collecting entity is named, or null when there is nothing to say: the
 * deployment does not serve GoApply, the rail cannot charge (no callback
 * secret, or the kill switch), an entity is set, or the hard gate is on (the
 * rail refuses instead).
 */
export function alipayEntityNotice(env: EnvSource = process.env): string | null {
  const brand = getBrand('goapply');
  if (!allowedBrands(env).includes(brand.id)) return null;
  if (!requirementsMet('pay.alipay', brand, env)) return null;
  if (collectingEntity(brand, env) || alipayEntityRequired(brand, env)) return null;
  return 'GoApply Alipay orders and receipts name no collecting entity: set CN_PAYMENT_COLLECTING_ENTITY to print it (CN_PAYMENT_REQUIRE_ENTITY=true refuses to charge without it).';
}

let entityNoticeLogged = false;

/**
 * Log `alipayEntityNotice` once per process. The Alipay rail calls it the
 * first time the running deployment asks whether GoApply can charge (the
 * first plans read or checkout), which is after the environment is loaded; a
 * startup report may call it earlier and the guard keeps it to one line.
 * Returns whether it logged. `force` is for tests: it ignores the guard.
 */
export function warnIfAlipayEntityUnset(
  env: EnvSource = process.env,
  log: { warn: (tag: string, message: string, meta?: Record<string, unknown>) => void } = logger,
  opts: { force?: boolean } = {},
): boolean {
  if (entityNoticeLogged && !opts.force) return false;
  const notice = alipayEntityNotice(env);
  if (!notice) return false;
  entityNoticeLogged = true;
  log.warn('RA_BILLING', notice, { variable: 'CN_PAYMENT_COLLECTING_ENTITY' });
  return true;
}

/** Tests only: forget that the notice was logged. */
export function resetAlipayEntityNoticeForTests(): void {
  entityNoticeLogged = false;
}

/** Whether ALIPAY_CALLBACK_SECRET is set (callbacks are refused without it). */
export function alipayCallbackSecretConfigured(env: EnvSource = process.env): boolean {
  return Boolean(env.ALIPAY_CALLBACK_SECRET);
}

/**
 * Constant-time check of the worker-echoed callback secret. Fails closed: with
 * no secret configured nothing can prove a callback came from the worker (the
 * order number is shown to the buyer), so every callback is refused.
 */
export function alipayCallbackSecretOk(token: string | undefined, env: EnvSource = process.env): boolean {
  const secret = env.ALIPAY_CALLBACK_SECRET;
  if (!secret) return false;
  const a = Buffer.from(String(token ?? ''));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The order-number prefix production uses. One prefix for both brands (MARKET_STRATEGY §5.3 G7). */
export const ALIPAY_ORDER_PREFIX = 'RAORDER';

/**
 * Our order number: 'RAORDER_<yyyymmddhhmmss>_<user8>_<random>' for both
 * brands, as production's is. The brand is not in the number: it is in
 * `AlipayOrder.brand`. (`_brand` is kept so callers keep their shape.)
 */
export function newOutTradeNo(_brand: ProductBrand, userId: string, now: Date): string {
  const ts = now.toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
  return `${ALIPAY_ORDER_PREFIX}_${ts}_${userId.slice(0, 8)}_${randomBytes(5).toString('hex')}`;
}

/** `package_data.package_id` in legacy mode: the id production sends (PAYMENTS_AUDIT §A2). */
export const ALIPAY_LEGACY_PACKAGE_ID = 'starter';

/**
 * How `package_data.package_id` is filled for a GoApply order (MARKET_STRATEGY
 * §5.3 G10). Default: the plan key. `CN_ALIPAY_PACKAGE_ID_MODE=legacy`: the id
 * production sends (`starter`), with the plan key kept in `package_name`. It
 * is the fallback if the worker validates the id; the supervised first order
 * decides. Any other value is the default.
 */
export function alipayPackageIdMode(brand: ProductBrand, env: EnvSource = process.env): 'plan_key' | 'legacy' {
  return brand.market === 'cn' && env.CN_ALIPAY_PACKAGE_ID_MODE?.trim().toLowerCase() === 'legacy' ? 'legacy' : 'plan_key';
}

type RailLog = {
  info: (tag: string, message: string, meta?: Record<string, unknown>) => void;
  warn: (tag: string, message: string, meta?: Record<string, unknown>) => void;
};
let notifyHostLogged: string | null = null;

/** Why a set CN_ALIPAY_NOTIFY_ORIGIN is not used, in words. No value, no scheme, no query. */
const IGNORED_OVERRIDE_REASON: Record<AlipayNotifyOverrideProblem, string> = {
  malformed: 'it is not a URL',
  not_https: 'it is not https',
  not_an_origin: 'it is not a bare origin (it carries a path, a query, a fragment or credentials)',
};

/**
 * Log where the Alipay worker is told to send GoApply's notify: the HOST ONLY
 * and which variable decided it. Never the callback secret, never a URL with a
 * query (MARKET_STRATEGY §5.3 G8: the cut-over pre-flight must see our own
 * JSON answer from that host before any order is created).
 *
 * An info line. When CN_ALIPAY_NOTIFY_ORIGIN is set and was ignored, it is a
 * WARNING and the line says so, with the reason (never the value: someone may
 * have pasted the whole notify URL, secret included). "(no variable set)" is
 * printed only when the override really is unset.
 *
 * One line per process. It is asked for when the rail is registered
 * (`ensureDefaultRails`), which can be before an entry point has loaded
 * `.env`; so the rail asks again the first time the running deployment checks
 * whether GoApply can charge, and the line is repeated only if the answer has
 * changed since (the guard is the line itself). Says nothing when the
 * deployment does not serve GoApply. Returns whether it logged; `force` is for
 * tests. A fault here is swallowed: a log line never stops a boot or an order.
 */
export function logAlipayNotifyHostOnce(env: EnvSource = process.env, log: RailLog = logger, opts: { force?: boolean } = {}): boolean {
  try {
    const brand = getBrand('goapply');
    if (!allowedBrands(env).includes(brand.id)) return false;
    const resolved = resolveAlipayNotifyOrigin(brand, env);
    const host = originHost(resolved.origin) ?? 'unparseable';
    const ignored = resolved.ignoredOverride;
    const decidedBy = resolved.source === 'canonical' ? (ignored ? 'the brand origin' : 'the brand origin (no variable set)') : resolved.source;
    const line = ignored
      ? `GoApply Alipay notify host: ${host} (${ALIPAY_NOTIFY_ORIGIN_ENV} is set and ignored: ${IGNORED_OVERRIDE_REASON[ignored]}; decided by ${decidedBy})`
      : `GoApply Alipay notify host: ${host} (decided by ${decidedBy})`;
    if (notifyHostLogged === line && !opts.force) return false;
    const meta = {
      host,
      source: resolved.source,
      callbackPath: ALIPAY_CALLBACK_PATH,
      ...(ignored ? { ignored: { variable: ALIPAY_NOTIFY_ORIGIN_ENV, reason: ignored } } : {}),
    };
    if (ignored) log.warn('RA_BILLING', line, meta);
    else log.info('RA_BILLING', line, meta);
    notifyHostLogged = line;
    return true;
  } catch {
    return false;
  }
}

/** Tests only: forget that the notify host was logged. */
export function resetAlipayNotifyHostLogForTests(): void {
  notifyHostLogged = null;
}

// ── Callback tolerance (MARKET_STRATEGY §5.3 G9 and G4) ─────────────────────

/** A stated amount above this many yuan is not believed: it is treated as not stated (G9). */
export const ALIPAY_MAX_PLAUSIBLE_YUAN = 1_000_000;

/**
 * `total_amount` as the worker stated it, read WITHOUT the database (G9).
 *   - absent → not stated.
 *   - not well-formed (letters, a sign, more than two decimals, empty, zero)
 *     or above ALIPAY_MAX_PLAUSIBLE_YUAN → not stated, with the reason (the
 *     caller logs it).
 *   - otherwise the yuan reading in fen, exactly as before, and whether the
 *     value could instead BE a fen amount: written without a decimal point and
 *     an integer multiple of 100 (a whole-yuan price in fen always is: 1200,
 *     3900, 9900; '39.00', '39' and the JSON number 39 never are).
 */
export function readAlipayTotalAmount(
  raw: string | undefined,
  present: boolean,
): { minor: number | null; mayBeFen: boolean; notStated: null | 'malformed' | 'implausible'; rawLength: number } {
  if (raw === undefined) return { minor: null, mayBeFen: false, notStated: present ? 'malformed' : null, rawLength: 0 };
  const value = Number(raw);
  if (!/^\d+(\.\d{1,2})?$/.test(raw) || !(value > 0)) return { minor: null, mayBeFen: false, notStated: 'malformed', rawLength: raw.length };
  if (value > ALIPAY_MAX_PLAUSIBLE_YUAN) return { minor: null, mayBeFen: false, notStated: 'implausible', rawLength: raw.length };
  return { minor: Math.round(value * 100), mayBeFen: !raw.includes('.') && value % 100 === 0, notStated: null, rawLength: raw.length };
}

/**
 * The secret-less window (G4). It exists for one case only: orders PRODUCTION
 * created before the cut-over, if production ran without a callback secret
 * (cut-over checklist step 1). Their notify URL carries no `cb`, so with a
 * secret configured here they would be refused for ever. The operator sets
 * ALIPAY_SECRETLESS_UNTIL to the cut-over instant T; a callback with no `cb`
 * is then accepted only when ALL of these hold:
 *   - now < T + ALIPAY_SECRETLESS_WINDOW_DAYS. After that the window is closed
 *     for good: a pending pre-cut-over order must not stay forgeable for ever.
 *   - the order was created before T (strictly).
 *   - the order is one production wrote: an Alipay row with NO brand
 *     (`alipaySecretlessEligible`). Production's table has no brand column and
 *     its code writes none, so its rows read `brand = null`; this code writes
 *     the brand on every order it creates (here and in the WeChat Pay rail)
 *     and puts `cb` on every notify URL, so its own orders never need the
 *     window. Without this rule a buyer could fulfil their own unpaid GoApply
 *     order (the checkout answer shows them the order number) with one
 *     unauthenticated request: goapply.top sells on this code before
 *     roboapply.io is cut over, so at T the table already holds such orders,
 *     and with T mistyped into the future every order would qualify.
 */
export const ALIPAY_SECRETLESS_WINDOW_DAYS = 7;
export const ALIPAY_SECRETLESS_WINDOW_MS = ALIPAY_SECRETLESS_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * ALIPAY_SECRETLESS_UNTIL as an instant, or null when it is unset, empty or
 * not a full ISO 8601 instant with a zone (`2026-10-20T08:00:00Z`,
 * `2026-10-20T16:00:00+08:00`). A date without a time or a time without a
 * zone names no instant and opens nothing.
 */
export function alipaySecretlessUntil(env: EnvSource = process.env): Date | null {
  const raw = env.ALIPAY_SECRETLESS_UNTIL?.trim();
  if (!raw || !ISO_INSTANT.test(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * Whether an order row may be fulfilled by a callback without `cb` inside a
 * live window whose instant is `until`: an Alipay order production wrote (no
 * brand), created strictly before the instant. See the window's comment.
 */
export function alipaySecretlessEligible(row: { createdAt?: unknown; brand?: unknown; channel?: unknown } | null | undefined, until: Date): boolean {
  if (!row) return false;
  if (row.brand !== null && row.brand !== undefined) return false;
  if (row.channel !== 'alipay') return false;
  return row.createdAt instanceof Date && row.createdAt.getTime() < until.getTime();
}

/**
 * The state of the secret-less window at `at`. Pure.
 *   unset    the variable is not set: there is no window.
 *   invalid  it is set and names no instant: there is no window (the operator
 *            meant one, so this is worth a warning).
 *   open     now < T + 7 days: `until` is T, `closesAt` is T + 7 days.
 *   closed   T + 7 days has passed.
 */
export function alipaySecretlessWindowState(
  env: EnvSource = process.env,
  at: Date = new Date(),
): { state: 'unset' } | { state: 'invalid' } | { state: 'open' | 'closed'; until: Date; closesAt: Date } {
  if (!env.ALIPAY_SECRETLESS_UNTIL?.trim()) return { state: 'unset' };
  const until = alipaySecretlessUntil(env);
  if (!until) return { state: 'invalid' };
  const closesAt = new Date(until.getTime() + ALIPAY_SECRETLESS_WINDOW_MS);
  return { state: at.getTime() < closesAt.getTime() ? 'open' : 'closed', until, closesAt };
}

let secretlessWindowLogged: string | null = null;

/**
 * Say at startup whether the secret-less window is open, so the operator sees
 * it BEFORE the first callback without `cb` arrives (that callback belongs to
 * a buyer who paid, and a mistyped instant would answer them 403).
 *   - set and not an instant → one WARNING, by variable name (never the value).
 *   - open → one info line: 'Alipay secret-less window: orders created before
 *     <T>, closes <T + 7 days>'.
 *   - closed → one info line: 'Alipay secret-less window: closed since <T + 7 days>'.
 *   - unset → nothing.
 * Once per process and answer (the guard is the line itself, so the line is
 * said again when `.env` arrives after the rail was registered, and once more
 * when an open window has closed). Not tied to a brand: the orders it is for
 * are production's. Returns whether it logged; `force` and `now` are for
 * tests. A fault here is swallowed.
 */
export function logAlipaySecretlessWindowOnce(env: EnvSource = process.env, log: RailLog = logger, opts: { force?: boolean; now?: Date } = {}): boolean {
  try {
    const w = alipaySecretlessWindowState(env, opts.now ?? new Date());
    if (w.state === 'unset') return false;
    const line =
      w.state === 'invalid'
        ? 'ALIPAY_SECRETLESS_UNTIL is set and names no instant: the Alipay secret-less window is CLOSED. Write a full ISO instant with a zone, for example 2026-10-20T08:00:00Z or 2026-10-20T16:00:00+08:00'
        : w.state === 'open'
          ? `Alipay secret-less window: orders created before ${w.until.toISOString()}, closes ${w.closesAt.toISOString()}`
          : `Alipay secret-less window: closed since ${w.closesAt.toISOString()}`;
    if (secretlessWindowLogged === line && !opts.force) return false;
    if (w.state === 'invalid') log.warn('RA_BILLING', line, { variable: 'ALIPAY_SECRETLESS_UNTIL' });
    else log.info('RA_BILLING', line, { variable: 'ALIPAY_SECRETLESS_UNTIL', state: w.state, until: w.until.toISOString(), closesAt: w.closesAt.toISOString() });
    secretlessWindowLogged = line;
    return true;
  } catch {
    return false;
  }
}

/**
 * The lines the Alipay rail says about the running deployment, each once per
 * process and answer: the host GoApply's notify goes to, and the state of the
 * secret-less window. Called when the rail is registered, again by the rail
 * the first time the deployment checks whether GoApply can charge (`.env` may
 * have been loaded in between), and it is what a boot report should call.
 */
export function reportAlipayRailOnce(env: EnvSource = process.env, log: RailLog = logger): void {
  logAlipayNotifyHostOnce(env, log);
  logAlipaySecretlessWindowOnce(env, log);
}

let secretlessUnparseableLogged = false;

/** Tests only: forget what was logged about ALIPAY_SECRETLESS_UNTIL (at startup and at callback time). */
export function resetAlipaySecretlessLogForTests(): void {
  secretlessUnparseableLogged = false;
  secretlessWindowLogged = null;
}

function first(v: unknown): string | undefined {
  if (Array.isArray(v)) return first(v[0]);
  return typeof v === 'string' && v ? v : undefined;
}

export function createAlipayWorkerRail(deps: AlipayRailDeps = {}): PaymentRailImpl {
  const getDb = deps.getDb ?? defaultGetDb;
  const now = deps.now ?? (() => new Date());

  /**
   * G9, for a stated amount that can be fen (`yuanMinor` is its yuan reading,
   * so the stated number is `yuanMinor / 100`). The order is read once:
   *   - the yuan reading equals the order → it was yuan.
   *   - the stated number equals the order in fen (exactly 100 times the
   *     expected yuan, e.g. 3900 for ¥39) → it was fen: the order's amount.
   *   - anything else → the yuan reading, unchanged, so `fulfilPass` answers
   *     `amount_mismatch` as before.
   * No order row, or ANY error while reading it (a database failure included)
   * → the yuan reading, as before. This never throws.
   */
  async function yuanOrFen(outTradeNo: string, yuanMinor: number): Promise<number> {
    try {
      const db = await getDb();
      const row = await db.alipayOrder.findUnique({ where: { outTradeNo }, select: { amount: true, amountMinor: true } });
      if (!row) return yuanMinor;
      const expected = row.amountMinor ?? Math.round(row.amount * 100);
      if (yuanMinor === expected) return expected;
      if (yuanMinor / 100 === expected) {
        logger.info('RA_BILLING', 'alipay callback total_amount read as fen', { outTradeNo, expectedMinor: expected });
        return expected;
      }
      return yuanMinor;
    } catch (err) {
      logger.warn('RA_BILLING', 'alipay callback: the order could not be read for the fen check; total_amount read as yuan', {
        outTradeNo,
        error: err instanceof Error ? err.message : String(err),
      });
      return yuanMinor;
    }
  }

  /**
   * G4: whether a callback that carries no `cb` at all may pass. Evaluated in
   * this order so the database is opened only inside a live window:
   * ALIPAY_SECRETLESS_UNTIL names an instant T → now < T + 7 days → the
   * callback names an order → that order exists → it is one production wrote
   * (an Alipay row with no brand) → it was created before T
   * (`alipaySecretlessEligible`). With the variable unset, empty or
   * unparseable, or once the window has closed, the answer is no without any
   * database access. An order this code created (GoApply Alipay, WeChat Pay)
   * is never accepted here, whatever its age. A failure while reading the
   * order is not swallowed: it is an exception (HTTP 500), so the worker
   * retries, rather than a final refusal of a buyer who did pay.
   */
  async function secretlessCallbackAllowed(input: CallbackInput, body: Record<string, unknown>, env: EnvSource): Promise<boolean> {
    const until = alipaySecretlessUntil(env);
    if (!until) {
      if (env.ALIPAY_SECRETLESS_UNTIL?.trim() && !secretlessUnparseableLogged) {
        secretlessUnparseableLogged = true;
        logger.warn('RA_BILLING', 'ALIPAY_SECRETLESS_UNTIL is not an ISO instant with a zone (e.g. 2026-10-20T08:00:00Z): the secret-less window stays closed', {
          variable: 'ALIPAY_SECRETLESS_UNTIL',
        });
      }
      return false;
    }
    if (!(now().getTime() < until.getTime() + ALIPAY_SECRETLESS_WINDOW_MS)) return false;
    const outTradeNo = first(input.query.out_trade_no) ?? first(body.out_trade_no);
    if (!outTradeNo) return false;
    const db = await getDb();
    const row = await db.alipayOrder.findUnique({ where: { outTradeNo }, select: { createdAt: true, brand: true, channel: true } });
    if (!alipaySecretlessEligible(row, until)) {
      if (row && (row.brand !== null || row.channel !== 'alipay')) {
        // Worth a line: somebody asked to fulfil one of OUR orders without the secret.
        logger.warn('RA_BILLING', 'alipay callback without cb refused: the order was not created by production (it has a brand or is not an Alipay order)', { outTradeNo });
      }
      return false;
    }
    logger.warn('RA_BILLING', 'alipay callback accepted without cb: the order was created before ALIPAY_SECRETLESS_UNTIL', {
      outTradeNo,
      windowClosesAt: new Date(until.getTime() + ALIPAY_SECRETLESS_WINDOW_MS).toISOString(),
    });
    return true;
  }

  return {
    id: 'alipay',
    // Configured for both brands: the rail's one credential (the callback
    // secret) is the `pay.alipay` capability's requirement. The collecting
    // entity gates only when the operator asks for it.
    isConfigured: (brand, env) => {
      // The missing-entity notice is about the running deployment, so it is
      // raised only for the process environment (never for an environment a
      // caller is merely evaluating) and only once.
      if (brand.market === 'cn' && env === process.env) {
        warnIfAlipayEntityUnset(env);
        // The notify host and the secret-less window, again: `.env` may have been loaded after the rail was registered.
        reportAlipayRailOnce(env);
      }
      return !alipayEntityRequired(brand, env) || collectingEntity(brand, env) !== null;
    },

    async createCheckout(order: CheckoutOrder): Promise<CheckoutResult> {
      const env = deps.env ?? process.env;
      const doFetch = deps.fetch ?? fetch;
      const { brand, plan } = order;
      if (!plan.sellable || plan.amountMinor === null) {
        throw new BillingError('plan_not_sellable', 'This plan is not on sale', { planKey: plan.key });
      }
      if (plan.amountMinor % 100 !== 0) {
        throw new BillingError('price_not_whole_yuan', 'This price cannot be charged through Alipay', { planKey: plan.key });
      }
      // 学生月卡 / 学生季卡: only for a buyer the caller found verified.
      assertStudentOrder(order);
      // Printed when configured; required only under CN_PAYMENT_REQUIRE_ENTITY.
      const entity = collectingEntity(brand, env);
      if (!entity && alipayEntityRequired(brand, env)) {
        throw new BillingError('rail_not_configured', 'Payments are not open yet', { rail: 'alipay' });
      }
      const amountYuan = plan.amountMinor / 100;
      const at = now();
      const outTradeNo = newOutTradeNo(brand, order.user.id, at);
      const subject = `${brand.name} ${plan.defaultLabel}`.slice(0, 120);
      const secret = env.ALIPAY_CALLBACK_SECRET;
      const returnPath = order.successPath ?? '/settings/billing/return';
      const legacyPackageId = alipayPackageIdMode(brand, env) === 'legacy';
      const payload = {
        out_trade_no: outTradeNo,
        total_amount: amountYuan,
        subject,
        // Only with a collecting entity: production sends no `body` (G6).
        ...(entity ? { body: `${subject} · ${entity}`.slice(0, 200) } : {}),
        pay_channel: 'alipay',
        user_name: order.user.name || order.user.email,
        user_email: order.user.email,
        user_id: order.user.id,
        platform: (brand.market === 'cn' ? env.CN_ALIPAY_PLATFORM : env.ROBOAPPLY_ALIPAY_PLATFORM)?.trim() || 'gohire',
        package_data: {
          package_id: legacyPackageId ? ALIPAY_LEGACY_PACKAGE_ID : plan.key,
          package_name: plan.key,
          package_type: '1',
          package_price: String(amountYuan),
        },
        notify_url: `${alipayNotifyOrigin(brand, env)}${ALIPAY_CALLBACK_PATH}${secret ? `?cb=${encodeURIComponent(secret)}` : ''}`,
        return_url: `${appOrigin(brand, env)}${withQueryParam(returnPath, 'billing', 'success')}`,
      };

      const url = env.ALIPAY_API_URL?.trim() || ALIPAY_DEFAULT_WORKER_URL;
      let data: { code: number; data?: { pay_url?: string }; message?: string };
      try {
        const res = await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const raw = await res.text();
        try {
          data = JSON.parse(raw) as typeof data;
        } catch {
          logger.error('RA_BILLING', 'alipay worker non-JSON response', { status: res.status, body: raw.slice(0, 300), platform: payload.platform });
          throw new BillingError('payment_provider_error', 'Payment provider returned an unexpected response', { provider: 'alipay' });
        }
      } catch (err) {
        if (err instanceof BillingError) throw err;
        logger.error('RA_BILLING', 'alipay worker request failed', { error: err instanceof Error ? err.message : String(err) });
        throw new BillingError('payment_provider_error', 'Could not reach the payment provider', { provider: 'alipay' });
      }
      if (data.code !== 0 || !data.data?.pay_url) {
        logger.error('RA_BILLING', 'alipay worker error', { code: data.code, message: data.message });
        throw new BillingError('payment_provider_error', data.message || 'Failed to create the Alipay order', { provider: 'alipay' });
      }

      const db = await getDb();
      await db.alipayOrder.create({
        data: {
          userId: order.user.id,
          outTradeNo,
          tier: `ra_${plan.key}`,
          amount: amountYuan,
          amountMinor: plan.amountMinor,
          status: 'pending',
          channel: 'alipay',
          brand: brand.id,
          planKey: plan.key,
          purpose: plan.kind === 'pack' ? 'interview_pack' : 'subscription',
        },
      });
      logger.info('RA_BILLING', 'alipay order created', { userId: order.user.id, planKey: plan.key, outTradeNo, amountYuan, brand: brand.id });
      return { kind: 'redirect', url: data.data.pay_url, orderId: outTradeNo };
    },

    async verifyCallback(input: CallbackInput): Promise<CallbackVerification> {
      const env = deps.env ?? process.env;
      const body = (input.body && typeof input.body === 'object' ? input.body : {}) as Record<string, unknown>;
      const token = first(input.query.cb) ?? first(body.cb) ?? first(input.headers['x-alipay-callback-secret']);
      if (!alipayCallbackSecretConfigured(env)) {
        logger.error('RA_BILLING', 'alipay callback refused: ALIPAY_CALLBACK_SECRET is not set');
        throw new CallbackRejectedError('callback secret not configured', 'not_configured');
      }
      if (!alipayCallbackSecretOk(token, env)) {
        // A `cb` that is there and does not match (an empty one included) is
        // ALWAYS refused, before any database access (rule A6). Only a
        // callback that carries no `cb` at all may use the secret-less window.
        const carriesCb = input.query.cb !== undefined || body.cb !== undefined || input.headers['x-alipay-callback-secret'] !== undefined;
        if (carriesCb || !(await secretlessCallbackAllowed(input, body, env))) {
          throw new CallbackRejectedError('bad or missing callback secret', 'bad_secret');
        }
      }
      const payStatus = first(input.query.pay_status) ?? first(body.pay_status);
      const outTradeNo = first(input.query.out_trade_no) ?? first(body.out_trade_no);
      if (!payStatus || !outTradeNo) throw new CallbackRejectedError('invalid callback params', 'invalid_params');
      const status: CallbackVerification['status'] = payStatus === 'TRADE_SUCCESS' ? 'paid' : payStatus === 'TRADE_CLOSED' ? 'closed' : 'pending';
      const totalRaw = first(input.query.total_amount) ?? first(body.total_amount) ?? (typeof body.total_amount === 'number' ? String(body.total_amount) : undefined);
      const stated = readAlipayTotalAmount(totalRaw, input.query.total_amount !== undefined || (body.total_amount !== undefined && body.total_amount !== null));
      if (stated.notStated) {
        // The order number and the LENGTH of the raw value, never the value.
        logger.warn('RA_BILLING', 'alipay callback total_amount is not usable: treated as not stated', { outTradeNo, reason: stated.notStated, rawLength: stated.rawLength });
      }
      let total = stated.minor;
      // Only a paid trade has its amount checked, and only a value that can be fen needs the order.
      if (total !== null && stated.mayBeFen && status === 'paid') total = await yuanOrFen(outTradeNo, total);
      return { outTradeNo, status, paidAmountMinor: total, transactionId: first(input.query.trade_no) ?? first(body.trade_no) ?? null };
    },
  };
}
