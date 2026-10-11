// @vitest-environment node
//
// What is embedded for a person (MKT-2H item 4): intent and resume text, the PII strip, hash stability.

import { describe, expect, it } from 'vitest';
import { RESUME_TEXT_MAX_CHARS, intentText, isSensitiveLine, redactResumeText, resumeText, sourceHash, type IntentInput } from './userText.js';

const intent: IntentInput = {
  targetTitles: ['Backend Engineer', 'Platform Engineer'],
  targetTaxonomyIds: ['backend_engineer'],
  targetSeniority: ['senior', 'lead_staff'],
  skills: ['Go', 'PostgreSQL', 'Kubernetes'],
  industries: ['Fintech', 'Climate'],
  goal: 'more_senior',
};

// SYNTHETIC resume: the person, the contact details and the employer are made up.
const parsed = {
  candidateName: 'Ada Lovelace',
  contact: { email: 'ada@example.com', phone: '+49 151 2345 6789', address: '12 Example Street, Berlin' },
  summary: 'Backend engineer with eight years in payments. Reach me at ada@example.com or +49 151 2345 6789.',
  education: [{ degree: 'MSc Computer Science', institution: 'Tsinghua University', period: '2012-2014' }],
  experience: [
    { title: 'Senior Software Engineer', company: 'PayCo', period: '2019 – present', highlights: ['Built payment APIs in Go serving 2M users.', 'Led the ledger migration with Ada Lovelace as tech lead.'] },
    { title: 'Software Engineer', company: 'ShopCo', period: '2015 – 2019', highlights: ['Wrote the checkout service.'] },
    { title: 'Intern', company: 'OldCo', period: '2014', highlights: ['Fixed bugs.'] },
  ],
  skills: [{ category: 'Languages', skills: ['Go', 'TypeScript'] }, { category: 'Data', skills: ['PostgreSQL'] }],
};

describe('intentText', () => {
  it('is the target titles, role labels in both scripts, level, top skills, industries and the goal', () => {
    expect(intentText(intent).split('\n')).toEqual([
      'Backend Engineer, Platform Engineer',
      'Backend engineer / 后端开发工程师',
      'senior, lead staff',
      'Go, PostgreSQL, Kubernetes',
      'Fintech, Climate',
      'more senior',
    ]);
  });

  it('exists before any resume, and is empty when the person has stated nothing to search by', () => {
    expect(intentText({ ...intent, skills: [], targetSeniority: [], industries: [], goal: null })).toBe('Backend Engineer, Platform Engineer\nBackend engineer / 后端开发工程师');
    expect(intentText({ targetTitles: [], targetTaxonomyIds: [], targetSeniority: ['senior'], skills: ['Go'], industries: [], goal: null })).toBe('');
  });
});

describe('resumeText', () => {
  const text = resumeText({ parsedData: parsed }, { names: ['Ada', 'Lovelace', 'Ada Lovelace'], strip: redactResumeText });

  it('is the last two titles with their bullets, the skills and the summary', () => {
    expect(text).toContain('Senior Software Engineer');
    expect(text).toContain('- Built payment APIs in Go serving 2M users.');
    expect(text).toContain('Software Engineer\n- Wrote the checkout service.');
    expect(text).toContain('Go, TypeScript, PostgreSQL');
    expect(text).toContain('Backend engineer with eight years in payments.');
    // Only the last two jobs.
    expect(text).not.toContain('Intern');
    expect(text).not.toContain('Fixed bugs');
  });

  it('holds no name, e-mail address or phone number of the person', () => {
    expect(text).not.toMatch(/Ada|Lovelace/);
    expect(text).not.toContain('ada@example.com');
    expect(text).not.toMatch(/\+49|2345|6789/);
    expect(text).not.toContain('[removed]');
  });

  it('never reads the school, the contact block or the employer names', () => {
    expect(text).not.toMatch(/Tsinghua|MSc/);
    expect(text).not.toMatch(/Example Street|Berlin/);
    expect(text).not.toMatch(/PayCo|ShopCo/);
  });

  it('passes the text through the strip it is given, with the names', () => {
    const seen: Array<{ text: string; names: unknown[] }> = [];
    const out = resumeText({ parsedData: parsed }, { names: ['Ada'], strip: (t, o) => (seen.push({ text: t, names: o.names }), 'STRIPPED') });
    expect(out).toBe('STRIPPED');
    expect(seen[0]!.names).toEqual(['Ada', 'Ada Lovelace']);
    expect(seen[0]!.text).toContain('Senior Software Engineer');
  });

  it('the fallback strip is safe on its own: a line with a sensitive field is dropped whole, and links are removed', () => {
    // SYNTHETIC: what a person may type into a bullet or a summary.
    const typed = {
      experience: [
        {
          title: '后端工程师',
          highlights: ['性别：男 | 出生年月：1995.03 | 政治面貌：中共党员 | 籍贯：湖南长沙', '负责支付系统的设计与开发', '民族：汉 婚姻状况：已婚', '主页 https://github.com/zhang-example 与 linkedin.com/in/zhang-example'],
        },
      ],
      skills: ['Go', 'Kubernetes'],
      summary: 'Gender: Male. Date of birth: 1995-03-02. Marital status: married.',
    };
    const out = resumeText({ parsedData: typed }, { names: [], strip: redactResumeText });
    expect(out).toBe('后端工程师\n- 负责支付系统的设计与开发\n- 主页 与\nGo, Kubernetes');
    expect(out).not.toMatch(/性别|男|出生|1995|政治面貌|中共党员|籍贯|湖南|民族|婚姻|已婚/);
    expect(out).not.toMatch(/Gender|Male|birth|Marital|married/i);
    expect(out).not.toMatch(/github|linkedin|https?:/i);
  });

  it('pins the sensitive-field labels (the scorer\'s list in features/match/pii.ts, en, zh and zh-TW)', () => {
    const latin = ['gender', 'sex', 'date of birth', 'birthdate', 'birth date', 'dob', 'age', 'marital status', 'nationality', 'religion', 'ethnicity', 'race', 'photo', 'address', 'home address'];
    for (const label of latin) {
      expect(isSensitiveLine(`${label}: x`), label).toBe(true);
      expect(isSensitiveLine(`- ${label.toUpperCase()} ： x`), label).toBe(true);
    }
    const cjk = ['性别', '性別', '出生', '出生年月', '生日', '年龄', '年齡', '籍贯', '籍貫', '政治面貌', '民族', '婚姻', '婚姻状况', '婚否', '宗教', '宗教信仰', '照片', '家庭成员', '家庭成員', '住址', '家庭住址', '地址', '身份证', '身份证号', '身分證'];
    for (const label of cjk) expect(isSensitiveLine(`${label}：某值`), label).toBe(true);
    // Ordinary resume lines are kept.
    for (const line of ['Built payment APIs in Go serving 2M users.', 'Manage: a team of five', 'Stage: growth', '负责支付系统的设计与开发', 'Led the storage team; reduced p99 latency by 40%']) {
      expect(isSensitiveLine(line), line).toBe(false);
    }
  });

  it('removes links with a scheme, www and the profile sites written without one; a tech name with a dot stays', () => {
    const strip = (t: string) => redactResumeText(t, { names: [] });
    expect(strip('See https://example.com/me and www.example.org/x')).not.toMatch(/example\.(com|org)/);
    for (const link of ['linkedin.com/in/ada-example', 'cn.linkedin.com/in/ada', 'github.com/ada-example', 'ada-example.github.io', 'gitee.com/ada', 'blog.csdn.net/ada', 'zhihu.com/people/ada']) {
      expect(strip(`Profile: ${link}, more`), link).not.toContain(link);
    }
    expect(strip('Node.js, ASP.NET Core, socket.io and Vue.js')).toBe('Node.js, ASP.NET Core, socket.io and Vue.js');
  });

  // M2 gate (match-retrieval): this strip is the one in force for `user.embed`. On GoApply a WeChat id in a
  // 自我评价 line is the usual way to leave a contact; it went to the embeddings provider with the rest.
  it('removes a chat handle after its label, and leaves the same words alone when no handle follows', () => {
    const strip = (t: string) => redactResumeText(t, { names: ['Ada', 'Lovelace', 'Ada Lovelace'] });
    const zh = strip('- 负责后端开发，联系我 微信 wxm_dev2020 或 QQ 123456789');
    expect(zh).not.toMatch(/wxm_dev2020|123456789/);
    expect(zh).toContain('负责后端开发');
    const en = strip('- reach me on WeChat: coder_x99, Telegram @coderx');
    expect(en).not.toMatch(/coder_x99|coderx/);
    for (const line of ['微信号：abc12345', '微信号 abcdefg', 'VX：ada_2020', 'WeChat ID wxid_9k2', 'QQ号 88886666', 'Skype: ada.example', 'WhatsApp: +491512345678x', 'LINE ID: ada_l99', 'weixin：ada-dev']) {
      const out = strip(`- 联系 ${line} 谢谢`);
      expect(out, line).toMatch(/联系 .*谢谢/);
      expect(out, line).not.toMatch(/abc12345|abcdefg|ada_2020|wxid_9k2|88886666|ada\.example|1512345678|ada_l99|ada-dev/);
    }
    // Ordinary resume text that names the same products stays word for word.
    for (const line of [
      '- Built WeChat mini programs and WeChat Pay v3 integrations',
      '- 负责微信小程序与微信支付的开发',
      '- 运营 QQ 音乐活动，管理 QQ 群',
      '- Wrote Telegram bots and a WhatsApp Business API client',
      '- Owned the product line items and the Skype for Business rollout',
      '- Maintained the WeChat identity service',
      'Node.js, ASP.NET Core, socket.io and Vue.js',
    ]) {
      expect(strip(line), line).toBe(line);
    }
  });

  it('removes a personal page written without a scheme: on a shared host, after a label, or spelling the person\'s name', () => {
    const strip = (t: string) => redactResumeText(t, { names: ['Ada', 'Lovelace', 'Ada Lovelace'] });
    const out = strip('- Site: adalovelace.dev and ada-portfolio.vercel.app');
    expect(out).not.toMatch(/adalovelace|portfolio|vercel|\.dev|\.app/);
    expect(strip('- 个人主页：coder.example.cn/about 欢迎访问')).not.toMatch(/coder|example\.cn/);
    expect(strip('- Notes at lovelace-notes.xyz/posts')).not.toMatch(/lovelace|notes\.xyz/);
    expect(strip('- Demo on my-demo.pages.dev')).not.toContain('pages.dev');
    // A host that is not the person's stays (an employer, a product).
    expect(strip('- Scaled booking.example.com checkout')).toContain('booking.example.com');
  });

  it('removes what is left glued to a removed name: the domain of an address, the rest of a host', () => {
    const strip = (t: string) => redactResumeText(t, { names: ['Ada', 'Lovelace', 'Ada Lovelace'] });
    expect(strip('- Email ada@example.com for details')).not.toMatch(/example\.com|@/);
    expect(strip('- Mail ada.lovelace@mail.example.org')).not.toMatch(/example\.org|@/);
    // A removed name at the end of a sentence takes nothing else with it.
    expect(strip('- Mentored by Ada. Then led the team')).toContain('Then led the team');
  });

  it('is empty for a resume with no parsed data, and for one with nothing to read', () => {
    expect(resumeText({ parsedData: null }, { names: [], strip: redactResumeText })).toBe('');
    expect(resumeText({ parsedData: 'markdown only' }, { names: [], strip: redactResumeText })).toBe('');
    expect(resumeText({ parsedData: { candidateName: 'Ada Lovelace', education: parsed.education } }, { names: [], strip: redactResumeText })).toBe('');
  });

  it('reads the other shapes a parsed resume comes in', () => {
    const other = { experience: [{ role: 'Data Analyst', bullets: ['Built dashboards.'] }], skills: ['SQL', 'Python'], objective: 'Looking for analytics work.' };
    expect(resumeText({ parsedData: other }, { names: [], strip: redactResumeText })).toBe('Data Analyst\n- Built dashboards.\nSQL, Python\nLooking for analytics work.');
  });

  it('is capped', () => {
    const long = { experience: [{ title: 'Engineer', highlights: Array.from({ length: 200 }, (_, i) => `Did thing number ${i} for the team.`) }] };
    expect(resumeText({ parsedData: long }, { names: [], strip: redactResumeText }).length).toBeLessThanOrEqual(RESUME_TEXT_MAX_CHARS);
  });
});

describe('sourceHash', () => {
  it('is stable for the same text and model, and moves with either', () => {
    const tag = 'openai/text-embedding-3-small@1024';
    const a = sourceHash(intentText(intent), tag);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(sourceHash(intentText({ ...intent }), tag)).toBe(a);
    expect(sourceHash(intentText({ ...intent, goal: 'management' }), tag)).not.toBe(a);
    expect(sourceHash(intentText(intent), 'text-embedding-v4@1024')).not.toBe(a);
  });
});
