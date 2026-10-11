// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { HANT_MIN_SHARE, detectLang } from './lang.js';

const EN = 'We are looking for a Senior Backend Engineer to join our platform team. You will design and build services with Go and PostgreSQL, and you will work with product managers to ship features that our customers love.';
const HANS = '岗位职责：负责公司核心产品的后端开发与架构设计，参与需求评审，保证系统的稳定性。任职要求：三年以上相关工作经验，熟悉 Java、MySQL、Redis，具备良好的沟通能力。';
const HANT = '工作內容：負責公司核心產品的後端開發與架構設計，參與需求評審，確保系統穩定。應徵條件：三年以上相關工作經驗，熟悉 Java、MySQL、Redis，具備良好的溝通能力。';

describe('detectLang', () => {
  it('separates a Traditional from a Simplified posting', () => {
    expect(detectLang(HANT)).toBe('zh-Hant');
    expect(detectLang(HANS)).toBe('zh-Hans');
    expect(HANT_MIN_SHARE).toBe(0.02);
  });

  it('keeps a Chinese posting Chinese when it is full of English tool names', () => {
    expect(detectLang('高级后端工程师，熟悉 Kubernetes Docker Go Rust gRPC Kafka，负责微服务架构设计与性能优化')).toBe('zh-Hans');
  });

  it('calls English text English and an English posting with a Chinese company name English', () => {
    expect(detectLang(EN)).toBe('en');
    expect(detectLang(`${EN} (字节跳动)`)).toBe('en');
    expect(detectLang('Senior Software Engineer')).toBe('en');
  });

  it('never guesses among European languages: other Latin text is "other"', () => {
    const de = 'Wir suchen einen Softwareentwickler (m/w/d) für unser Team in Berlin mit Erfahrung in Java und Spring Boot sowie guten Deutschkenntnissen und Freude an der Arbeit im agilen Umfeld unserer Firma.';
    const fr = "Nous recherchons un développeur confirmé pour rejoindre notre équipe à Paris. Vous concevez des services avec Java et vous travaillez avec les chefs de produit afin de livrer des fonctionnalités utiles à nos clients.";
    expect(detectLang(de)).toBe('other');
    expect(detectLang(fr)).toBe('other');
    expect(detectLang('Développeur confirmé')).toBe('other');
  });

  it('reads kana as Japanese and Hangul as Korean', () => {
    expect(detectLang('フロントエンドエンジニアを募集しています。ReactとTypeScriptの経験がある方を歓迎します。')).toBe('ja');
    expect(detectLang('프론트엔드 개발자를 모집합니다. React와 TypeScript 경험이 있는 분을 환영합니다.')).toBe('ko');
  });

  it('does not take one stray kana in a Taiwan posting for Japanese', () => {
    expect(detectLang('鮮の味餐廳誠徵外場服務人員，負責點餐與桌邊服務，需配合輪班')).toBe('zh-Hant');
  });

  it('answers "other" for nothing to read', () => {
    expect(detectLang('')).toBe('other');
    expect(detectLang(null)).toBe('other');
    expect(detectLang('12345 — 67890')).toBe('other');
  });
});
