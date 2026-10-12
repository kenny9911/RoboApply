// server/src/features/notify-cn/signature.ts — WeChat 公众号 signatures and message crypto (WP-73).
//
//   serverSignature    sha1 of the sorted [token, timestamp, nonce] (URL verification
//                      and every server message; WeChat puts it in the query)
//   msgSignature       sha1 of the sorted [token, timestamp, nonce, Encrypt] (安全模式)
//   decryptMessage     AES-256-CBC with the EncodingAESKey (key = base64(aesKey + '='),
//                      iv = key[0..16), PKCS#7 padded to 32 bytes); plain text =
//                      16 random bytes ‖ uint32be length ‖ message ‖ appid
//   jsSdkSignature     sha1("jsapi_ticket=…&noncestr=…&timestamp=…&url=…"), url without '#…'
// Comparisons are constant time. Pure functions; no I/O.

import crypto from 'node:crypto';

const sha1 = (s: string) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');

/** Constant-time equality of two hex/ASCII strings. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function serverSignature(token: string, timestamp: string, nonce: string): string {
  return sha1([token, timestamp, nonce].sort().join(''));
}

export function verifyServerSignature(token: string, q: { signature: string; timestamp: string; nonce: string }): boolean {
  return safeEqual(serverSignature(token, q.timestamp, q.nonce), q.signature.toLowerCase());
}

export function msgSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
  return sha1([token, timestamp, nonce, encrypt].sort().join(''));
}

/** Messages older or newer than this (seconds) are refused (replay guard; WeChat retries within ~15 s). */
export const MAX_CLOCK_SKEW_SEC = 300;

export function timestampFresh(timestamp: string, now: Date, maxSkewSec = MAX_CLOCK_SKEW_SEC): boolean {
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  return Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp)) <= maxSkewSec;
}

export class WechatCryptoError extends Error {
  constructor(reason: string) {
    super(`wechat message crypto: ${reason}`);
    this.name = 'WechatCryptoError';
  }
}

function aesKeyBytes(encodingAesKey: string): Buffer {
  const key = Buffer.from(`${encodingAesKey}=`, 'base64');
  if (key.length !== 32) throw new WechatCryptoError('bad_key');
  return key;
}

/** Decrypt an `Encrypt` payload; throws when the padding, length or appid do not check out. */
export function decryptMessage(encodingAesKey: string, encrypt: string, appId: string): string {
  const key = aesKeyBytes(encodingAesKey);
  let plain: Buffer;
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
    decipher.setAutoPadding(false);
    plain = Buffer.concat([decipher.update(Buffer.from(encrypt, 'base64')), decipher.final()]);
  } catch {
    throw new WechatCryptoError('decrypt_failed');
  }
  const pad = plain[plain.length - 1] ?? 0;
  if (pad < 1 || pad > 32 || pad > plain.length) throw new WechatCryptoError('bad_padding');
  const body = plain.subarray(0, plain.length - pad);
  if (body.length < 20) throw new WechatCryptoError('too_short');
  const len = body.readUInt32BE(16);
  if (20 + len > body.length) throw new WechatCryptoError('bad_length');
  const message = body.subarray(20, 20 + len).toString('utf8');
  const fromAppId = body.subarray(20 + len).toString('utf8');
  if (!safeEqual(fromAppId, appId)) throw new WechatCryptoError('appid_mismatch');
  return message;
}

/** Encrypt a message the way WeChat does (tests and replies). */
export function encryptMessage(encodingAesKey: string, message: string, appId: string, random: Buffer = crypto.randomBytes(16)): string {
  const key = aesKeyBytes(encodingAesKey);
  const msg = Buffer.from(message, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(msg.length, 0);
  const body = Buffer.concat([random.subarray(0, 16), len, msg, Buffer.from(appId, 'utf8')]);
  const pad = 32 - (body.length % 32);
  const padded = Buffer.concat([body, Buffer.alloc(pad, pad)]);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

/** The URL WeChat signs: the page URL without its fragment. */
export function jsSdkUrl(url: string): string {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

export function jsSdkSignature(ticket: string, nonceStr: string, timestamp: number, url: string): string {
  return sha1(`jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${jsSdkUrl(url)}`);
}

/** 16 alphanumeric characters for `nonceStr`. */
export function nonceStr(): string {
  return crypto.randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 16);
}
