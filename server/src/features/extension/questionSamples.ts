// server/src/features/extension/questionSamples.ts — sample application
// questions per protected type (test fixtures for questionTypes.test.ts and
// the service's "never source: 'ai'" table test). Data only.

import type { PROTECTED_QUESTION_TYPES } from './contract.js';

/** At least two phrasings per protected type (exported for the service table test). */
export const PROTECTED_SAMPLES: Record<(typeof PROTECTED_QUESTION_TYPES)[number], string[]> = {
  work_authorization: ['Are you legally authorized to work in the United States?', 'Do you have the right to work in the UK?', '您是否拥有在中国大陆的工作许可？'],
  sponsorship: ['Will you now or in the future require sponsorship for employment visa status (e.g. H-1B)?', '是否需要公司担保工作签证？'],
  criminal_history: ['Have you ever been convicted of a felony?', '您是否有犯罪记录？'],
  eeo: ['What is your gender?', 'Are you Hispanic or Latino?', 'Please select your race / ethnicity', '性别'],
  personal: ['What is your date of birth?', 'Marital status', '政治面貌', '籍贯'],
  disability: ['Do you have a disability or chronic condition?', '是否有残疾？'],
  veteran: ['Are you a protected veteran?', '是否为退伍军人？'],
  salary_history: ['What is your current salary?', 'Please share your previous compensation', '目前薪资是多少？'],
  salary_expectation: ['What are your salary expectations?', 'Desired compensation (USD)', '期望薪资'],
  years_of_experience: ['How many years of experience do you have with Python?', '5+ years of professional experience required — how many do you have?', '工作年限'],
  degree: ["What is the highest level of education you have completed?", "Do you have a bachelor's degree in Computer Science?", '最高学历'],
  certification: ['Do you hold a PMP certification?', 'Are you a licensed CPA?', '是否持有教师资格证？'],
  clearance: ['Do you have an active security clearance?', '是否通过政审？'],
  notice_period: ['What is your notice period?', 'When can you start?', '最快到岗时间'],
};

/**
 * Everyday phrasings that are NOT the samples above: the review's
 * counterexamples plus wordings collected from real application forms. Kept
 * apart so a regex change is tested against questions it was not written
 * for. Each must classify as the given protected type (and so never get an
 * AI draft).
 */
export const ADVERSARIAL_PROTECTED_TYPED: ReadonlyArray<[string, (typeof PROTECTED_QUESTION_TYPES)[number]]> = [
  // Review counterexamples
  ['Will you require a visa to work in the US?', 'sponsorship'],
  ['Can you work in the US without restrictions?', 'sponsorship'],
  ['How long have you worked with React?', 'years_of_experience'],
  ['Number of years in sales?', 'years_of_experience'],
  ['When are you available to begin?', 'notice_period'],
  ['What is your desired base pay?', 'salary_expectation'],
  ['期望工资', 'salary_expectation'],
  ['目前工资是多少？', 'salary_history'],
  ['政治面貌', 'personal'],
  ['籍贯', 'personal'],
  ['出生日期', 'personal'],
  ['婚姻状况', 'personal'],
  ['What is your date of birth?', 'personal'],
  // More real-world wordings
  ['Do you now, or will you in the future, need an employment visa?', 'sponsorship'],
  ['Are you able to legally work in Canada?', 'work_authorization'],
  ['Can you legally work in Germany?', 'work_authorization'],
  ['What is your nationality?', 'work_authorization'],
  ['Are you eligible to work in Australia?', 'work_authorization'],
  ['How many years have you been coding in Go?', 'years_of_experience'],
  ['Years with Kubernetes', 'years_of_experience'],
  ['How long have you been managing teams?', 'years_of_experience'],
  ['您有多少年的销售经验？', 'years_of_experience'],
  ['从业年限', 'years_of_experience'],
  ['What are your compensation requirements?', 'salary_expectation'],
  ['Target pay (annual)', 'salary_expectation'],
  ['期望月薪是多少？', 'salary_expectation'],
  ['年薪要求', 'salary_expectation'],
  ['What is your current annual income?', 'salary_history'],
  ['上一份工作的月薪', 'salary_history'],
  ['When could you start?', 'notice_period'],
  ['What is the earliest date you could join?', 'notice_period'],
  ['多久可以入职？', 'notice_period'],
  ['How old are you?', 'personal'],
  ['What is your marital status?', 'personal'],
  ['身份证号码', 'personal'],
  ['健康状况', 'personal'],
  ['家庭成员情况', 'personal'],
  ['Have you ever been arrested?', 'criminal_history'],
  ['Do you identify as transgender?', 'eeo'],
  ['Have you served in the armed forces?', 'veteran'],
  ['Do you hold a current driver’s license?', 'certification'],
  ['Have you completed a university degree?', 'degree'],
  ['Do you hold an active TS/SCI clearance?', 'clearance'],
  // Second review: English gaps
  ['How much do you expect to earn?', 'salary_expectation'],
  ['What is your desired hourly rate?', 'salary_expectation'],
  ['What rate of pay are you looking for?', 'salary_expectation'],
  ['Are you 18 or older?', 'personal'],
  ['Are you over 18?', 'personal'],
  ['Do you meet the minimum age requirement?', 'personal'],
  // Second review: other languages (RoboApply users apply to employers abroad)
  ['Benötigen Sie ein Visum oder eine Arbeitserlaubnis?', 'sponsorship'],
  ['Besitzen Sie eine gültige Arbeitserlaubnis für Deutschland?', 'work_authorization'],
  ['Gehaltsvorstellung', 'salary_expectation'],
  ['Wie hoch ist Ihr aktuelles Gehalt?', 'salary_history'],
  ['Geburtsdatum', 'personal'],
  ['Wie viele Jahre Berufserfahrung haben Sie?', 'years_of_experience'],
  ['Kündigungsfrist', 'notice_period'],
  ['¿Estás autorizado para trabajar en España?', 'work_authorization'],
  ['Pretensión salarial', 'salary_expectation'],
  ['Fecha de nacimiento', 'personal'],
  ['¿Cuántos años de experiencia tienes?', 'years_of_experience'],
  ['Prétentions salariales', 'salary_expectation'],
  ['Quelle est votre date de naissance ?', 'personal'],
  ['Êtes-vous autorisé à travailler en France ?', 'work_authorization'],
  ['Quel est votre préavis ?', 'notice_period'],
  ['Qual é a sua pretensão salarial?', 'salary_expectation'],
  ['Data de nascimento', 'personal'],
  ['Qual è la RAL desiderata?', 'salary_expectation'],
  ['Wat is je salarisindicatie?', 'salary_expectation'],
  ['就労ビザのスポンサーは必要ですか？', 'sponsorship'],
  ['希望年収を教えてください', 'salary_expectation'],
  ['生年月日', 'personal'],
  ['희망 연봉은 얼마입니까?', 'salary_expectation'],
  ['생년월일을 입력하세요', 'personal'],
];
export const ADVERSARIAL_PROTECTED: string[] = ADVERSARIAL_PROTECTED_TYPED.map(([q]) => q);

/**
 * Open questions in a language the classifier does not fully cover. They may
 * classify as `free_text`, but AI must still never draft them
 * (`draftableLanguage` fails closed).
 */
export const UNSUPPORTED_LANGUAGE_FREE_TEXT: string[] = [
  'Warum möchten Sie bei uns arbeiten?',
  'Erzählen Sie uns etwas über sich',
  'Pourquoi souhaitez-vous rejoindre notre équipe ?',
  '¿Por qué quieres trabajar con nosotros?',
  'Por que você quer trabalhar conosco?',
  'Perché vuoi lavorare con noi',
  'Waarom wil je bij ons werken',
  '自己PRをお願いします',
  '지원 동기를 작성해 주세요',
  'Почему вы хотите работать у нас?',
];
