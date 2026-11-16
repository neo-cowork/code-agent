import { beforeEach, describe, expect, it, vi } from 'vitest';

const language = vi.hoisted(() => ({ value: 'zh' as string | undefined }));
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: language.value } }) }),
}));
vi.mock('../../../src/host/services/infra/logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger, createLogger: () => logger };
});

import { ConfirmationGate } from '../../../src/host/agent/confirmationGate';

const preview = (params: Record<string, unknown>) =>
  new ConfirmationGate().buildPreview('ProposeProjectMemory', params, { workspaceRoot: '/work/demo' })!;

describe('ProposeProjectMemory approval preview', () => {
  beforeEach(() => { language.value = 'zh'; });

  it.each([['purpose', '项目用途', 1], ['key-files', '重要文件', 2], ['conventions', '项目约定', 3]] as const)(
    'zh %s (%s) shows progress %i/3 across several cards', (topic, name, n) => {
      const p = preview({ topic, summary: 's', content: '内容' });
      expect(p.summary).toContain(name);
      expect(p.summary).toContain(`${n}/3`);
    });

  it.each([['purpose', 1], ['key-files', 2], ['conventions', 3]] as const)(
    'en shows %s progress %i/3 across several cards', (topic, n) => {
      language.value = 'en';
      expect(preview({ topic, content: 'x' }).summary).toContain(`(${n}/3)`);
    });

  it('shows content between 120 and the cap in full', () => {
    const content = '这个项目是一个命令行工具。'.repeat(30);
    expect(content.length).toBeGreaterThan(120);
    expect(preview({ topic: 'purpose', content }).diff).toBe(content);
  });

  it('cuts an over-long preview at a sentence boundary with an ellipsis, note and matching count', () => {
    const content = 'Run it with node src/index.js to start the server. '.repeat(60);
    const p = preview({ topic: 'purpose', content });
    const [body, note] = p.diff!.split('\n');
    expect(body.endsWith('.')).toBe(true);
    expect(body.endsWith('node src/index.')).toBe(false);
    expect(note).toContain('…');
    expect(note).toContain('设置 → 记忆');
    expect(note).toContain(`前 ${body.length} 字，共 ${content.trim().length} 字`);
  });

  it('en: never cuts mid-word and carries the Settings note', () => {
    language.value = 'en';
    const content = 'configuration '.repeat(200);
    const lines = preview({ topic: 'conventions', content }).diff!.split('\n');
    expect(lines[0].endsWith('configuration')).toBe(true);
    expect(lines[1]).toContain('Settings → Memory');
    expect(lines[1]).toContain(`first ${lines[0].length} of ${content.trim().length}`);
  });

  it('redacts secrets in the draft', () => {
    const p = preview({ topic: 'purpose', content: 'api_key=sk-abcdefghijklmnop1234567890 used' });
    expect(p.diff).not.toContain('abcdefghijklmnop1234567890');
  });

  it('unknown topic falls back to a plain summary without raw tokens', () => {
    const p = preview({ topic: 'other', content: 'hello' });
    expect(p.summary).toBe('保存一份项目记忆草稿');
    expect(p.diff).toBe('hello');
  });

  it('renderer-visible fields hold no raw tool/field tokens', () => {
    for (const lang of ['zh', 'en']) {
      language.value = lang;
      const text = JSON.stringify(preview({ topic: 'key-files', summary: 's', content: 'README.md: intro' }));
      expect(text).not.toContain('ProposeProjectMemory');
      expect(text).not.toContain('topic:');
      expect(text).not.toContain('content:');
    }
  });
});
