// Fixtures for the GoApply AI-interview format (WP-66): a zh transcript as the
// interview engine stores it (with speech-to-text punctuation and fillers),
// the same practice as the text practice stores it, and the expected checks.
// Written for these tests; not a real candidate's answers.

export const ZH_ENGINE_TRANSCRIPT = [
  { role: 'system', text: 'session started', ts: 0 },
  { role: 'interviewer', text: '你好，欢迎参加本次模拟面试。请用两分钟做一个自我介绍。', ts: 1 },
  { role: 'candidate', text: '嗯，面试官好，我叫小林，是计算机专业的大四学生。', ts: 2 },
  { role: 'candidate', text: '那个，我在一家互联网公司做过三个月的产品实习。', ts: 3 },
  { role: 'candidate', text: '我做', ts: 3, interim: true },
  { role: 'interviewer', text: '请讲一次你在团队中和他人合作完成一项任务的经历。你在其中承担了什么角色？', ts: 4 },
  {
    role: 'candidate',
    text:
      '当时我在学校的创业比赛团队里，我们的目标是在两周内做出一个校园二手交易的小程序。' +
      '我负责前端和进度安排。我首先把功能拆成十个小任务，然后我每天晚上和大家同步进度。' +
      '结果我们按时上线，用户在第一周就超过了三百人，最后拿到了比赛二等奖。',
    ts: 5,
  },
  { role: 'interviewer', text: '请讲一次你没有达到预期目标的经历。你从中学到了什么？', ts: 6 },
  { role: 'candidate', text: '呃，就是，有一次我在社团里组织活动，就是说，嗯，报名的人很少，就是，然后，那个那个……', ts: 7 },
  { role: 'interviewer', text: '结果呢？', ts: 8 },
  { role: 'candidate', text: '最后活动取消了，我学到了要提前做宣传。', ts: 9 },
  { role: 'interviewer', text: '一家奶茶店最近一个月销量下降了两成，你会从哪些方面分析原因？', ts: 10 },
  { role: 'candidate', text: '我会从三个方面看：价格、竞争对手和天气。啊，先看价格有没有变化，对吧。', ts: 11 },
];

/** The same practice in the text-practice shape ({ who, text }). */
export const ZH_TEXT_TRANSCRIPT = ZH_ENGINE_TRANSCRIPT.filter((t) => t.role !== 'system' && !t.interim).map((t) => ({
  who: t.role === 'candidate' ? 'you' : 'them',
  text: t.text,
}));

/** The rich report's canonical breakdown for this practice. */
export const ZH_BREAKDOWN = [
  { key: 'structure', value: 70, note: '' },
  { key: 'specificity', value: 60, note: '' },
  { key: 'communication', value: 64, note: '' },
  { key: 'confidence', value: 58, note: '' },
  { key: 'roleFit', value: 66, note: '' },
];

/**
 * What the checks find, by hand:
 *   answer 0 (self-intro, two turns merged; interim dropped): 嗯 ×1, 那个 ×1 (before a comma);
 *   answer 1 (teamwork story): S 当时/在…团队, T 目标/负责, A 我首先, R 结果/按时/三百人 → 4 parts, 然后我 is not a filler;
 *   answer 2 (failure story + the "结果呢？" follow-up folded in): 呃, 就是 ×2, 就是说, 嗯, 然后, 那个 ×2 → 8 fillers;
 *            S 有一次/在社团, R 最后/学到 (from the follow-up), no task cue, no action cue → 2 parts, missing task + action;
 *   answer 3 (logic, not a story): 啊 ×1, 对吧 ×1.
 */
export const ZH_EXPECTED = {
  answers: 4,
  fillersPerAnswer: [2, 0, 8, 2],
  fillerTotal: 12,
  stars: [null, 4, 2, null],
  missing: [null, [], ['task', 'action'], null],
  storyAnswers: 2,
  complete: 1,
  missingMost: 'task',
  /** round(mean(64, 58)) */
  communication: 61,
  /** round(mean(70, 60)) */
  logic: 65,
  /** round(100 × (4 + 2) / 8) */
  behaviour: 75,
} as const;
