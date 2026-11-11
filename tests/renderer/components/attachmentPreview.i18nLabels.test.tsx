// @vitest-environment jsdom
// N-FIX-ATTACHMENT-ONLY-SEND-MISSING-PROMPT-FU1：en 界面附件卡不再出现中文标签。
// 类型/状态/计数/汇总文案全部走 attachmentPreview i18n——en 下渲染各类附件卡
// 断言英文标签可见，且卡片文本不含任何 CJK（文件名刻意用 ASCII）。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AttachmentDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/AttachmentPreview';
import type { MessageAttachment } from '../../../src/shared/contract';
import { useAppStore } from '../../../src/renderer/stores/appStore';

beforeEach(() => {
  useAppStore.setState({ language: 'en' });
});

afterEach(cleanup);

const mediaCards: MessageAttachment[] = [
  {
    id: 'en-audio',
    name: 'voice-memo.wav',
    type: 'file',
    category: 'audio',
    mimeType: 'audio/wav',
    path: '/tmp/voice-memo.wav',
    size: 1024,
    mediaState: 'transcribing',
  },
  {
    id: 'en-video',
    name: 'standup-clip.mov',
    type: 'file',
    category: 'video',
    mimeType: 'video/quicktime',
    path: '/tmp/standup-clip.mov',
    size: 2048,
  },
  {
    id: 'en-archive',
    name: 'assets.zip',
    type: 'file',
    category: 'archive',
    mimeType: 'application/zip',
    size: 4096,
    archiveManifest: {
      format: 'zip',
      supported: true,
      totalFiles: 4,
      entries: [{ path: 'a.txt' }, { path: 'b.txt' }, { path: 'c.txt' }, { path: 'd.txt' }],
      dangerousEntries: ['../evil.sh'],
    },
  },
  {
    id: 'en-code',
    name: 'main.ts',
    type: 'file',
    category: 'code',
    mimeType: 'text/x-typescript',
    size: 256,
    language: 'typescript',
  },
  {
    id: 'en-data',
    name: 'metrics.json',
    type: 'file',
    category: 'data',
    mimeType: 'application/json',
    size: 512,
  },
];

describe('AttachmentDisplay en labels (N-FIX-ATTACHMENT-ONLY-SEND-MISSING-PROMPT-FU1)', () => {
  it('renders audio/video/archive/code/data cards with English labels and no CJK', () => {
    const { container } = render(<AttachmentDisplay attachments={mediaCards} />);

    // audio 卡：媒体生命周期徽标走 en 文案
    expect(screen.getByText('Transcribing')).toBeTruthy();
    // archive 卡：计数串走 en 文案（同一行内相邻文本节点，用子串断言）
    expect(screen.getByText('zip · 4 files')).toBeTruthy();
    expect(screen.getByText(/4 entries listed/)).toBeTruthy();
    expect(screen.getByText(/1 suspicious paths/)).toBeTruthy();
    // code / data 卡：类型标签走 en 文案
    expect(screen.getByText('Code')).toBeTruthy();
    expect(screen.getByText('Data')).toBeTruthy();
    // 视频卡渲染存在（无类型标签，仅名称+大小）
    expect(screen.getByText('standup-clip.mov')).toBeTruthy();

    // 只查可见文本：MediaAssetActionBar 的 title 提示（复制引用/更多）是另一组件的 i18n 债，不在本单范围
    expect(container.textContent).not.toMatch(/[一-鿿]/);
  });

  it('renders text/other cards with English type labels', () => {
    const { container } = render(
      <AttachmentDisplay
        attachments={[
          {
            id: 'en-text',
            name: 'notes.txt',
            type: 'file',
            category: 'text',
            mimeType: 'text/plain',
            size: 128,
          },
          {
            id: 'en-other',
            name: 'blob.bin',
            type: 'file',
            category: 'other',
            mimeType: 'application/octet-stream',
            size: 64,
          },
        ] satisfies MessageAttachment[]}
      />,
    );

    expect(screen.getByText('Text')).toBeTruthy();
    expect(screen.getByText('File')).toBeTruthy();
    // 只查可见文本：MediaAssetActionBar 的 title 提示（复制引用/更多）是另一组件的 i18n 债，不在本单范围
    expect(container.textContent).not.toMatch(/[一-鿿]/);
  });

  it('renders folder summary with English category labels and no CJK', () => {
    const folderFiles: MessageAttachment[] = [
      { ...mediaCards[0], id: 'f-audio', name: 'weekly-report/voice-memo.wav' },
      { ...mediaCards[1], id: 'f-video', name: 'weekly-report/standup-clip.mov' },
      { ...mediaCards[2], id: 'f-archive', name: 'weekly-report/assets.zip' },
      { ...mediaCards[3], id: 'f-code', name: 'weekly-report/main.ts' },
      { ...mediaCards[4], id: 'f-data', name: 'weekly-report/metrics.json' },
      {
        id: 'f-text',
        name: 'weekly-report/notes.txt',
        type: 'file',
        category: 'text',
        mimeType: 'text/plain',
        size: 128,
      },
    ];
    const { container } = render(<AttachmentDisplay attachments={folderFiles} />);

    // 折叠态（> FOLDER_SUMMARY_THRESHOLD=5）：识别出文件夹名时显示 📁 标题 + 分类汇总
    expect(screen.getByText('📁 weekly-report')).toBeTruthy();
    expect(screen.getByText(/1 Audio, 1 Video, 1 Archive, 1 Code, 1 Data, 1 Text/)).toBeTruthy();

    // 只查可见文本：MediaAssetActionBar 的 title 提示（复制引用/更多）是另一组件的 i18n 债，不在本单范围
    expect(container.textContent).not.toMatch(/[一-鿿]/);
  });

  it('shows the 📎 fallback count card for loose attachments and collapses in English', () => {
    const looseFiles: MessageAttachment[] = folderLooseFiles();
    const { container } = render(<AttachmentDisplay attachments={looseFiles} />);

    // 无共同文件夹前缀 → 📎 计数标题
    expect(screen.getByText('📎 6 files')).toBeTruthy();

    // 展开后：收起按钮走 en 文案，卡片本体渲染
    fireEvent.click(screen.getByText('📎 6 files'));
    expect(screen.getByText('Collapse 6 files')).toBeTruthy();
    expect(screen.getByText('Transcribing')).toBeTruthy();
    expect(screen.getByText('voice-memo.wav')).toBeTruthy();

    // 只查可见文本：MediaAssetActionBar 的 title 提示（复制引用/更多）是另一组件的 i18n 债，不在本单范围
    expect(container.textContent).not.toMatch(/[一-鿿]/);
  });
});

function folderLooseFiles(): MessageAttachment[] {
  return [
    { ...mediaCards[0], id: 'l-audio', name: 'voice-memo.wav' },
    { ...mediaCards[1], id: 'l-video', name: 'standup-clip.mov' },
    { ...mediaCards[2], id: 'l-archive', name: 'assets.zip' },
    { ...mediaCards[3], id: 'l-code', name: 'main.ts' },
    { ...mediaCards[4], id: 'l-data', name: 'metrics.json' },
    {
      id: 'l-text',
      name: 'notes.txt',
      type: 'file',
      category: 'text',
      mimeType: 'text/plain',
      size: 128,
    },
  ];
}
