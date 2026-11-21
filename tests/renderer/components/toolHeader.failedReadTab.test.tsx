// @vitest-environment jsdom
// 成功 Read + 失败 Read 并行：点开后两个 tab 必须各用各自文件名（真实 appStore，不 mock）。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ToolCall } from '../../../src/shared/contract';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/utils/featureFlags', () => ({
  isSemanticToolUIEnabled: () => false,
}));

import { ToolHeader } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolHeader';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const OK = '/work/attach/dogfood-upload-test.txt';
const MISSING = '/work/attach/dogfood-3752-并行检查.txt';

function call(id: string, path: string, success: boolean): ToolCall {
  return {
    id,
    name: 'Read',
    arguments: { file_path: path },
    result: { toolCallId: id, success, ...(success ? { output: 'x' } : { error: 'ENOENT' }) },
  } as ToolCall;
}

beforeEach(() => {
  useAppStore.setState({ previewTabs: [], workbenchTabs: [], activePreviewTabId: null } as never);
});
afterEach(cleanup);

describe('failed Read row opens its own tab', () => {
  it('success row then failed row -> two distinct tabs, each named after its own file', () => {
    const { unmount } = render(<ToolHeader toolCall={call('a', OK, true)} status="success" />);
    fireEvent.click(screen.getByTestId('tool-header-open-preview'));
    unmount();
    render(<ToolHeader toolCall={call('b', MISSING, false)} status="error" />);
    fireEvent.click(screen.getByTestId('tool-header-open-preview'));
    const tabs = useAppStore.getState().previewTabs;
    expect(tabs.map((t) => t.path)).toEqual([OK, MISSING]);
    expect(tabs.find((t) => t.id === useAppStore.getState().activePreviewTabId)?.path).toBe(MISSING);
  });
});
