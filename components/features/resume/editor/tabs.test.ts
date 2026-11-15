// The editor tabs' URL contract (components/features/resume/editor/tabs.ts):
// `?tab=` names the open tab, Edit is the bare URL, other parameters survive
// a tab change, and check / analyzer anchors map to the Edit tab's sections.

import { describe, expect, it } from 'vitest';

import { EDITOR_TABS, editorSectionIdFor, editorTabFrom, editorTabHref, isEditorTab, withEditorTab } from './tabs';
import { editorTabHref as fromAreaIndex } from '..';

describe('editor tabs in the URL', () => {
  it('lists the four tabs in resume.io order', () => {
    expect(EDITOR_TABS).toEqual(['edit', 'customize', 'review', 'tailor']);
    expect(isEditorTab('review')).toBe(true);
    expect(isEditorTab('ai-review')).toBe(false);
  });

  it('reads `?tab=`, and anything missing or unknown opens Edit', () => {
    expect(editorTabFrom('customize')).toBe('customize');
    expect(editorTabFrom(' Review ')).toBe('review');
    expect(editorTabFrom('tailor')).toBe('tailor');
    expect(editorTabFrom(null)).toBe('edit');
    expect(editorTabFrom(undefined)).toBe('edit');
    expect(editorTabFrom('')).toBe('edit');
    expect(editorTabFrom('preview')).toBe('edit');
  });

  it('writes the tab and keeps every other parameter; Edit removes it', () => {
    expect(withEditorTab('', 'review')).toBe('tab=review');
    expect(withEditorTab('from=dashboard', 'tailor')).toBe('from=dashboard&tab=tailor');
    expect(withEditorTab('tab=review&from=dashboard', 'customize')).toBe('tab=customize&from=dashboard');
    expect(withEditorTab('tab=review&focus=section-summary', 'edit')).toBe('focus=section-summary');
    expect(withEditorTab('', 'edit')).toBe('');
  });

  it('builds a link that opens a tab (also from the resume area index)', () => {
    expect(editorTabHref('rv_1')).toBe('/resume/rv_1');
    expect(editorTabHref('rv_1', 'edit')).toBe('/resume/rv_1');
    expect(editorTabHref('cm 1', 'review')).toBe('/resume/cm%201?tab=review');
    expect(fromAreaIndex('rv_1', 'tailor')).toBe('/resume/rv_1?tab=tailor');
  });

  it('maps check and analyzer anchors to the Edit tab sections', () => {
    expect(editorSectionIdFor('section-contact')).toBe('identity');
    expect(editorSectionIdFor('section-target')).toBe('identity');
    expect(editorSectionIdFor('section-summary')).toBe('summary');
    expect(editorSectionIdFor('section-experience')).toBe('experience');
    expect(editorSectionIdFor('section-education')).toBe('education');
    expect(editorSectionIdFor('section-skills')).toBe('skills');
    expect(editorSectionIdFor('section-projects')).toBe('extra-sections');
    expect(editorSectionIdFor('exp-abc')).toBe('exp-abc');
    // A layout issue points nowhere in the form.
    expect(editorSectionIdFor('section-layout')).toBeNull();
    expect(editorSectionIdFor(null)).toBeNull();
    expect(editorSectionIdFor(undefined)).toBeNull();
  });
});
