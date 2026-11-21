// @vitest-environment jsdom
// 成功 Read + 上传附件落在 /private/var/folders/... 临时目录：行 hover tooltip（title attr）
// 必须走 ToolHeader -> humanizeInternalText(buildToolHeaderTitle(...)) 整体改写成
// 「临时文件（文件名）」，不允许残留孤儿 "/private" 或 /var/ 绝对路径
// （N-FIX-HUMANIZE-TEMP-PATH-PRIVATE-PREFIX-LEFTOVER）。
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ToolCall } from '../../../src/shared/contract';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/utils/featureFlags', () => ({
  isSemanticToolUIEnabled: () => false,
}));

import { ToolHeader } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolHeader';

const TEMP_UPLOAD = '/private/var/folders/xx/yyyy/T/neo/uploads/dogfood-upload-test.txt';

function call(id: string, path: string): ToolCall {
  return {
    id,
    name: 'Read',
    arguments: { file_path: path },
    result: { toolCallId: id, success: true, output: 'x' },
  } as ToolCall;
}

afterEach(cleanup);

describe('successful Read row hover title for a /private/var/folders upload path', () => {
  it('row title shows 临时文件（文件名） with no /private or /var/ path left', () => {
    render(<ToolHeader toolCall={call('a', TEMP_UPLOAD)} status="success" />);
    const row = screen.getByTestId('tool-header-open-preview');
    const title = row.getAttribute('title');
    expect(title).toContain('临时文件（dogfood-upload-test.txt）');
    expect(title).not.toContain('/private');
    expect(title).not.toMatch(/\/var\//);
  });
});
