// @vitest-environment node
//
// The watermark word-repair heuristic of the pdftotext path.
//
// It used to fire on any line with two single-letter tokens, so an ordinary
// sentence with two "a"s ("Automated a monthly … 6 hours a month") was stored
// as "Automatedamonthly … hoursamonth" and Resume check then flagged the glued
// words as spelling mistakes.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/parsePdf.js', () => ({ parsePdf: vi.fn(), renderPdfPages: vi.fn() }));
vi.mock('./llm/LLMService.js', () => ({ llmService: {} }));
vi.mock('./llm/GoogleProvider.js', () => ({ GoogleProvider: class {} }));
vi.mock('./LoggerService.js', () => ({
  generateRequestId: () => 'req',
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { countWatermarkDebrisLines, looksWatermarkDamaged, repairWatermarkBrokenLine, repairWatermarkBrokenText, WATERMARK_DEBRIS_LINES } from './PDFService.js';

describe('repairWatermarkBrokenLine', () => {
  it('leaves ordinary English lines exactly as written', () => {
    const lines = [
      '• Automated a monthly cost report in Python (pandas), saving about 6 hours a month.',
      'I led a team of 4 and I built a pipeline for a client.',
      'Built a dashboard as a side project; a third of the team uses it.',
      'Wrote a plan B and a plan C for the launch.',
      'Languages: R or Python, C and Go',
      'Vitamin C and D study, 2019',
      'We built a tool. In a week it had a hundred users.',
      'n = 40 and p < 0.05 for the 3 x 4 design',
      'o Led the launch    o Built the pipelines o Hired 4',
    ];
    for (const line of lines) {
      expect(looksWatermarkDamaged(line), line).toBe(false);
      expect(repairWatermarkBrokenLine(line), line).toBe(line);
    }
  });

  it('leaves ordinary lines in other languages exactly as written (y, e, o, u, i are words)', () => {
    const lines = [
      // Spanish
      'Diseño y desarrollo de aplicaciones web y sistemas internos',
      'Marketing y ventas en el sector de consumo y retail',
      'Siete u ocho proyectos al año e informes mensuales',
      // Portuguese
      'Planejamento e controle de estoque e compras o ano todo',
      'Desenvolvimento e suporte de sistemas e aplicativos internos',
      // Italian
      'Gestione e sviluppo di progetti e prodotti digitali',
      'Ho coordinato i fornitori e i clienti del progetto',
      // French
      'Il y a deux ans, elle y a travaillé comme analyste',
    ];
    for (const line of lines) {
      expect(looksWatermarkDamaged(line), line).toBe(false);
      expect(repairWatermarkBrokenLine(line), line).toBe(line);
    }
  });

  it('a letter that only stands in front of a word is not damage', () => {
    const lines = [
      'Used k means clustering and t test analysis on sales data',
      'Series B startup, Type C connector',
      'Plan B works, Plan C fails',
      'Ran p value checks and z score outlier detection on 40 stores',
      'Took vitamin c for 8 weeks in a type b trial',
    ];
    for (const line of lines) {
      expect(looksWatermarkDamaged(line), line).toBe(false);
      expect(repairWatermarkBrokenLine(line), line).toBe(line);
    }
  });

  it('still repairs lines broken by a stripped watermark', () => {
    expect(repairWatermarkBrokenLine('P rodu c t M anager')).toBe('Product Manager');
    expect(repairWatermarkBrokenLine('Commer c iali z ation of new products')).toBe('Commercialization of new products');
    expect(repairWatermarkBrokenLine('M arketing D irector')).toBe('Marketing Director');
  });

  it('on a damaged line, never glues the words "a" and "I" or short words to their neighbours', () => {
    expect(repairWatermarkBrokenLine('Automated a c ommer c ial repor t for the team')).toBe('Automated a commercial report for the team');
    expect(repairWatermarkBrokenLine('We built a c ommer c ial por t al')).toBe('We built a commercial portal');
    expect(repairWatermarkBrokenLine('I was the c ommer c ial lead in a team')).toBe('I was the commercial lead in a team');
    // A wide gap is a layout column, not the inside of a word.
    expect(repairWatermarkBrokenLine('Produc t M anager    2019 - 2021')).toBe('Product Manager    2019 - 2021');
  });

  it('a line with one or two scattered breaks is left as extracted, not guessed at', () => {
    for (const line of ['Automated a monthly repor t for the c ompany', 'We built a c lient por t al']) {
      expect(repairWatermarkBrokenLine(line), line).toBe(line);
    }
  });
});

describe('repairWatermarkBrokenText: only a document that carried a watermark is repaired', () => {
  const damaged = ['P rodu c t M anager', 'Commer c iali z ation of new products', 'Praca w firmie z branży IT'].join('\n');

  it('a clean document is returned byte for byte, whatever its lines look like', () => {
    expect(repairWatermarkBrokenText(damaged, false)).toBe(damaged);
  });

  it('a watermarked document has its broken words rejoined', () => {
    expect(repairWatermarkBrokenText('P rodu c t M anager\nLed a team of 4.', true)).toBe('Product Manager\nLed a team of 4.');
  });

  it('debris lines are what a scattered tracking string leaves behind', () => {
    const scattered = ['Education', 'R Ux', '9 S6', 'H Z7', 'N  g', 'P rodu c t M anager'].join('\n');
    expect(countWatermarkDebrisLines(scattered)).toBe(4);
    expect(countWatermarkDebrisLines(scattered)).toBeGreaterThanOrEqual(WATERMARK_DEBRIS_LINES);
    // Short real lines are not debris: one token, page numbers, a date.
    const clean = ['SQL', 'R', 'Go', 'AWS', '1', '7 15', '2019 - 2021', 'UI / UX', 'Led a team of 4.'].join('\n');
    expect(countWatermarkDebrisLines(clean)).toBe(0);
  });
});
