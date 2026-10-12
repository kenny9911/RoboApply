// The D1 guard: interact.ts refuses anything submit-like (ARCHITECTURE.md §6.6).

import { describe, expect, it, vi } from 'vitest';

import { chooseOption, openListbox } from '../src/adapters/_kit/interact';
import { isSubmitLike } from '../src/adapters/_kit/submitLike';

function el(html: string, pick = '[data-t]'): HTMLElement {
  document.body.innerHTML = html;
  return document.querySelector<HTMLElement>(pick)!;
}

const SUBMIT_LIKE: Array<[string, string]> = [
  ['a <button>', '<form><button data-t>Choose</button></form>'],
  ['input type=submit', '<form><input type="submit" data-t value="Go"></form>'],
  ['input type=button', '<input type="button" data-t value="Pick">'],
  ['input type=image', '<input type="image" data-t alt="Send" src="data:,">'],
  ['type=submit on any element', '<div type="submit" data-t>x</div>'],
  ['role=button', '<div role="button" data-t>Option</div>'],
  ['a link named Apply', '<a href="#" data-t>Apply now</a>'],
  ['aria-label Submit', '<div role="option" aria-label="Submit application" data-t></div>'],
  ['aria-label Next', '<span aria-label="Next step" data-t></span>'],
  ['title Continue', '<div title="Continue" data-t></div>'],
  ['a radio labelled Review', '<label><input type="radio" name="r" data-t> Review my application</label>'],
  ['zh 提交', '<div aria-label="提交" data-t></div>'],
  ['zh 投递简历', '<div aria-label="投递简历" data-t></div>'],
  ['zh 下一步', '<a href="#" data-t>下一步</a>'],
  ['zh-TW 送出', '<div role="option" aria-label="送出" data-t></div>'],
  ['inside a button (1 level)', '<button><span data-t>Yes</span></button>'],
  ['inside role=button (3 levels)', '<div role="button"><div><div><span data-t>Yes</span></div></div></div>'],
  ['inside an element named Submit (2 levels)', '<div aria-label="Submit"><div><input type="checkbox" data-t></div></div>'],
  ['a <form> itself', '<form data-t></form>'],
];

describe('chooseOption / openListbox refuse submit-like elements', () => {
  for (const [name, html] of SUBMIT_LIKE) {
    it(`chooseOption throws for ${name}`, () => {
      const target = el(html);
      const spy = vi.fn();
      target.addEventListener('click', spy);
      expect(() => chooseOption(target)).toThrow(/submit-like/);
      expect(spy).not.toHaveBeenCalled();
    });
    it(`openListbox throws for ${name}`, () => {
      const target = el(html);
      const spy = vi.fn();
      target.addEventListener('click', spy);
      expect(() => openListbox(target)).toThrow(/submit-like/);
      expect(spy).not.toHaveBeenCalled();
    });
  }

  it('throws for a missing element', () => {
    expect(() => chooseOption(null as unknown as Element)).toThrow();
  });

  it('does not walk past 3 ancestor levels', () => {
    const target = el('<button><div><div><div><span><input type="radio" name="x" data-t></span></div></div></div></button>');
    expect(isSubmitLike(target)).toBe(false);
  });

  it('a form ancestor is normal (every field lives in one)', () => {
    const target = el('<form><label><input type="radio" name="a" data-t> Yes</label></form>');
    expect(isSubmitLike(target)).toBe(false);
  });
});

describe('chooseOption / openListbox work on ordinary choices', () => {
  it('chooses a radio labelled Yes', () => {
    const target = el('<form><label><input type="radio" name="a" value="y" data-t> Yes</label><label><input type="radio" name="a" value="n"> No</label></form>') as HTMLInputElement;
    chooseOption(target);
    expect(target.checked).toBe(true);
  });

  it('ticks a checkbox', () => {
    const target = el('<label><input type="checkbox" data-t> Zendesk</label>') as HTMLInputElement;
    chooseOption(target);
    expect(target.checked).toBe(true);
  });

  it('opens a combobox and chooses a listbox option', () => {
    document.body.innerHTML = '<input role="combobox" id="c" aria-controls="lb"><div role="listbox" id="lb"><div role="option" id="o1">No</div></div>';
    const input = document.getElementById('c')!;
    const option = document.getElementById('o1')!;
    const opened = vi.fn();
    const chosen = vi.fn();
    input.addEventListener('click', opened);
    option.addEventListener('click', chosen);
    openListbox(input);
    chooseOption(option);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(chosen).toHaveBeenCalledTimes(1);
  });
});
