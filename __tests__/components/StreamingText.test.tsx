// StreamingText — cursor present while streaming, removed on done=true.
//
// The .robo-cursor class drives the blinking 2px teal-700 vertical bar. We
// verify the class lifecycle without snapshotting CSS.

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { StreamingText } from '../../components/ui/StreamingText';

describe('StreamingText', () => {
  it('cursor present while streaming (done=false)', () => {
    const { container } = render(
      <StreamingText text="Good morning, Jane." done={false} />,
    );
    const span = container.querySelector('span');
    expect(span).not.toBeNull();
    expect(span!.className).toMatch(/robo-cursor/);
    expect(span!.textContent).toBe('Good morning, Jane.');
  });

  it('cursor removed when done=true', () => {
    const { container } = render(
      <StreamingText text="Finished briefing." done={true} />,
    );
    const span = container.querySelector('span');
    expect(span).not.toBeNull();
    expect(span!.className).not.toMatch(/robo-cursor/);
  });

  it('preserves whitespace (whitespace-pre-wrap)', () => {
    const { container } = render(
      <StreamingText text="Line 1\nLine 2" done={true} />,
    );
    expect(container.querySelector('span')!.className).toMatch(
      /whitespace-pre-wrap/,
    );
  });
});
