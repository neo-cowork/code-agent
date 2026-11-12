// @vitest-environment jsdom
import React from 'react';
import { writeSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { CodeBlock } from '../../../src/renderer/components/features/chat/MessageBubble/MessageContent';

const codeLines = (count: number) => Array.from(
  { length: count },
  (_, index) => `const line_${index + 1} = ${index + 1};`,
).join('\n');

describe('CodeBlock', () => {
  beforeEach(() => useAppStore.setState({ language: 'zh' }));
  afterEach(() => { cleanup(); useAppStore.setState({ language: 'zh' }); });

  for (const language of ['zh', 'en'] as const) {
    for (const count of [1, 3, 30]) {
      it(`renders ${language} count and controls for ${count} lines`, () => {
        useAppStore.setState({ language });
        const { container, getByTitle, getByText } = render(<CodeBlock language="ts" code={codeLines(count)} />);
        const header = container.querySelector('[data-code-block-lines] > div');
        const countText = language === 'zh' ? `${count} 行` : `${count} ${count === 1 ? 'line' : 'lines'}`;
        expect(header?.textContent).toContain(countText);
        expect(header?.textContent).not.toMatch(language === 'zh' ? /\blines?\b/ : /行/);
        const wrapOn = language === 'zh' ? '自动换行' : 'Wrap lines';
        const wrapOff = language === 'zh' ? '取消换行' : 'Unwrap lines';
        const wrap = getByTitle(wrapOn);
        writeSync(1, `[${language}] ${count} header DOM: ${header?.outerHTML}` + "\n");
        writeSync(1, `[${language}] wrap title before: ${wrap.title}` + "\n");
        fireEvent.click(wrap);
        expect(wrap.title).toBe(wrapOff);
        writeSync(1, `[${language}] wrap title after: ${wrap.title}` + "\n");
        if (count === 30) {
          const expand = getByText(language === 'zh' ? '展开全部 (30 行)' : 'Expand all (30 lines)');
          writeSync(1, `[${language}] toggle before: ${expand.outerHTML}` + "\n");
          fireEvent.click(expand);
          expect(expand.textContent).toBe(language === 'zh' ? '收起' : 'Collapse');
          writeSync(1, `[${language}] toggle after: ${expand.outerHTML}` + "\n");
          fireEvent.click(expand);
          expect(container.querySelector('[data-code-block-lines]')?.getAttribute('data-code-highlighted-lines')).toBe('0');
        }
      });
    }
  }

  it('updates the mounted header, wrap title and toggle when language changes', () => {
    const { container, getByTitle, getByText } = render(<CodeBlock language="ts" code={codeLines(30)} />);
    fireEvent.click(getByTitle('自动换行'));
    act(() => useAppStore.setState({ language: 'en' }));
    expect(container.querySelector('[data-code-block-lines] > div')?.textContent).toContain('30 lines');
    expect(getByTitle('Unwrap lines')).toBeTruthy();
    fireEvent.click(getByText('Expand all (30 lines)'));
    act(() => useAppStore.setState({ language: 'zh' }));
    expect(container.querySelector('[data-code-block-lines] > div')?.textContent).toContain('30 行');
    expect(getByTitle('取消换行')).toBeTruthy();
    expect(getByText('收起')).toBeTruthy();
  });

  it('renders the same 30-line content collapsed when it is not streaming', () => {
    const html = renderToStaticMarkup(
      React.createElement(CodeBlock, { language: 'ts', code: codeLines(30) }),
    );

    expect(html).toContain('展开全部 (30 行)');
    expect(html).toContain('data-code-preview="plain"');
    expect(html).toContain('data-code-block-lines="30"');
    expect(html).toContain('data-code-highlighted-lines="0"');
    expect(html).toContain('data-code-highlight-complete="true"');
    expect(html).toContain('line_25');
    expect(html).not.toContain('line_26');
    expect(html).not.toContain('line_30');
  });

  it('renders a 30-line streaming first frame expanded', () => {
    const html = renderToStaticMarkup(
      React.createElement(CodeBlock, { language: 'ts', code: codeLines(30), isStreaming: true }),
    );

    expect(html).toContain('data-code-block-lines="30"');
    expect(html).toContain('data-code-highlighted-lines="30"');
    expect(html).toContain('line_30');
  });

  it('stays expanded when streaming content crosses 25 lines', () => {
    const { container, rerender } = render(
      <CodeBlock language="ts" code={codeLines(25)} isStreaming />,
    );
    rerender(<CodeBlock language="ts" code={codeLines(30)} isStreaming />);

    expect(container.querySelector('[data-code-block-lines="30"]')?.getAttribute('data-code-highlighted-lines')).toBe('30');
    expect(container.textContent).toContain('line_30');
  });
});
