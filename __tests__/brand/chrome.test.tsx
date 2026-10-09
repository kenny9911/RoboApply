// WP-12 brand chrome: BrandSymbol (`brand` prop), BrandLogo (snapshot per
// brand), BrandWordmark, the appearance settings section, and the GoApply
// assets. No component writes a product name: it comes from the brand.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BrandSymbol } from '../../components/chrome/BrandSymbol';
import { BrandSettingsSection, BrandWordmark } from '../../components/features/brand';
import { AppearanceSection } from '../../components/v3/preferences/sections/AppearanceSection';
import { BrandLogo } from '../../components/v3/shell/BrandLogo';
import { ThemeProvider } from '../../lib/theme';
import { renderBranded } from './helpers';

const ROOT = process.cwd();

describe('BrandSymbol', () => {
  it('draws a different glyph per brand', () => {
    const { container: robo } = render(<BrandSymbol brand="roboapply" />);
    const { container: go } = render(<BrandSymbol brand="goapply" />);
    const roboSvg = robo.querySelector('svg')!;
    const goSvg = go.querySelector('svg')!;
    expect(roboSvg.getAttribute('data-brand-glyph')).toBe('roboapply');
    expect(goSvg.getAttribute('data-brand-glyph')).toBe('goapply');
    expect(roboSvg.innerHTML).not.toBe(goSvg.innerHTML);
    expect(roboSvg).toHaveAttribute('aria-hidden', 'true');
    expect(roboSvg).toHaveAttribute('stroke', 'currentColor');
  });

  it('follows the request brand when no prop is given (and RoboApply outside a provider)', () => {
    const { container: bare } = render(<BrandSymbol size={20} />);
    expect(bare.querySelector('svg')).toHaveAttribute('data-brand-glyph', 'roboapply');
    expect(bare.querySelector('svg')).toHaveAttribute('width', '20');
    const { container } = renderBranded(<BrandSymbol />, { brand: 'goapply' });
    expect(container.querySelector('svg')).toHaveAttribute('data-brand-glyph', 'goapply');
  });

  it('an explicit prop wins over the request brand', () => {
    const { container } = renderBranded(<BrandSymbol brand="roboapply" />, { brand: 'goapply' });
    expect(container.querySelector('svg')).toHaveAttribute('data-brand-glyph', 'roboapply');
  });
});

describe('BrandLogo', () => {
  it('RoboApply snapshot', () => {
    const { container } = renderBranded(<BrandLogo />, { brand: 'roboapply' });
    expect(screen.getByRole('link', { name: 'RoboApply — go to Jobs' })).toHaveAttribute('href', '/jobs');
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('GoApply snapshot', () => {
    const { container } = renderBranded(<BrandLogo />, { brand: 'goapply', locale: 'en' });
    expect(screen.getByRole('link', { name: 'GoApply — go to Jobs' })).toBeInTheDocument();
    expect(screen.getByText('GoApply')).toHaveClass('brand-name');
    expect(container.querySelector('[data-brand-glyph]')).toHaveAttribute('data-brand-glyph', 'goapply');
    expect(container.innerHTML).toMatchSnapshot();
  });
});

describe('BrandWordmark', () => {
  it('links home with the brand name and mark', () => {
    renderBranded(<BrandWordmark />, { brand: 'goapply', locale: 'en' });
    const link = screen.getByRole('link', { name: 'GoApply home' });
    expect(link).toHaveAttribute('href', '/');
    expect(link).toHaveTextContent('GoApply');
    expect(link.querySelector('[data-brand-glyph]')).toHaveAttribute('data-brand-glyph', 'goapply');
  });

  it('renders without a link when href is null, and in the md size', () => {
    const { container } = renderBranded(<BrandWordmark href={null} size="md" />, { brand: 'roboapply' });
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.textContent).toBe('RoboApply');
    expect(container.firstElementChild?.className).toMatch(/md/);
  });

  it('can show the other brand (name and glyph both switch)', () => {
    const { container } = renderBranded(<BrandWordmark brand="goapply" href="https://www.goapply.top/" />, { brand: 'roboapply' });
    expect(container.textContent).toBe('GoApply');
    expect(container.querySelector('[data-brand-glyph]')).toHaveAttribute('data-brand-glyph', 'goapply');
  });
});

describe('appearance settings section', () => {
  it('switches the theme through lib/theme (the legacy renderer shows the same section)', () => {
    for (const Section of [() => <BrandSettingsSection section="appearance" />, () => <AppearanceSection />]) {
      const { unmount } = renderBranded(
        <ThemeProvider>
          <Section />
        </ThemeProvider>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      fireEvent.click(screen.getByRole('button', { name: 'Light' }));
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
      unmount();
    }
  });
});

describe('GoApply assets (public/brands/goapply)', () => {
  const dir = join(ROOT, 'public/brands/goapply');

  function pngSize(file: string): { w: number; h: number } {
    const buf = readFileSync(join(dir, file));
    expect(buf.subarray(1, 4).toString('ascii')).toBe('PNG');
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }

  it('has the mark, favicon, logo, OG image and apple-touch icon', () => {
    for (const f of ['mark.svg', 'favicon.svg', 'logo.png', 'og.png', 'apple-touch.png']) {
      expect(statSync(join(dir, f)).size, f).toBeGreaterThan(0);
    }
  });

  it('PNG sizes fit their use (OG 1200×630, apple-touch 180×180)', () => {
    expect(pngSize('og.png')).toEqual({ w: 1200, h: 630 });
    expect(pngSize('apple-touch.png')).toEqual({ w: 180, h: 180 });
    expect(pngSize('logo.png').w).toBeGreaterThan(pngSize('logo.png').h);
  });

  it('SVGs are self-contained (no external fonts, images or CDNs) and use the GoApply glyph', () => {
    const glyph = 'M17.5 7.5A7 7 0 1 0 19 12.5h-6.5';
    for (const f of ['mark.svg', 'favicon.svg']) {
      const svg = readFileSync(join(dir, f), 'utf8');
      expect(svg).toContain(glyph);
      expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
      expect(svg).not.toMatch(/<image|@import|font-face/);
    }
    expect(readFileSync(join(ROOT, 'components/chrome/BrandSymbol.tsx'), 'utf8')).toContain(glyph);
  });

  it('the dead Logo component is gone', () => {
    expect(() => statSync(join(ROOT, 'components/chrome/Logo.tsx'))).toThrow();
  });
});
