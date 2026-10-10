// @vitest-environment node
// FIX-3 — the keyword check is not literal any more: obvious equivalents count
// (and say what counted), each thing is listed once, and terms are written in
// their usual spelling.
import { describe, expect, it } from 'vitest';

import { buildKeywordRows } from './keywordRows.js';
import { jobSkillList, normalizeText, shownVia, skillsDimension, splitSkills, userShows } from './preScore.js';
import { DEFAULT_MATCH_WEIGHTS } from './contract.js';
import { dedupeTerms, displayTerm, showingTerms, termKey, termParts, titleShows } from './terms.js';
import { matchJob, matchUser } from './testkit.js';

// The resume from the report: REST APIs, PostgreSQL, AWS, system design.
const RESUME = [
  'Senior Software Engineer, Hex (2019 – present)',
  '- Led the rewrite of the ingestion service in TypeScript and Node.js.',
  '- Designed REST APIs used by 40 partner teams; system design reviews.',
  'Skills: TypeScript, Node.js, PostgreSQL, AWS, REST APIs, system design',
].join('\n');
const user = matchUser({
  skills: ['TypeScript', 'Node.js', 'PostgreSQL', 'AWS', 'REST APIs', 'System design'],
  resumeTextNorm: normalizeText(RESUME),
  recentTitle: 'Senior Software Engineer',
});

describe('obvious equivalents count as present, and say what counted', () => {
  it.each([
    ['cloud infrastructure', 'AWS'],
    ['relational databases', 'PostgreSQL'],
    ['api design', 'REST API'],
    ['SQL', 'PostgreSQL'],
    ['software engineering', 'Senior Software Engineer'],
  ])('%s is shown (via %s)', (term, via) => {
    expect(shownVia(user, term)).toEqual({ shown: true, via });
    expect(userShows(user, term)).toBe(true);
  });

  it('a term the resume names itself has no "via"; singular and plural are one term', () => {
    expect(shownVia(user, 'PostgreSQL')).toEqual({ shown: true, via: null });
    expect(shownVia(user, 'REST API')).toEqual({ shown: true, via: null }); // the resume says "REST APIs"
    expect(shownVia(user, 'systems design')).toEqual({ shown: true, via: null }); // "system design" on the resume
    expect(termKey('REST APIs')).toBe(termKey('rest api'));
    expect(termKey('Relational Databases')).toBe(termKey('relational database'));
    expect(termKey('Node.js')).toBe(termKey('nodejs'));
  });

  it('only specific → general: a broad phrase on the resume never shows a named technology', () => {
    const broad = matchUser({ skills: ['Cloud infrastructure', 'Relational databases'], resumeTextNorm: normalizeText('Worked with cloud infrastructure and relational databases.'), recentTitle: 'Analyst' });
    expect(userShows(broad, 'AWS')).toBe(false);
    expect(userShows(broad, 'PostgreSQL')).toBe(false);
    expect(userShows(broad, 'software engineering')).toBe(false);
    // And nothing unrelated is granted.
    expect(userShows(user, 'Kubernetes')).toBe(false);
    expect(userShows(user, 'machine learning')).toBe(false);
    expect(showingTerms('Kubernetes')).toEqual([]);
    expect(titleShows('Account Executive', 'software engineering')).toBe(false);
    expect(titleShows('Backend Developer', 'software development')).toBe(true);
  });

  it('the keyword check lists them as met, with the technology that counted; the score uses the same rule', () => {
    const job = matchJob({ skills: ['cloud infrastructure', 'relational databases', 'api design', 'kubernetes'], skillsDetail: null });
    const rows = buildKeywordRows({ job: { ...job, minYears: null }, user, resumeText: RESUME, keywords: [{ keyword: 'software engineering', importance: 'high' }] });
    const skills = rows.find((r) => r.key === 'skills')!;
    expect(skills.items).toEqual([
      { term: 'Cloud infrastructure', found: true, via: 'AWS', required: false },
      { term: 'Relational databases', found: true, via: 'PostgreSQL', required: false },
      { term: 'API design', found: true, via: 'REST API', required: false },
      { term: 'Kubernetes', found: false, required: false },
    ]);
    expect(skills).toMatchObject({ found: 3, total: 4, status: 'partly' });
    expect(rows.find((r) => r.key === 'keywords')!.items).toEqual([{ term: 'Software engineering', found: true, via: 'Senior Software Engineer' }]);
    expect(splitSkills(user, job)).toMatchObject({ aligned: ['Cloud infrastructure', 'Relational databases', 'API design'], missing: ['Kubernetes'] });
    expect(skillsDimension(user, job, DEFAULT_MATCH_WEIGHTS).score).toBe(75);
  });
});

describe('a technology name that is also an everyday word is not taken from a sentence (D3)', () => {
  const prose = (text: string, skills: string[] = []) => matchUser({ skills, resumeTextNorm: normalizeText(text), recentTitle: 'Account Manager' });

  it.each([
    ['handed the rest of the migration to the platform team', 'api design'],
    ['I excel at stakeholder communication', 'spreadsheets'],
    ['Known for swift resolution of escalations', 'object-oriented programming'],
    ['I react quickly to customer issues', 'frontend frameworks'],
    ['Account manager at Oracle, 2019 to 2023', 'databases'],
    ['I sketch storyboards for the creative team', 'design tools'],
    ['Opened a shell company filing for the client', 'scripting'],
    ['Lambda chapter treasurer; ruby anniversary organiser', 'cloud infrastructure'],
    ['Ran the aurora viewing tours', 'relational databases'],
  ])('"%s" does not show %s', (text, term) => {
    const u = prose(text);
    expect(shownVia(u, term)).toEqual({ shown: false, via: null });
    const job = matchJob({ skills: [term], skillsDetail: null });
    expect(splitSkills(u, job)).toMatchObject({ aligned: [], missing: [displayTerm(term)] });
    expect(skillsDimension(u, job, DEFAULT_MATCH_WEIGHTS).score).toBe(0);
  });

  it.each([
    ['api design', ['REST'], 'REST'],
    ['spreadsheets', ['Excel'], 'Excel'],
    ['object-oriented programming', ['Swift'], 'Swift'],
    ['frontend frameworks', ['React'], 'React'],
    ['databases', ['Oracle'], 'Oracle'],
    ['design tools', ['Sketch'], 'Sketch'],
  ])('%s is shown when the skill list names %s', (term, skills, via) => {
    expect(shownVia(prose('Seven years in client services.', skills), term)).toEqual({ shown: true, via });
  });

  it.each([
    ['Designed a REST API for partner billing', 'api design', 'REST API'],
    ['Built RESTful services in Java', 'api design', 'RESTful'],
    ['Tuned Oracle Database 19c for the ledger', 'relational databases', 'Oracle database'],
    ['Shipped the checkout in React.js and Redux', 'frontend frameworks', 'React.js'],
    ['Moved image resizing to AWS Lambda', 'cloud infrastructure', 'AWS'],
    ['Wrote shell scripts for nightly backups', 'scripting', 'Shell scripts'],
    // A name that is not an everyday word still counts from a sentence.
    ['Moved the event bus to Kafka', 'message queues', 'Kafka'],
    ['Built dashboards in Figma and Tableau', 'design tools', 'Figma'],
  ])('"%s" shows %s (via %s)', (text, term, via) => {
    expect(shownVia(prose(text), term)).toEqual({ shown: true, via });
  });

  it('one letter is never read out of prose: "Series C" is not the C language', () => {
    const u = prose('Joined at Series C and led the R and D budget review. Wrote the Python services.');
    expect(userShows(u, 'C')).toBe(false);
    expect(userShows(u, 'R')).toBe(false);
    expect(userShows(u, 'C++ and Python')).toBe(false);
    expect(userShows(u, 'C and Python')).toBe(false);
    // Named in the skill list, they count.
    const listed = prose('Wrote the Python services.', ['C', 'C++', 'R']);
    expect(userShows(listed, 'C')).toBe(true);
    expect(userShows(listed, 'C++ and Python')).toBe(true);
    expect(userShows(listed, 'R and Python')).toBe(true);
  });

  it('和 / 及 inside a Chinese word do not split it', () => {
    // 亲 and 力 both occur in this resume; 亲和力 does not.
    const u = prose('亲自带领团队完成交付，执行力强。熟悉 Java 和 Python。');
    expect(termParts('亲和力')).toEqual(['亲和力']);
    expect(termParts('及时反馈')).toEqual(['及时反馈']);
    expect(termParts('Java和Python')).toEqual(['Java', 'Python']);
    expect(termParts('沟通及协调')).toEqual(['沟通', '协调']);
    expect(userShows(u, '亲和力')).toBe(false);
    expect(userShows(u, 'Java和Python')).toBe(true);
  });

  it('"+" inside a name is not a joiner', () => {
    expect(termParts('C++ and Python')).toEqual(['C++', 'Python']);
    expect(termParts('C++')).toEqual(['C++']);
    expect(termParts('C#/.NET')).toEqual(['C#', '.NET']);
    expect(termParts('React + Redux')).toEqual(['React', 'Redux']);
    expect(termParts('react+redux')).toEqual(['react', 'redux']);
    expect(termParts('CompTIA A+ certification')).toEqual(['CompTIA A+ certification']);
    expect(termParts('PL/SQL and Python')).toEqual(['PL/SQL', 'Python']);
    expect(termParts('R&D and QA')).toEqual(['R&D', 'QA']);
  });
});

describe('one entry per thing', () => {
  it('"typescript/node.js" is not listed next to TypeScript and Node.js; a longer copy of a listed phrase is dropped', () => {
    const job = matchJob({
      skills: ['typescript/node.js', 'TypeScript', 'Node.js', 'shared backend systems and frameworks', 'shared backend systems', 'typescript', 'REST APIs', 'rest api'],
      skillsDetail: null,
    });
    expect(jobSkillList(job).map((s) => s.skill)).toEqual(['TypeScript', 'Node.js', 'Shared backend systems', 'REST APIs']);
    expect(dedupeTerms(['React and Redux', 'react', 'redux', 'CI/CD', 'ci cd'], (x) => x)).toEqual(['react', 'redux', 'CI/CD']);
    // A compound whose parts are not all listed is kept: nothing is lost.
    expect(dedupeTerms(['typescript/node.js', 'typescript'], (x) => x)).toEqual(['typescript/node.js', 'typescript']);
    // A single word never swallows a phrase ("design" does not remove "system design").
    expect(dedupeTerms(['design', 'system design'], (x) => x)).toEqual(['design', 'system design']);
    expect(termParts('CI/CD')).toEqual(['CI/CD']);
    expect(termParts('typescript/node.js')).toEqual(['typescript', 'node.js']);
  });

  it('a keyword already listed as a skill is not repeated under keywords', () => {
    const job = matchJob({ skills: ['typescript', 'node.js'], skillsDetail: null });
    const rows = buildKeywordRows({
      job: { ...job, minYears: null },
      user,
      resumeText: RESUME,
      keywords: [
        { keyword: 'typescript', importance: 'high' },
        { keyword: 'TypeScript/Node.js', importance: 'high' },
        { keyword: 'ingestion', importance: 'medium' },
        { keyword: 'ingestion', importance: 'medium' },
        { keyword: 'team', importance: 'low' },
      ],
    });
    expect(rows.find((r) => r.key === 'keywords')!.items.map((i) => i.term)).toEqual(['TypeScript/Node.js', 'Ingestion']);
    const terms = rows.flatMap((r) => r.items.map((i) => i.term));
    expect(new Set(terms).size).toBe(terms.length);
  });
});

describe('display spelling', () => {
  it.each([
    ['go', 'Go'],
    ['mysql', 'MySQL'],
    ['grpc', 'gRPC'],
    ['node.js', 'Node.js'],
    ['typescript/node.js', 'TypeScript/Node.js'],
    ['aws lambda', 'AWS Lambda'],
    ['ci/cd', 'CI/CD'],
    ['saas application development', 'SaaS application development'],
    ['cloud infrastructure', 'Cloud infrastructure'],
    ['iOS', 'iOS'],
    ['pandas', 'pandas'],
    ['McKinsey 7S', 'McKinsey 7S'], // the post's own capitals are kept
    ['数据分析', '数据分析'],
    ['  rest   apis ', 'REST APIs'],
    // An everyday word inside a phrase is re-spelled only next to another technology name.
    ['less supervision', 'Less supervision'],
    ['do more with less', 'Do more with less'],
    ['r and d', 'R and d'],
    ['bed rest care', 'Bed rest care'],
    ['go to market strategy', 'Go to market strategy'],
    ['spring campaign planning', 'Spring campaign planning'],
    ['express delivery', 'Express delivery'],
    ['less', 'LESS'],
    ['r', 'R'],
    ['html, css and less', 'HTML, CSS and LESS'],
    ['rest api design', 'REST API design'],
    ['java spring', 'Java Spring'],
    ['python and r', 'Python and R'],
    ['go and grpc', 'Go and gRPC'],
  ])('%s → %s', (raw, shown) => {
    expect(displayTerm(raw)).toBe(shown);
  });
});
