// @vitest-environment node
//
// The linear HTML reader (html.ts). Two things are pinned here: what it reads
// (the same text a reader sees), and how long it takes on a document written
// to stall a pattern-based reader (time proportional to the size, never to its
// square).

import { describe, expect, it } from 'vitest';
import { htmlToPlain } from '../normalize/index.js';
import { htmlToText, ldJsonBlocks, pageOf, scanHtml, tagsOnly, withoutMarkdownLinks } from './html.js';

function pieces(html: string, unterminated: 'drop' | 'text' = 'drop'): string[] {
  const out: string[] = [];
  scanHtml(
    html,
    {
      text: (s, e) => out.push(`T:${html.slice(s, e)}`),
      tag: (name, closing, s, e) => out.push(`${closing ? 'C' : 'O'}:${name}:${html.slice(s, e)}`),
      hidden: (name, s, e, bs, be) => out.push(`H:${name}:${html.slice(s, e)}|${html.slice(bs, be)}`),
    },
    { unterminated },
  );
  return out;
}

describe('scanHtml', () => {
  it('reports text, tags and hidden pieces in document order', () => {
    expect(pieces('a<p class="x">b</p><!-- c --><script>var x = "<p>";</script>d')).toEqual([
      'T:a',
      'O:p:<p class="x">',
      'T:b',
      'C:p:</p>',
      'H::<!-- c -->|',
      'H:script:<script>var x = "<p>";</script>|var x = "<p>";',
      'T:d',
    ]);
  });

  it('a ">" inside a quoted attribute value does not end the tag; a "<" that starts no tag is text', () => {
    expect(pieces('<a title="a > b" href=\'x>y\'>k</a>')).toEqual(['O:a:<a title="a > b" href=\'x>y\'>', 'T:k', 'C:a:</a>']);
    expect(pieces('1 < 2 and 3 <4 and <<x>')).toEqual(['T:1 < 2 and 3 <4 and <', 'O:x:<x>']);
    expect(pieces('1 < 2 and <3')).toEqual(['T:1 < 2 and <3']);
    // A quote that does not follow "=" is not an attribute quote.
    expect(pieces('<p it\'s>x</p>')).toEqual(["O:p:<p it's>", 'T:x', 'C:p:</p>']);
  });

  it('what never ends: a page drops the rest; a posting keeps it as text', () => {
    expect(pieces('a<b and no end')).toEqual(['T:a', 'H::<b and no end|']);
    expect(pieces('a<b and no end', 'text')).toEqual(['T:a<b and no end']);
    expect(pieces('a<!-- never closed <p>x</p>')).toEqual(['T:a', 'H::<!-- never closed <p>x</p>|']);
    expect(pieces('a<script>never closed <p>x</p>')).toEqual(['T:a', 'H:script:<script>never closed <p>x</p>|never closed <p>x</p>']);
    // A posting that names a tag keeps the rest of its words.
    expect(pieces('XSS (<script> injection) and <b>more</b>', 'text')).toEqual(['T:XSS (', 'O:script:<script>', 'T: injection) and ', 'O:b:<b>', 'T:more', 'C:b:</b>']);
    // A tag with an unclosed quote ends at its first ">".
    expect(pieces('<p title="x>y</p><p>z</p>')).toEqual(['O:p:<p title="x>', 'T:y', 'C:p:</p>', 'O:p:<p>', 'T:z', 'C:p:</p>']);
  });

  it('closing tags of raw-text elements are matched whatever their case or spacing', () => {
    expect(pieces('<STYLE>p{}</Style >x')).toEqual(['H:style:<STYLE>p{}</Style >|p{}', 'T:x']);
    expect(pieces('<script>a</scripty>b</script>c')).toEqual(['H:script:<script>a</scripty>b</script>|a</scripty>b', 'T:c']);
  });
});

describe('htmlToText', () => {
  it('keeps paragraph and list breaks, decodes entities, drops what a reader never sees', () => {
    expect(htmlToText('<h1>数据工程师</h1><p>负责&nbsp;A &amp; B<br>第二行</p><ul><li>一</li><li>二&#65292;三</li></ul><script>x()</script><style>p{}</style><!-- c -->')).toBe(
      '数据工程师\n负责 A & B\n第二行\n\n• 一\n\n• 二，三',
    );
    expect(htmlToText('a   b\t 　c')).toBe('a b c');
    expect(htmlToText('5 < 6 &lt;b&gt; &#x4e2d; &bogus; &#0;')).toBe('5 < 6 <b> 中 &bogus; &#0;');
    expect(htmlToText('')).toBe('');
  });
});

describe('tagsOnly', () => {
  it('reduces tags to their names, drops comments, scripts and styles, and escapes a "<" that is not a tag', () => {
    expect(tagsOnly('<p class="a" data-x="<li <li">一</p><!-- c --><script>x</script><br/>5 < 6')).toBe('<p>一</p>  <br>5 &lt; 6');
    expect(tagsOnly('no markup at all')).toBe('no markup at all');
    expect(tagsOnly('<script>unclosed and <style>too')).toBe(' unclosed and  too');
  });

  it('a posting that is not HTML keeps every word', () => {
    expect(htmlToPlain(tagsOnly('if a<b then c, and x < y'))).toBe('if a<b then c, and x < y');
    expect(htmlToPlain(tagsOnly('Knowledge of XSS (<script> injection) required')).replace(/ +/g, ' ')).toBe('Knowledge of XSS ( injection) required');
  });

  it('well-formed markup reads the same through the shared htmlToPlain with or without it', () => {
    for (const html of [
      '<p>Build <b>data</b> pipelines.</p><ul><li class="x">SQL</li><li>Python &amp; Go</li></ul><p style="margin:0">Remote<br/>Shanghai</p>',
      '<div><h2>About</h2><p>We&nbsp;hire.</p></div><style>.a{color:red}</style><p>End</p>',
      '<p>网申截止时间：2026年11月30日。</p><ol><li>本科及以上</li></ol>',
    ]) {
      expect(htmlToPlain(tagsOnly(html))).toBe(htmlToPlain(html));
    }
  });
});

describe('pageOf', () => {
  const page = pageOf(
    '<!doctype html><html><head><title> 数据工程师 &amp; 分析 - 示例 </title><meta charset="utf-8"><meta name="description" content="示例科技招聘"><meta content=\'示例科技\' property="og:site_name"><meta property="og:title" content="数据工程师"><meta name="description" content="second is ignored">' +
      '<script type="application/ld+json">{"@type":"JobPosting"}</script><script>var a = "<main>";</script><script type=application/ld+json>{"b":1}</script></head>' +
      '<body><header>顶部</header><nav>首页 <aside>内嵌</aside> 职位</nav><main><h1>数据工程师</h1><p>正文</p><form><input value="x">申请</form></main><footer>© 示例</footer></body></html>',
  );

  it('reads the title, the metas the import uses and every structured-data block', () => {
    expect(page.title).toBe('数据工程师 & 分析 - 示例');
    expect(page.meta).toEqual({ description: '示例科技招聘', 'og:site_name': '示例科技', 'og:title': '数据工程师' });
    expect(page.ldJson).toEqual(['{"@type":"JobPosting"}', '{"b":1}']);
    expect(ldJsonBlocks('<script type="application/ld+json">{"a":1}</script><script type="text/javascript">x</script><SCRIPT TYPE=\'application/ld+json\'>{"b":2}</SCRIPT>')).toEqual(['{"a":1}', '{"b":2}']);
    expect(ldJsonBlocks('no markup')).toEqual([]);
  });

  it('the main part: <main>, else <article>, else <body>, without chrome blocks', () => {
    expect(page.mainHtml.replace(/\s+/g, '')).toBe('<h1>数据工程师</h1><p>正文</p>');
    expect(pageOf('<body><nav>n</nav><article><p>a</p></article><aside>s</aside></body>').mainHtml).toBe('<p>a</p>');
    expect(pageOf('<body><header>h</header><p>b</p><!-- c --><form>f</form><footer>f</footer></body>').mainHtml.replace(/\s+/g, '')).toBe('<p>b</p>');
    // A chrome block that is never closed is kept (its text may be the posting); a later, closed one still goes.
    expect(htmlToText(pageOf('<body><header><p>职位正文</p><footer>页脚</footer></body>').mainHtml)).toBe('职位正文');
    // No <body> at all: the document itself.
    expect(htmlToText(pageOf('<p>只有正文</p>').mainHtml)).toBe('只有正文');
    expect(pageOf('<p>x</p>').title).toBeNull();
  });
});

describe('withoutMarkdownLinks', () => {
  const reference = (s: string) => s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

  it('images become a space and links their label', () => {
    expect(withoutMarkdownLinks('See ![logo](https://x/y.png) and [the role](https://x/jobs/1) today')).toBe('See   and the role today');
    expect(withoutMarkdownLinks('[![alt](a.png)](https://x)')).toBe(' ');
    expect(withoutMarkdownLinks('no links [here] (or) there')).toBe('no links [here] (or) there');
  });

  it('gives what the two patterns gave, on every arrangement of brackets', () => {
    // Every string of length ≤ 7 over the characters that matter, then longer random ones.
    const alphabet = ['[', ']', '(', ')', '!', 'a', '\n'];
    const all: string[] = [''];
    for (let len = 1; len <= 7; len += 1) {
      const start = all.length - alphabet.length ** (len - 1);
      const prev = all.slice(Math.max(0, start));
      for (const p of prev) for (const c of alphabet) all.push(p + c);
    }
    for (const s of all) expect(withoutMarkdownLinks(s), JSON.stringify(s)).toBe(reference(s));
    let seed = 20261011;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let k = 0; k < 3000; k += 1) {
      let s = '';
      const len = 8 + Math.floor(rnd() * 40);
      for (let j = 0; j < len; j += 1) s += alphabet[Math.floor(rnd() * alphabet.length)];
      expect(withoutMarkdownLinks(s), JSON.stringify(s)).toBe(reference(s));
    }
  });
});

describe('time: proportional to the size of the document', () => {
  const SIZE = 2 * 1024 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
  const timed = (fn: () => unknown): number => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };

  // Each of these made a pattern-based reader start again at every opener and read to the end:
  // 100 KB took seconds, 2 MB would take many minutes.
  it.each(['<meta ', '<!--', '<li ', '<script>', '<script ', '<title ', '<a href="', "<a b='x>y' ", '<style>', '<<<<', '< ', '&amp', '<p title=">" '])('2 MB of %j is read in well under a second', (unit) => {
    const html = fill(unit);
    // Measured: 0 to 75 ms, 1 to 65 ms, 0 to 97 ms, 0 to 36 ms. The limits leave room for a busy machine.
    expect(timed(() => pageOf(html))).toBeLessThan(1000);
    expect(timed(() => htmlToText(html))).toBeLessThan(1000);
    expect(timed(() => tagsOnly(html))).toBeLessThan(1500);
    expect(timed(() => ldJsonBlocks(html))).toBeLessThan(1000);
  });

  // Half a million real tags: more work, still one pass.
  it.each(['<li>', '<p>x</p>', '<nav>', '<br>', '<b>1</b>', '<script type="application/ld+json">{}</script>', '<meta name="description" content="x">'])('2 MB of %j', (unit) => {
    const html = fill(unit);
    expect(timed(() => htmlToText(pageOf(html).mainHtml))).toBeLessThan(2000);
    expect(timed(() => htmlToPlain(tagsOnly(html)))).toBeLessThan(4000);
  });

  it.each(['![', '[', '](', '[a](', '[a]', '![a](b', ' \n', ' '])('2 MB of %j as markdown', (unit) => {
    const md = fill(unit);
    expect(timed(() => withoutMarkdownLinks(md))).toBeLessThan(1000);
  });
});
