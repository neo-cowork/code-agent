import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const language = vi.hoisted(() => ({ value: 'zh' as 'zh' | 'en' }));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: language.value } }) }),
}));
vi.mock('../../../src/host/services/infra/notificationHeldStore', () => ({
  readHeldFile: () => [],
  writeHeldFile: () => undefined,
}));

const RECORD_ID = '8441905e-ab86-4798-baff-18db4cb5a49a';

describe('NotificationService recorded finish notice (production route)', () => {
  beforeEach(() => {
    vi.stubEnv('CODE_AGENT_NOTIFICATION_DRY_RUN', '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['zh', '表格导出', '任务完成 - 表格导出'],
    ['en', 'Spreadsheet export', 'Task completed - Spreadsheet export'],
  ] as const)('drops the record id from the %s title instead of printing a placeholder', async (lang, name, expected) => {
    language.value = lang;
    vi.resetModules();
    const { notificationService: service } = await import('../../../src/host/services/infra/notificationService');
    service.notifyTaskComplete(
      { sessionId: 'session_1', sessionTitle: `${name} · ${RECORD_ID}`, summary: '', duration: 14000, toolsUsed: [] },
      { force: true },
    );
    const entry = service.getRecentNotifications().at(-1)!;
    expect(entry.title).toBe(expected);
    expect(entry.title).not.toMatch(/内部记录|internal record|[0-9a-f]{8}-[0-9a-f]{4}/i);
    if (lang === 'en') expect(`${entry.title}${entry.body}`).not.toMatch(/[㐀-鿿]/);
  });
});
