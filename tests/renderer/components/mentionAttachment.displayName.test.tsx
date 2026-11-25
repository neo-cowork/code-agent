// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const lang = vi.hoisted(() => ({ current: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: lang.current === 'zh' ? zh : en, language: lang.current }) };
});
vi.mock('../../../src/renderer/components/design/designFiles', () => ({
  readWorkspaceFile: vi.fn(async () => 'hello'),
}));

import { buildMentionAttachment } from '../../../src/renderer/components/features/chat/ChatInput/mentionAttachment';
import {
  getAttachmentDisplayName,
  getCollisionHoverTitles,
} from '../../../src/renderer/components/features/chat/ChatInput/attachmentDisplayName';
import { InlineComposerChip } from '../../../src/renderer/components/features/chat/ChatInput/InlineComposerChip';
import { AttachmentDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/AttachmentPreview';
import type { MessageAttachment } from '../../../src/shared/contract/message';

afterEach(cleanup);

describe('buildMentionAttachment name', () => {
  it('name is the file name, path stays absolute', async () => {
    const att = await buildMentionAttachment({ path: '/tmp/x/y/a.txt', name: 'a.txt', workingDirectory: '/tmp/x' });
    expect(att.name).toBe('a.txt');
    expect(att.path).toBe('/tmp/x/y/a.txt');
  });
});

describe.each(['zh', 'en'] as const)('mention chip (%s)', (language) => {
  it('chip shows file name only, no absolute path', async () => {
    lang.current = language;
    const att = await buildMentionAttachment({ path: '/tmp/x/y/a.txt', name: 'a.txt', workingDirectory: '/tmp/x' });
    const { container } = render(
      <InlineComposerChip
        chip={{ key: `file:${att.id}`, kind: 'file', id: att.id, label: att.name, category: att.category }}
        onRemove={vi.fn()}
      />,
    );
    expect(container.textContent).toContain('a.txt');
    expect(container.textContent).not.toContain('/tmp');
    expect(container.innerHTML).not.toContain('/tmp');
  });
});

describe('collision hover titles', () => {
  it('same names get relative titles, distinct names none', () => {
    const titles = getCollisionHoverTitles([
      { id: '1', name: 'notes.txt', path: '/ws/week1/notes.txt' },
      { id: '2', name: 'notes.txt', path: '/ws/archive/notes.txt' },
      { id: '3', name: 'other.txt', path: '/ws/other.txt' },
      { id: '4', name: '/legacy/dir/z.txt', path: '/legacy/dir/z.txt' },
    ], '/ws');
    expect(titles.get('1')).toBe('week1/notes.txt');
    expect(titles.get('2')).toBe('archive/notes.txt');
    expect(titles.has('3')).toBe(false);
    expect(titles.has('4')).toBe(false);
  });

  it('outside workspace uses parent folder, never absolute', () => {
    const titles = getCollisionHoverTitles([
      { id: '1', name: 'n.txt', path: '/a/b/n.txt' },
      { id: '2', name: 'n.txt', path: '/c/d/n.txt' },
    ], '/ws');
    expect(titles.get('1')).toBe('b/n.txt');
    expect(titles.get('2')).toBe('d/n.txt');
  });

  it('chip renders title attribute', () => {
    const { container } = render(
      <InlineComposerChip chip={{ key: 'file:1', kind: 'file', id: '1', label: 'n.txt', title: 'week1/n.txt' }} onRemove={vi.fn()} />,
    );
    expect(container.querySelector('[data-inline-chip="file"]')?.getAttribute('title')).toBe('week1/n.txt');
  });
});

describe('AttachmentPreview with legacy absolute-path name', () => {
  const make = (over: Partial<MessageAttachment>): MessageAttachment => ({
    id: 'a', type: 'file', category: 'pdf', name: '/tmp/x/y/a.pdf', size: 1, mimeType: 'x', path: '/tmp/x/y/a.pdf', ...over,
  } as MessageAttachment);

  it('pdf row', () => {
    const { container } = render(<AttachmentDisplay attachments={[make({})]} />);
    expect(container.textContent).toContain('a.pdf');
    expect(container.textContent).not.toContain('/tmp');
  });
  it('image row', () => {
    const { container } = render(<AttachmentDisplay attachments={[make({ type: 'image', category: 'image', name: '/tmp/x/y/a.png', path: '/tmp/x/y/a.png', data: 'data:image/png;base64,aGk=' })]} />);
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('a.png');
  });
  it('csv row', () => {
    const { container } = render(<AttachmentDisplay attachments={[make({ type: 'file', category: 'data', name: '/tmp/x/y/a.csv', path: '/tmp/x/y/a.csv' })]} />);
    expect(container.textContent).toContain('a.csv');
    expect(container.textContent).not.toContain('/tmp');
  });
  it('folder-upload name unchanged', () => {
    expect(getAttachmentDisplayName('dir/f.txt')).toBe('dir/f.txt');
  });
});
