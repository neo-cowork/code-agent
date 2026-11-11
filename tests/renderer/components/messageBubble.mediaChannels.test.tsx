import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MessageAttachment } from '../../../src/shared/contract';
import { AttachmentDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/AttachmentPreview';
import { useAppStore } from '../../../src/renderer/stores/appStore';

beforeEach(() => {
  useAppStore.setState({ language: 'zh' });
});

describe('MessageBubble media and channel affordances', () => {
  // N-FIX-ATTACHMENT-ONLY-SEND-MISSING-PROMPT-FU1：状态标签改经 i18n 渲染，
  // 不再对内部函数断言——统一走 AttachmentDisplay 渲染输出。
  // r1 复审：补回旧 getAttachmentMediaState 断言的行为语义——transcribing 徽标
  // 旋转（图标 animate-spin）、tone:'active'（text-badge-info）；materializationState
  // failed 徽标 tone:'danger'（text-badge-danger 红样式）。两个附件分开渲染，
  // 保证类名断言各自只来自对应徽标。
  it('normalizes attachment media lifecycle states', () => {
    const transcribingHtml = renderToStaticMarkup(
      React.createElement(AttachmentDisplay, {
        attachments: [
          {
            id: 'voice-1',
            name: 'voice.wav',
            type: 'file',
            category: 'audio',
            mimeType: 'audio/wav',
            path: '/tmp/voice.wav',
            size: 1024,
            mediaState: 'transcribing',
          },
        ] satisfies MessageAttachment[],
      }),
    );

    expect(transcribingHtml).toContain('voice.wav');
    expect(transcribingHtml).toContain('转写中');
    expect(transcribingHtml).toContain('animate-spin');
    expect(transcribingHtml).toContain('text-badge-info');

    const failedHtml = renderToStaticMarkup(
      React.createElement(AttachmentDisplay, {
        attachments: [
          {
            id: 'photo-1',
            name: 'photo.png',
            type: 'image',
            category: 'image',
            mimeType: 'image/png',
            path: '/tmp/photo.png',
            size: 1024,
            metadata: { materializationState: 'failed' },
          },
        ] satisfies MessageAttachment[],
      }),
    );

    expect(failedHtml).toContain('photo.png');
    expect(failedHtml).toContain('处理失败');
    expect(failedHtml).toContain('text-badge-danger');
  });

  it('renders visible attachment status badges', () => {
    const html = renderToStaticMarkup(
      React.createElement(AttachmentDisplay, {
        attachments: [
          {
            id: 'voice-1',
            name: 'voice.wav',
            type: 'file',
            category: 'audio',
            mimeType: 'audio/wav',
            path: '/tmp/voice.wav',
            size: 1024,
            mediaState: 'transcribing',
          },
        ] satisfies MessageAttachment[],
      }),
    );

    expect(html).toContain('voice.wav');
    expect(html).toContain('转写中');
  });

  it('renders retry affordance for failed channel media attachments', () => {
    const html = renderToStaticMarkup(
      React.createElement(AttachmentDisplay, {
        attachments: [
          {
            id: 'img-1',
            name: 'photo.png',
            type: 'image',
            category: 'image',
            mimeType: 'image/png',
            path: '/tmp/photo.png',
            size: 1024,
            mediaState: 'failed',
            metadata: {
              accountId: 'feishu-account',
              messageId: 'om_1',
              resourceType: 'image',
              platformFileKey: 'img_1',
            },
          },
        ] satisfies MessageAttachment[],
      }),
    );

    expect(html).toContain('处理失败');
    expect(html).toContain('重试');
  });
});
