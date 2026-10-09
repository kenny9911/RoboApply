import assert from 'node:assert/strict';
import { test } from 'node:test';
import { charLength, planOpening, splitSentences, GREETING_MAX_CHARS, GREETING_MAX_CHARS_CJK } from '../dist/opening.js';

const LONG_Q_EN = 'Imagine you are designing a rate limiter for a multi-region API gateway that serves 50,000 requests per second; walk me through the data structures, the consistency trade-offs between regions, and how you would test it under failure.';
const LONG_Q_ZH = '假设你需要为一个每秒处理五万次请求的多区域API网关设计限流器，请你详细说明所用的数据结构、跨区域的一致性取舍、故障情况下的降级策略，以及你会如何在生产环境中验证和监控它的正确性。';

test('new split fields are used verbatim', () => {
  const plan = planOpening({ openingGreeting: 'Hi Kenny, I am Alex.', openingQuestion: 'Tell me about yourself.', openingLine: 'ignored' });
  assert.deepEqual(plan, { greeting: 'Hi Kenny, I am Alex.', question: 'Tell me about yourself.', source: 'split-fields' });
});

test('legacy en line splits at "Let\'s dive in." and keeps the greeting within budget', () => {
  const line = `Hi Kenny, I'm Alex. Thanks for joining today. I'll be running your interview for the Senior Platform Reliability Engineer role, and it should take about 30 minutes. Let's dive in. ${LONG_Q_EN}`;
  const plan = planOpening({ language: 'en', openingLine: line });
  assert.equal(plan.source, 'legacy-marker');
  assert.equal(plan.question, LONG_Q_EN);
  assert.ok(charLength(plan.greeting) <= GREETING_MAX_CHARS, plan.greeting);
  assert.ok(plan.greeting.startsWith("Hi Kenny, I'm Alex."));
  assert.ok(plan.greeting.endsWith("Let's dive in."));
  assert.ok(!plan.greeting.includes('rate limiter'));
});

test('legacy zh line splits at 我们开始吧 and counts characters for the CJK budget', () => {
  const line = `Kenny，你好，我是李明。感谢你参加今天的面试。我将担任你这次高级后端工程师岗位面试的面试官，大约需要30分钟。我们开始吧。${LONG_Q_ZH}`;
  const plan = planOpening({ language: 'zh-CN', openingLine: line });
  assert.equal(plan.source, 'legacy-marker');
  assert.equal(plan.question, LONG_Q_ZH);
  assert.ok(charLength(plan.greeting) <= GREETING_MAX_CHARS_CJK, plan.greeting);
  assert.ok(plan.greeting.startsWith('Kenny，你好，我是李明。'));
  assert.ok(plan.greeting.endsWith('我们开始吧。'));
});

test('legacy ja and zh-TW markers split too', () => {
  const ja = planOpening({ language: 'ja', openingLine: 'こんにちは。佐藤と申します。本日は面接にご参加いただきありがとうございます。それでは始めましょう。まず、ご自身の経歴について簡単に教えてください。' });
  assert.equal(ja.question, 'まず、ご自身の経歴について簡単に教えてください。');
  assert.ok(ja.greeting.endsWith('それでは始めましょう。'));
  const tw = planOpening({ language: 'zh-TW', openingLine: '你好，我是王小明。感謝你參加今天的面試。我們開始吧。首先，請你簡單介紹一下你自己和你的背景。' });
  assert.equal(tw.question, '首先，請你簡單介紹一下你自己和你的背景。');
});

test('a short legacy line without a marker is spoken whole as the greeting', () => {
  const plan = planOpening({ language: 'en', openingLine: 'Hello! Tell me about yourself.' });
  assert.deepEqual(plan, { greeting: 'Hello! Tell me about yourself.', question: null, source: 'legacy-short' });
});

test('a long unknown line splits at a sentence boundary; one giant sentence becomes an interruptible opening', () => {
  const plan = planOpening({ language: 'en', openingLine: `Welcome aboard. ${LONG_Q_EN}` });
  assert.equal(plan.source, 'legacy-sentences');
  assert.equal(plan.greeting, 'Welcome aboard.');
  assert.equal(plan.question, LONG_Q_EN);
  const giant = planOpening({ language: 'en', openingLine: LONG_Q_EN });
  assert.equal(giant.greeting, '');
  assert.equal(giant.question, LONG_Q_EN);
});

test('no opening at all → LLM greeting', () => {
  assert.deepEqual(planOpening({}), { greeting: '', question: null, source: 'none' });
});

test('sentence splitter handles latin and full-width terminators', () => {
  assert.deepEqual(splitSentences('Hi there. Version 2.5 works! Ok?'), ['Hi there.', 'Version 2.5 works!', 'Ok?']);
  assert.deepEqual(splitSentences('你好。我是李明！开始吧'), ['你好。', '我是李明！', '开始吧']);
});
