// @vitest-environment node
//
// WP-73 pure parts: WeChat signatures and message crypto, the XML subset,
// template config parsing, keyword formatting, and the 公众号 API client
// (fetch is faked; nothing touches the network).

import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { configuredTemplates, DEFAULT_TEMPLATE_FIELDS, mpAesKey, mpApp, templateConfig, templateKeyForId } from './config.js';
import { formatKeyword, templateData, wechatDate, wechatTime } from './format.js';
import {
  decryptMessage,
  encryptMessage,
  jsSdkSignature,
  jsSdkUrl,
  msgSignature,
  nonceStr,
  serverSignature,
  timestampFresh,
  verifyServerSignature,
  WechatCryptoError,
} from './signature.js';
import { createWechatMpApi, WechatMpApiError, type FetchFn } from './wechatApi.js';
import { MAX_XML_BYTES, parseWechatXml } from './xml.js';

const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex');
const AES_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'; // 43 chars
const APP_ID = 'wx1234567890abcdef';

describe('server signature', () => {
  it('is sha1 of the lexicographically sorted token, timestamp and nonce', () => {
    expect(serverSignature('tok', '1700000000', 'abc')).toBe(sha1(['tok', '1700000000', 'abc'].sort().join('')));
    expect(serverSignature('tok', '1700000000', 'abc')).toBe(serverSignature('tok', '1700000000', 'abc'));
  });

  it('verifies a good signature (case-insensitive hex) and refuses a wrong token, nonce or truncated signature', () => {
    const sig = serverSignature('tok', '1700000000', 'n1');
    expect(verifyServerSignature('tok', { signature: sig, timestamp: '1700000000', nonce: 'n1' })).toBe(true);
    expect(verifyServerSignature('tok', { signature: sig.toUpperCase(), timestamp: '1700000000', nonce: 'n1' })).toBe(true);
    expect(verifyServerSignature('other', { signature: sig, timestamp: '1700000000', nonce: 'n1' })).toBe(false);
    expect(verifyServerSignature('tok', { signature: sig, timestamp: '1700000000', nonce: 'n2' })).toBe(false);
    expect(verifyServerSignature('tok', { signature: sig.slice(0, 20), timestamp: '1700000000', nonce: 'n1' })).toBe(false);
  });

  it('refuses stale, future and malformed timestamps', () => {
    const now = new Date(1_700_000_000_000);
    expect(timestampFresh('1700000000', now)).toBe(true);
    expect(timestampFresh('1699999701', now)).toBe(true);
    expect(timestampFresh('1699999000', now)).toBe(false);
    expect(timestampFresh('1700000400', now)).toBe(false);
    expect(timestampFresh('17e8', now)).toBe(false);
  });

  it('msg_signature covers the Encrypt payload too', () => {
    expect(msgSignature('tok', '1', 'n', 'ENC')).toBe(sha1(['tok', '1', 'n', 'ENC'].sort().join('')));
  });
});

describe('message crypto (安全模式)', () => {
  it('round-trips WeChat-style AES-256-CBC with 32-byte PKCS#7 padding', () => {
    const xml = '<xml><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe]]></Event></xml>';
    for (const msg of [xml, '中文内容 ✓', 'x'.repeat(31), 'y'.repeat(32)]) {
      const enc = encryptMessage(AES_KEY, msg, APP_ID);
      expect(decryptMessage(AES_KEY, enc, APP_ID)).toBe(msg);
    }
  });

  it('matches an independent decryption of the same bytes', () => {
    const enc = encryptMessage(AES_KEY, 'hello', APP_ID, Buffer.alloc(16, 7));
    const key = Buffer.from(`${AES_KEY}=`, 'base64');
    const d = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
    d.setAutoPadding(false);
    const plain = Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]);
    expect(plain.subarray(0, 16).equals(Buffer.alloc(16, 7))).toBe(true);
    expect(plain.readUInt32BE(16)).toBe(5);
    expect(plain.subarray(20, 25).toString()).toBe('hello');
    expect(plain.subarray(25, 25 + APP_ID.length).toString()).toBe(APP_ID);
    expect(plain.length % 32).toBe(0);
  });

  it('refuses another appid, a wrong key and garbage', () => {
    const enc = encryptMessage(AES_KEY, 'hello', APP_ID);
    expect(() => decryptMessage(AES_KEY, enc, 'wx_other')).toThrow(WechatCryptoError);
    expect(() => decryptMessage('Z'.repeat(43), enc, APP_ID)).toThrow(WechatCryptoError);
    expect(() => decryptMessage(AES_KEY, 'bm90IGVuY3J5cHRlZA==', APP_ID)).toThrow(WechatCryptoError);
  });
});

describe('JS-SDK signature', () => {
  it('matches the example in the WeChat JS-SDK documentation', () => {
    const ticket = 'sM4AOVdWfPE4DxkXGEs8VMCPGGVi4C3VM0P37wVUCFvkVAy_90u5h9nbSlYy3-Sl-HhTdfl2fzFy1AOcHKP7qg';
    expect(jsSdkSignature(ticket, 'Wm3WZYTPz0wzccnW', 1414587457, 'http://mp.weixin.qq.com?params=value')).toBe('0f9de62fce790f9a083d5c99e95740ceb90c27ed');
  });

  it('signs the URL without its fragment', () => {
    expect(jsSdkUrl('https://www.goapply.top/campus?x=1#top')).toBe('https://www.goapply.top/campus?x=1');
    expect(jsSdkSignature('t', 'n', 1, 'https://a.test/p#frag')).toBe(jsSdkSignature('t', 'n', 1, 'https://a.test/p'));
  });

  it('nonceStr is 16 alphanumerics', () => {
    expect(nonceStr()).toMatch(/^[A-Za-z0-9]{16}$/);
  });
});

describe('XML subset', () => {
  it('reads CDATA and plain leaves and repeated List blocks', () => {
    const x = parseWechatXml(
      '<xml><ToUserName><![CDATA[gh_1]]></ToUserName><FromUserName><![CDATA[o_user]]></FromUserName><CreateTime>1610969440</CreateTime>' +
        '<MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe_msg_change_event]]></Event>' +
        '<SubscribeMsgChangeEvent><List><TemplateId><![CDATA[T1]]></TemplateId><SubscribeStatusString><![CDATA[reject]]></SubscribeStatusString></List>' +
        '<List><TemplateId><![CDATA[T2]]></TemplateId><SubscribeStatusString><![CDATA[accept]]></SubscribeStatusString></List></SubscribeMsgChangeEvent></xml>',
    );
    expect(x?.fields).toMatchObject({ ToUserName: 'gh_1', FromUserName: 'o_user', CreateTime: '1610969440', MsgType: 'event', Event: 'subscribe_msg_change_event' });
    expect(x?.lists).toEqual([
      { TemplateId: 'T1', SubscribeStatusString: 'reject' },
      { TemplateId: 'T2', SubscribeStatusString: 'accept' },
    ]);
  });

  it('decodes the five XML entities in plain text and keeps CDATA as is', () => {
    expect(parseWechatXml('<xml><A>a &amp; b &lt;c&gt;</A><B><![CDATA[&amp;]]></B></xml>')?.fields).toEqual({ A: 'a & b <c>', B: '&amp;' });
  });

  it('refuses DOCTYPE/ENTITY, a missing root and oversized bodies', () => {
    expect(parseWechatXml('<!DOCTYPE x [<!ENTITY e "boom">]><xml><A>&e;</A></xml>')).toBeNull();
    expect(parseWechatXml('<root><A>1</A></root>')).toBeNull();
    expect(parseWechatXml('')).toBeNull();
    expect(parseWechatXml(`<xml><A>${'a'.repeat(MAX_XML_BYTES)}</A></xml>`)).toBeNull();
  });
});

describe('config', () => {
  const base = { WECHAT_MP_APP_ID: 'wx_mp', WECHAT_MP_APP_SECRET: 's', WECHAT_MP_TOKEN: 't' };

  it('a template with no id, or a malformed one, is unset', () => {
    expect(templateConfig('deadline_reminder', base)).toBeNull();
    expect(templateConfig('deadline_reminder', { ...base, WECHAT_MP_TEMPLATE_DEADLINE: 'bad id!' })).toBeNull();
    expect(configuredTemplates(base)).toEqual([]);
  });

  it('a bare id uses the default keyword mapping', () => {
    expect(templateConfig('deadline_reminder', { WECHAT_MP_TEMPLATE_DEADLINE: 'Tpl_Deadline_01' })).toEqual({
      key: 'deadline_reminder',
      id: 'Tpl_Deadline_01',
      fields: { ...DEFAULT_TEMPLATE_FIELDS.deadline_reminder },
    });
  });

  it('reads an explicit mapping and refuses unknown sources or keywords', () => {
    expect(templateConfig('report_ready', { WECHAT_MP_TEMPLATE_REPORT: 'Tpl_Report_01|thing2:title, date5:completedAt' })?.fields).toEqual({
      thing2: 'title',
      date5: 'completedAt',
    });
    expect(templateConfig('report_ready', { WECHAT_MP_TEMPLATE_REPORT: 'Tpl_Report_01|thing2:score' })).toBeNull();
    expect(templateConfig('report_ready', { WECHAT_MP_TEMPLATE_REPORT: 'Tpl_Report_01|Thing:title' })).toBeNull();
  });

  it('maps template ids back to keys and reads the app and AES key', () => {
    const env = { ...base, WECHAT_MP_TEMPLATE_PAYMENT: 'Tpl_Pay_000001', WECHAT_MP_ENCODING_AES_KEY: AES_KEY };
    expect(templateKeyForId('Tpl_Pay_000001', env)).toBe('payment_success');
    expect(templateKeyForId('nope', env)).toBeNull();
    expect(mpApp(env)).toEqual({ appId: 'wx_mp', secret: 's' });
    expect(mpApp({ WECHAT_MP_APP_ID: 'x' })).toBeNull();
    expect(mpAesKey(env)).toBe(AES_KEY);
    expect(mpAesKey({ WECHAT_MP_ENCODING_AES_KEY: 'short' })).toBeNull();
  });
});

describe('keyword formatting', () => {
  const closes = new Date('2026-10-31T15:59:00.000Z'); // 23:59 Beijing

  it('formats time and date in Beijing time', () => {
    expect(wechatTime(closes)).toBe('2026年10月31日 23:59');
    expect(wechatDate(new Date('2026-10-31T16:30:00.000Z'))).toBe('2026年11月1日');
  });

  it('clips thing to 20 characters (by code point) and name to 10', () => {
    const long = '某某某科技有限公司2027届校园招聘管培生项目第二批';
    const v = formatKeyword('thing1', { kind: 'text', value: long })!;
    expect([...v]).toHaveLength(20);
    expect(v.endsWith('…')).toBe(true);
    expect([...formatKeyword('name3', { kind: 'text', value: long })!]).toHaveLength(10);
    expect(formatKeyword('thing1', { kind: 'text', value: '短名称' })).toBe('短名称');
  });

  it('amount in 元, character_string sanitized, phrase ≤ 5, number digits', () => {
    expect(formatKeyword('amount2', { kind: 'fen', value: 2990 })).toBe('29.90元');
    expect(formatKeyword('character_string4', { kind: 'text', value: 'GA-2026_10.01' })).toBe('GA-2026_10.01');
    expect(formatKeyword('character_string4', { kind: 'text', value: 'x'.repeat(40) })).toBeNull();
    expect(formatKeyword('phrase1', { kind: 'text', value: '已完成' })).toBe('已完成');
    expect(formatKeyword('phrase1', { kind: 'text', value: '已经全部完成了' })).toBeNull();
    expect(formatKeyword('number5', { kind: 'int', value: 3 })).toBe('3');
  });

  it('never fills a keyword from the wrong kind of value or from nothing', () => {
    expect(formatKeyword('time3', { kind: 'text', value: 'tomorrow' })).toBeNull();
    expect(formatKeyword('time3', { kind: 'time', value: new Date('nope') })).toBeNull();
    expect(formatKeyword('amount2', { kind: 'text', value: '29.9' })).toBeNull();
    expect(formatKeyword('thing1', undefined)).toBeNull();
  });

  it('templateData fills every mapped keyword or returns null (no placeholders)', () => {
    const cfg = templateConfig('deadline_reminder', { WECHAT_MP_TEMPLATE_DEADLINE: 'Tpl_Deadline_01' })!;
    expect(templateData(cfg, { company: '某公司', program: '2027届校园招聘', closesAt: closes.toISOString() })).toEqual({
      thing1: { value: '2027届校园招聘' },
      thing2: { value: '某公司' },
      time3: { value: '2026年10月31日 23:59' },
    });
    expect(templateData(cfg, { company: '某公司', closesAt: closes.toISOString() })).toBeNull();
    expect(templateData(cfg, { company: '某公司', program: 'x', closesAt: 'next week' })).toBeNull();
    const pay = templateConfig('payment_success', { WECHAT_MP_TEMPLATE_PAYMENT: 'Tpl_Pay_000001' })!;
    expect(templateData(pay, { planName: '7天通行证', amountFen: 1990, paidAt: closes.toISOString(), orderNo: 'GA20261031001' })).toEqual({
      thing1: { value: '7天通行证' },
      amount2: { value: '19.90元' },
      time3: { value: '2026年10月31日 23:59' },
      character_string4: { value: 'GA20261031001' },
    });
    // A template mapped to a source the producer does not send never goes out.
    const withDays = templateConfig('deadline_reminder', { WECHAT_MP_TEMPLATE_DEADLINE: 'Tpl_Deadline_01|thing1:program,number2:days' })!;
    expect(templateData(withDays, { company: 'c', program: 'p', closesAt: closes.toISOString() })).toBeNull();
    expect(templateData(withDays, { company: 'c', program: 'p', closesAt: closes.toISOString(), days: 1 })).toEqual({ thing1: { value: 'p' }, number2: { value: '1' } });
  });
});

describe('公众号 API client', () => {
  const app = { appId: 'wx_mp', secret: 'sec' };

  function fakeFetch(handlers: Array<(url: string, body: unknown) => unknown>) {
    const calls: Array<{ url: string; body: unknown }> = [];
    let i = 0;
    const fn: FetchFn = vi.fn(async (url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, body });
      const h = handlers[Math.min(i, handlers.length - 1)]!;
      i += 1;
      const out = h(url, body);
      if (out instanceof Error) throw out;
      return { ok: true, status: 200, text: async () => JSON.stringify(out) };
    });
    return { fn, calls };
  }

  it('caches the stable token until five minutes before expiry', async () => {
    let clock = 0;
    const f = fakeFetch([() => ({ access_token: 'AT1', expires_in: 7200 }), () => ({ access_token: 'AT2', expires_in: 7200 })]);
    const api = createWechatMpApi({ fetch: f.fn, now: () => clock });
    expect(await api.accessToken(app)).toBe('AT1');
    clock = 6_000_000;
    expect(await api.accessToken(app)).toBe('AT1');
    clock = 6_900_001;
    expect(await api.accessToken(app)).toBe('AT2');
    expect(f.calls[0]).toMatchObject({ url: 'https://api.weixin.qq.com/cgi-bin/stable_token', body: { grant_type: 'client_credential', appid: 'wx_mp', secret: 'sec' } });
  });

  it('fetches and caches the jsapi ticket', async () => {
    const f = fakeFetch([() => ({ access_token: 'AT', expires_in: 7200 }), () => ({ errcode: 0, ticket: 'TICKET', expires_in: 7200 })]);
    const api = createWechatMpApi({ fetch: f.fn, now: () => 0 });
    expect(await api.jsapiTicket(app)).toBe('TICKET');
    expect(await api.jsapiTicket(app)).toBe('TICKET');
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.url).toBe('https://api.weixin.qq.com/cgi-bin/ticket/getticket?access_token=AT&type=jsapi');
  });

  it('drops a token WeChat calls invalid, force-refreshes once and retries', async () => {
    const f = fakeFetch([
      () => ({ access_token: 'OLD', expires_in: 7200 }),
      () => ({ errcode: 40001, errmsg: 'invalid credential' }),
      () => ({ access_token: 'NEW', expires_in: 7200 }),
      () => ({ errcode: 0, errmsg: 'ok', msgid: 123 }),
    ]);
    const api = createWechatMpApi({ fetch: f.fn, now: () => 0 });
    const msgid = await api.sendSubscribeMessage(app, { touser: 'o1', template_id: 'T', data: { thing1: { value: 'x' } } });
    expect(msgid).toBe('123');
    expect(f.calls[2]!.body).toMatchObject({ force_refresh: true });
    expect(f.calls[3]!.url).toContain('/cgi-bin/message/subscribe/bizsend?access_token=NEW');
    expect(f.calls[3]!.body).toEqual({ touser: 'o1', template_id: 'T', data: { thing1: { value: 'x' } } });
  });

  it('surfaces WeChat errors and network failures as WechatMpApiError (transient only for network/busy)', async () => {
    const api = createWechatMpApi({ fetch: fakeFetch([() => ({ access_token: 'AT' }), () => ({ errcode: 43101, errmsg: 'user refuse' })]).fn, now: () => 0 });
    const err = await api.sendSubscribeMessage(app, { touser: 'o', template_id: 'T', data: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WechatMpApiError);
    expect((err as WechatMpApiError).errcode).toBe(43101);
    expect((err as WechatMpApiError).transient).toBe(false);

    const down = createWechatMpApi({ fetch: fakeFetch([() => new Error('ECONNRESET')]).fn });
    const e2 = await down.accessToken(app).catch((e: unknown) => e);
    expect((e2 as WechatMpApiError).errcode).toBe('network');
    expect((e2 as WechatMpApiError).transient).toBe(true);
  });
});
