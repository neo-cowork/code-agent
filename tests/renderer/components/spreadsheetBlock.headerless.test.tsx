// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SpreadsheetBlock } from '../../../src/renderer/components/features/chat/MessageBubble/SpreadsheetBlock';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { generativeUIEn } = await import('../../../src/renderer/i18n/generativeUI');
  return { useI18n: () => ({ t: generativeUIEn }) };
});

afterEach(cleanup);

it('renders both cells and accurate counts for a one-row workbook', () => {
  const spec = JSON.stringify({
    sheets: [{ name: 'Budget', headers: ['A', 'B'], rows: [['Quarterly fee', 1200]], rowCount: 1, headerless: true }],
    sheetCount: 1,
  });
  render(<SpreadsheetBlock spec={spec} filePath="/tmp/budget.xlsx" />);

  expect(screen.getByText('1 row · 2 columns')).toBeTruthy();
  const [, dataRow] = screen.getAllByRole('row');
  expect(within(dataRow).getByRole('cell', { name: 'Quarterly fee' }).getAttribute('title')).toMatch(/^A1 ·/);
  expect(within(dataRow).getByRole('cell', { name: (1200).toLocaleString() }).getAttribute('title')).toMatch(/^B1 ·/);
});
