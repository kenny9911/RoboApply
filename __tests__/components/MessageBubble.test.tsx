// MessageBubble — AI vs user variant, children render correctly, optional
// eyebrow renders, structural classes differ between roles.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageBubble } from '../../components/chat/MessageBubble';

describe('MessageBubble', () => {
  it('role="ai": renders children with white bg + ink-line-soft border', () => {
    const { container } = render(
      <MessageBubble role="ai">
        <p>AI response</p>
      </MessageBubble>,
    );
    expect(screen.getByText(/AI response/i)).toBeInTheDocument();
    // Inner panel
    const inner = container.querySelector('.bg-white');
    expect(inner).not.toBeNull();
    expect(inner!.className).toMatch(/border-ink-line-soft/);
  });

  it('role="user": renders children with teal-50 bg', () => {
    const { container } = render(
      <MessageBubble role="user">
        <p>User message</p>
      </MessageBubble>,
    );
    expect(screen.getByText(/User message/i)).toBeInTheDocument();
    const inner = container.querySelector('.bg-teal-50');
    expect(inner).not.toBeNull();
  });

  it('eyebrow renders inside .robo-eyebrow when supplied', () => {
    render(
      <MessageBubble role="ai" eyebrow="WHY I PICKED THIS">
        <p>Body content</p>
      </MessageBubble>,
    );
    const eb = screen.getByText(/WHY I PICKED THIS/);
    expect(eb).toBeInTheDocument();
    expect(eb.className).toMatch(/robo-eyebrow/);
  });

  it('arbitrary HTML children render (e.g. tables/markdown)', () => {
    render(
      <MessageBubble role="ai">
        <table>
          <tbody>
            <tr>
              <td>Cell A</td>
              <td>Cell B</td>
            </tr>
          </tbody>
        </table>
      </MessageBubble>,
    );
    expect(screen.getByText('Cell A')).toBeInTheDocument();
    expect(screen.getByText('Cell B')).toBeInTheDocument();
  });

  it('NO dangerouslySetInnerHTML on string children — text inputs render literally (XSS guard)', () => {
    // MessageBubble accepts arbitrary children but does not interpret strings
    // as HTML — a `<script>` tag passed as text is escaped by React.
    const malicious = '<script>window.__pwn=true</script>';
    render(<MessageBubble role="ai">{malicious}</MessageBubble>);
    expect(screen.getByText(malicious)).toBeInTheDocument();
    // Confirm no script tag was injected.
    expect(document.querySelector('script')).toBeNull();
  });
});
