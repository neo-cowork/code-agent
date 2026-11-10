import { describe, expect, it } from 'vitest';
import type { MessageAttachment } from '../../../src/shared/contract';
import {
  buildMultimodalContent,
  stripImagesFromMessages,
} from '../../../src/host/agent/messageHandling/converter';

const image = (overrides: Partial<MessageAttachment> = {}): MessageAttachment => ({
  id: 'att-1',
  type: 'image',
  category: 'image',
  name: 'receipt.png',
  size: 128,
  mimeType: 'image/png',
  data: 'data:image/png;base64,aGVsbG8=',
  ...overrides,
});

const textOf = (content: ReturnType<typeof buildMultimodalContent>): string =>
  content.flatMap((part) => (part.type === 'text' && part.text ? [part.text] : [])).join('\n');

describe('image_analyze hint is self-sufficient (never leaves the model to Glob a tool name)', () => {
  it('image with a path: says image_analyze is deferred, how to load it, and not to search tool names', () => {
    const text = textOf(buildMultimodalContent('小票总额多少', [image({ path: '/tmp/receipt.png' })]));

    expect(text).toContain('image_analyze 是延迟加载的工具');
    expect(text).toContain('{"query":"select:image_analyze"}');
    expect(text).toContain('工具列表里没有 ToolSearch 或 image_analyze 时就不要找它');
    expect(text).toContain('绝不要用 Glob/Grep 搜索工具名');
  });

  it('stripped (non-vision) image text carries the same load instruction', () => {
    const content = buildMultimodalContent('小票总额多少', [image({ path: '/tmp/receipt.png' })]);
    const stripped = stripImagesFromMessages([{ role: 'user', content }]);
    const text = JSON.stringify(stripped[0].content);

    expect(text).toContain('image_analyze 是延迟加载的工具');
    expect(text).toContain('{\\"query\\":\\"select:image_analyze\\"}');
    expect(text).toContain('绝不要用 Glob/Grep 搜索工具名');
    expect(text).toContain('不要回答“没有收到图片”');
  });

  it('image without a path keeps the old guidance byte-identical and mentions no tool', () => {
    const content = buildMultimodalContent('看看这个', [image()]);

    expect(textOf(content)).toBe([
      '看看这个',
      '🖼️ 用户上传了图片: receipt.png',
      '如果当前模型不能直接看图，不要声称没收到图片；请说明需要可读取的本地图片路径。',
    ].join('\n'));
  });

  it('non-image attachment text is unchanged and never mentions ToolSearch', () => {
    const audio: MessageAttachment = {
      id: 'audio-1',
      type: 'file',
      category: 'audio',
      name: 'voice.mp3',
      size: 1024,
      mimeType: 'audio/mpeg',
      data: 'data:audio/mpeg;base64,AAAAAUDIO',
      path: '/tmp/voice.mp3',
    };
    const serialized = JSON.stringify(buildMultimodalContent('处理这个', [audio]));

    expect(serialized).not.toContain('ToolSearch');
    expect(serialized).not.toContain('image_analyze');
  });

  it('appshot image branch is untouched', () => {
    const content = buildMultimodalContent(
      '<appshot app="com.apple.finder" name="Finder">files</appshot>',
      [image({ id: 'appshot-1', name: 'Finder.png' })],
    );
    const serialized = JSON.stringify(content);

    expect(serialized).toContain('Appshot 截图');
    expect(serialized).not.toContain('ToolSearch');
    expect(serialized).not.toContain('image_analyze');
  });
});
