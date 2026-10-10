// @vitest-environment node
// Mainland text rule (MARKET_STRATEGY §1.5, JC-7): recruiter phone numbers and
// WeChat ids are removed from an indexed posting's text; nothing else is.

import { describe, expect, it } from 'vitest';
import { postingText, stripContactInfo, withoutContactInfo } from '../text.js';

const strip = (s: string) => stripContactInfo(s).text;

describe('stripContactInfo: what is removed', () => {
  it.each([
    ['有意者请致电 13800138000 联系', '有意者请致电 联系'],
    ['联系电话：138-0013-8000', ''],
    ['手机 138 0013 8000', ''],
    ['电话:+86 13800138000', ''],
    ['电话：(86) 21 5555 0000 转 12', ''],
    ['简历投递后请致电 010-12345678 转 801 联系王经理', '简历投递后请致电 联系王经理'],
    ['座机（021）5555 0000', ''],
    ['客服热线 400-800-1234', ''],
    ['全角号码：１３８００１３８０００', '全角号码'],
    ['Tel: +86 138-0013-8000', ''],
    ['Tel: +86 21 5555 0000 ext 12', ''],
    ['电话：010-1234-5678 分机 801', ''],
    ['Phone No.: 13800138000', ''],
    ['Mobile number 138 0013 8000', ''],
    // A landline written in groups, with no label, after a word that says "ring this".
    ['简历投递后请致电 010-1234-5678 咨询', '简历投递后请致电 咨询'],
    ['Please call 021 5555 0000 for details', 'Please call for details'],
    // The area code in brackets is a phone number on its own.
    ['前台（021）5555 0000', '前台'],
  ])('phone: %s', (input, expected) => {
    expect(strip(input)).toBe(expected);
  });

  it.each([
    ['有意者请加微信 hr_zhang2026 详聊', '有意者 详聊'],
    ['微信号：abc12345', ''],
    ['微信号是 abc12345，欢迎咨询', '欢迎咨询'],
    ['VX：goodjob_hr', ''],
    ['wx:13912345678', ''],
    ['+V: zhaopin_888', ''],
    ['WeChat ID: recruiter_li', ''],
    ['联系电话：13800138000（微信同号）', ''],
    ['加v信 hr-li-2026 了解详情', '了解详情'],
    // After the Chinese word and a colon, an id of letters only is still an id when it stands alone.
    ['微信：zhangsan', ''],
    ['微信：zhangsanhr，备注岗位', '备注岗位'],
    ['加微信 zhangsan 详聊', '详聊'],
    ['WeChat: hr_zhang01', ''],
    ['wechat：zhaopin2026 (note your name)', '(note your name)'],
  ])('WeChat: %s', (input, expected) => {
    expect(strip(input)).toBe(expected);
  });

  it('several details on one line, and a contact block under its heading', () => {
    expect(strip('VX：goodjob_hr，电话:１３８ ００１３ ８０００')).toBe('');
    expect(strip('Contact: Tel: +86 138-0013-8000 / WeChat ID: recruiter_li')).toBe('');
    expect(strip('职位描述：负责后端开发\n\n联系方式：\n微信号：abc12345\n电话：(021) 5555 0000\n\n福利：五险一金')).toBe('职位描述：负责后端开发\n\n福利：五险一金');
    expect(stripContactInfo('联系电话：13800138000，微信同号').removed).toBe(2);
  });

  it('HTML: only the detail is removed, the markup stays', () => {
    expect(stripContactInfo('<p>职责：后端开发</p><p>联系电话：13800138000（微信同号）</p>', { html: true }).text).toBe('<p>职责：后端开发</p><p></p>');
    expect(stripContactInfo('<a href="tel:13800138000">Call</a>', { html: true }).text).toBe('<a href="">Call</a>');
    expect(stripContactInfo("<a class='x' href='tel:+86-138-0013-8000'>13800138000</a>", { html: true })).toEqual({ text: "<a class='x' href=''></a>", removed: 2 });
    expect(stripContactInfo('<a href=tel:13800138000>Call</a>', { html: true }).text).toBe('<a href=>Call</a>');
    // However long the tag is.
    const long = `<a data-x="${'x'.repeat(5000)}" href="tel:13800138000">Call</a>`;
    expect(stripContactInfo(long, { html: true }).text).toBe(long.replace('tel:13800138000', ''));
  });

  // Board postings are HTML, and the usual shape is a label in one tag and the value outside it.
  // The details are read in the text a reader sees, so a tag or an entity between the two changes nothing.
  it.each([
    ['<p><strong>微信：</strong>hr_zhang01</p>', '<p><strong></strong></p>', 'hr_zhang01'],
    ['<li>加微信&nbsp;<b>hr_zhang01</b></li>', '<li><b></b></li>', 'hr_zhang01'],
    ['<p>微信：&nbsp;hr_zhang01</p>', '<p></p>', 'hr_zhang01'],
    ['<p>Tel:&nbsp;400-820-8820</p>', '<p></p>', '400-820-8820'],
    ['<p><b>联系电话</b><span>：</span><span>138</span><span>0013</span><span>8000</span></p>', '<p><b></b><span></span><span></span><span></span><span></span></p>', '8000'],
    ['<p>电话&#65306;&#49;&#51;800138000</p>', '<p></p>', '800138000'],
    ['<p>微信号\n  hr_zhang01</p>', '<p></p>', 'hr_zhang01'],
    ['<p>手机 138<!-- x -->0013<!-- y -->8000</p>', '<p><!-- x --><!-- y --></p>', '8000'],
  ])('HTML, label and value in different nodes: %s', (html, expected, detail) => {
    const res = stripContactInfo(html, { html: true });
    expect(res.text).toBe(expected);
    expect(res.removed).toBeGreaterThan(0);
    expect(res.text).not.toContain(detail);
    // And through the column rule: neither stored column shows the detail.
    const { changed } = withoutContactInfo({ description: `<p>职责：后端开发</p>${html}`, descriptionPlain: `职责：后端开发\n${html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')}` });
    expect(changed.description).toContain('职责：后端开发');
    expect(changed.description).not.toContain(detail);
    expect(changed.descriptionPlain ?? '').not.toContain(detail);
  });

  it('HTML: nothing inside a tag is text (a path, an image, an attribute are never edited)', () => {
    for (const html of [
      '<p>职责</p><img src="/img/13912345678.png" alt="x">',
      '<a href="https://careers.example.cn/jobs/13800138000" data-id="010-12345678">申请</a>',
      `<img src="data:image/png;base64,${'QUJD13800138000'.repeat(50)}">`,
      '<p data-wechat="wx:hr_zhang01">熟悉微信小程序</p>',
      '<script>var tel = "13800138000";</script><p>岗位职责</p>',
    ]) {
      expect(stripContactInfo(html, { html: true }), html).toEqual({ text: html, removed: 0 });
    }
  });

  it('is idempotent', () => {
    const once = strip('联系方式：电话 13800138000，微信 hr_zhang01，邮箱 hr@example.cn\n职责：开发');
    expect(strip(once)).toBe(once);
    expect(stripContactInfo(once).removed).toBe(0);
    // Also when taking one detail out puts the halves of another side by side.
    for (const html of [false, true]) {
      const joined = stripContactInfo('1380013（微信同号）8000', { html });
      expect(joined).toEqual({ text: '', removed: 2 });
    }
  });
});

describe('stripContactInfo: what is never touched', () => {
  it.each([
    '薪资 13000-18000元/月，13薪',
    '月薪 15000 元，2026 届毕业生，招聘 135 人',
    '订单号 12345678901234567，统一社会信用代码 91310000MA1FL5XY2B',
    '熟悉微信小程序开发，了解微信 SDK 与 JavaScript',
    '添加微信公众号「示例招聘」了解更多',
    '熟悉微信支付、微信开放平台 OpenAPI 接入',
    '支持 C++ v2 release12345，了解 wxPython: toolkit123',
    'mobile 100000000 users; phone screen 30 minutes; telemetry 20261011',
    '工作时间 9:00-18:00，网申截止 2026-11-30，电话面试 2 轮',
    '简历请发送至 hr@example.cn，邮件标题注明“姓名+岗位”',
    '简历请发送至 13800138000@example.cn',
    'https://careers.example.cn/jobs/13800138000-backend',
    '投递链接：https://careers.example.cn/apply?ref=wx:abc12345&tel=01012345678 （复制到浏览器打开）',
    'We are a 400-person team with 8000+ customers',
    // "WeChat" as a channel or a product, followed by ordinary words.
    'Familiar with social platforms (WeChat: official accounts, mini programs)',
    'Channels: WeChat: Moments ads, Douyin',
    'Experience with WeChat: Moments, Channels and Official Accounts',
    'WeChat: e-commerce and mini-program operations',
    'wechat id: OpenID mapping',
    'WeChat: OAuth2 login and WeChat Pay',
    '官方微信公众号：ExampleCareers',
    '请添加微信 Official Account 了解更多',
    '微信号 OpenID mapping 的实现',
    // A number an id label names is not a phone number; a grouped number with no label is not one either.
    '岗位编号：010-2026-0001',
    '岗位编号：010-20260001',
    'Requisition ID: 0755-1234-5678',
    'Requisition ID: 0755-12345678',
    'Job No. 13912345678',
    'Ref: 13912345678',
    '工号 13912345678',
    '批次 010-2026-0001，招聘 20 人',
    // Not an id label: "paid", "valid" end in "id".
    'Tel 400-person hotline staffed 9-18',
    // An amount is not a number to ring.
    '注册资本 13800000000 元，年营收 15900000000元',
    '工作地点：上海市浦东新区张江路 1388 号 021 室',
  ])('%s', (input) => {
    expect(stripContactInfo(input)).toEqual({ text: input, removed: 0 });
  });

  it('a line without a detail keeps its exact spacing even when another line is cleaned', () => {
    const input = '岗位职责：\n  1.  负责  后端开发；\n  2.  电话：13800138000\n任职要求：本科';
    expect(strip(input)).toBe('岗位职责：\n  1.  负责  后端开发；\n  2.\n任职要求：本科');
  });

  it('a word that ends like an id label does not shield a number', () => {
    expect(strip('Prepaid 13800138000 plans')).toBe('Prepaid plans');
    expect(strip('联系 13800138000')).toBe('');
  });

  it('empty input', () => {
    expect(stripContactInfo('')).toEqual({ text: '', removed: 0 });
  });
});

describe('withoutContactInfo', () => {
  it('returns only the columns that changed', () => {
    const job = { title: '销售 13800138000', description: '<p>电话：13800138000</p>', descriptionPlain: '电话：13800138000', qualifications: '本科及以上', responsibilities: null, benefits: '加微信 hr_zhang01 领取内推码' };
    const { changed, removed } = withoutContactInfo(job);
    expect(changed).toEqual({ description: '<p></p>', descriptionPlain: '', benefits: '领取内推码' });
    expect(removed).toBe(3);
    // The title is not a text column of this rule.
    expect(changed).not.toHaveProperty('title');
    expect(withoutContactInfo({ description: '职责：开发', descriptionPlain: '职责：开发' })).toEqual({ changed: {}, removed: 0 });
  });
});

describe('withoutContactInfo: markup is checked again as a reader sees it', () => {
  it('a description that is markup keeps its markup, and is plain text only when the markup would still show a detail', () => {
    const kept = withoutContactInfo({ description: '<ul><li>负责后端开发</li><li>联系电话：<b>13800138000</b></li></ul>' });
    expect(kept.changed.description).toBe('<ul><li>负责后端开发</li><li><b></b></li></ul>');
    expect(kept.removed).toBe(1);
    // Every digit in its own tag: the markup pass sees "1 3 8 …", which is no number. Nothing is removed and nothing is invented.
    const spaced = withoutContactInfo({ description: '<p>电话</p><p><i>1</i><i>3</i><i>8</i></p>' });
    expect(spaced).toEqual({ changed: {}, removed: 0 });
  });
});

describe('time: proportional to the length of the posting', () => {
  const SIZE = 500 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
  const timed = (fn: () => unknown): number => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };
  const base64 = fill('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0123456789+/');

  // Each of these took seconds to minutes with the first patterns (100 KB of base64: 5 s; "电话" and 100 KB of blanks: 18 s).
  it.each([
    ['an inline image in markup', `<p>联系电话：13800138000</p><img src="data:image/png;base64,${base64}"><p>职责</p>`],
    ['a long unbroken run in plain text', `联系电话：13800138000\n${base64}\n职责`],
    ['a phone label and a long run of blanks', `电话${fill(' ')}13800138000`],
    ['a long run of blanks on a line that is cleaned', `电话：13800138000${fill(' ')}x`],
    ['full-width blanks', `微信${fill('\u3000')}：hr_zhang01`],
    ['unclosed tags', `<p>电话：13800138000</p>${fill('<a ')}`],
    ['unclosed scripts', `<p>电话：13800138000</p>${fill('<script>')}`],
    ['many labels', fill('电话 微信： +v: wx ')],
    ['many digits', fill('1380013800 ')],
    ['many at signs', fill('a.b@c ')],
  ])('%s (500 KB) is read in milliseconds', (_name, text) => {
    // Measured: 3 to 17 ms, 3 to 20 ms, 1 to 57 ms, 0 to 5 ms. The limits leave room for a busy machine.
    expect(timed(() => stripContactInfo(text))).toBeLessThan(250);
    expect(timed(() => stripContactInfo(text, { html: true }))).toBeLessThan(250);
    expect(timed(() => withoutContactInfo({ description: text, descriptionPlain: text }))).toBeLessThan(600);
    expect(timed(() => postingText({ title: 't', description: text }))).toBeLessThan(250);
  });

  it('and the detail is still removed from such a posting', () => {
    const { changed, removed } = withoutContactInfo({ description: `<p>联系电话：13800138000</p><img src="data:image/png;base64,${base64}"><p>职责</p>` });
    expect(removed).toBe(1);
    expect(changed.description).toBe(`<p></p><img src="data:image/png;base64,${base64}"><p>职责</p>`);
  });
});

describe('postingText', () => {
  it('reads the description as the posting wrote it (tags removed, entities decoded), else the plain copy', () => {
    const text = postingText({ title: '后端工程师', description: '<p>网申截止时间：2026年11月30日。</p><ul><li>本科及以上 &amp; 3 年经验&#65292;熟悉 Go</li></ul>', descriptionPlain: '网申截止时间:2026年11月30日。' });
    expect(text.split('\n').map((l) => l.trim()).filter(Boolean)).toEqual(['后端工程师', '网申截止时间：2026年11月30日。', '本科及以上 & 3 年经验，熟悉 Go']);
    expect(postingText({ title: '后端工程师', description: '', descriptionPlain: '负责后端开发。' })).toBe('后端工程师\n负责后端开发。');
    expect(postingText({ title: '后端工程师', descriptionPlain: '负责后端开发。', qualifications: '本科及以上', benefits: '负责后端开发。' })).toBe('后端工程师\n负责后端开发。\n本科及以上');
  });
});
