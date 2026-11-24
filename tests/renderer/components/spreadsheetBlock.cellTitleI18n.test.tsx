// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { SpreadsheetBlock } from '../../../src/renderer/components/features/chat/MessageBubble/SpreadsheetBlock';

// headerless：第一条 rows 即 xlsx 第 1 行，首个数据格拿 A1 引用（sheetCellRef 口径），
// 这样探针能钉死「A1 · Quarterly fee」这一整段 title，而不是含混的某段后缀。
const spec = JSON.stringify({
  sheets: [{ name: 'Sheet1', headers: ['Item'], rows: [['Quarterly fee']], rowCount: 1, headerless: true }],
});

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/;

function firstCellTitle(): string {
  return screen.getByText('Quarterly fee').getAttribute('title') ?? '';
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
});

describe('SpreadsheetBlock 单元格 hover title 走 i18n', () => {
  it('en + filePath：title 为 "A1 · Quarterly fee (click to give pinpoint feedback)"，无 CJK', () => {
    useAppStore.setState({ language: 'en' });
    render(<SpreadsheetBlock spec={spec} filePath="/tmp/fee.xlsx" />);
    const title = firstCellTitle();
    expect(title).toBe('A1 · Quarterly fee (click to give pinpoint feedback)');
    expect(title).not.toMatch(CJK_RE);
  });

  it('zh + filePath：title 保留「点选定点反馈」含义', () => {
    useAppStore.setState({ language: 'zh' });
    render(<SpreadsheetBlock spec={spec} filePath="/tmp/fee.xlsx" />);
    expect(firstCellTitle()).toBe('A1 · Quarterly fee（点选定点反馈）');
  });

  it('en + filePath：点选单元格后反馈条位置标签为 "Cell A1"', () => {
    useAppStore.setState({ language: 'en' });
    render(<SpreadsheetBlock spec={spec} filePath="/tmp/fee.xlsx" />);
    fireEvent.click(screen.getByText('Quarterly fee'));
    expect(screen.getByText(/Cell A1/).textContent).toContain('Cell A1');
  });

  it('无 filePath：title 只有单元格值，不带反馈后缀', () => {
    useAppStore.setState({ language: 'en' });
    render(<SpreadsheetBlock spec={spec} />);
    expect(firstCellTitle()).toBe('Quarterly fee');
  });
});
