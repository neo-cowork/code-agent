import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type { Message } from '../../../src/shared/contract';
import { DatabaseService } from '../../../src/host/services/core/databaseService';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import {
  deriveFallbackSessionTitle,
  deriveRuleSummaryTitle,
  isProvisionalAutoTitle,
  resolveSessionTitle,
} from '../../../src/shared/sessionTitlePlaceholder';

const coreDatabase = vi.hoisted(() => ({ current: null as unknown }));
const quick = vi.hoisted(() => ({
  available: true,
  replies: [] as string[],
  prompts: [] as string[],
}));

vi.mock('../../../src/host/services/core', () => ({ getDatabase: () => coreDatabase.current }));
vi.mock('../../../src/host/services/auth/authService', () => ({ getAuthService: () => ({ getCurrentUser: () => null }) }));
vi.mock('../../../src/host/services/infra/supabaseService', () => ({ getSupabase: () => null, isSupabaseInitialized: () => false }));
vi.mock('../../../src/host/session/sessionCacheLifecycle', () => ({ clearSessionRuntimeCaches: vi.fn() }));
vi.mock('../../../src/host/model/quickModel', () => ({
  isQuickModelAvailable: () => quick.available,
  quickTask: async (prompt: string) => {
    quick.prompts.push(prompt);
    const reply = quick.replies.shift();
    return reply ? { success: true, content: reply } : { success: false, content: '' };
  },
}));
const ui = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/host/session/sessionTitleHostPrompt', async (orig) => ({
  ...(await orig<object>()),
  readUiLanguage: () => ui.language,
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { SessionManager } from '../../../src/host/services/infra/sessionManager';

const LOG = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const NOOP_LOG = { info: vi.fn(), warn: vi.fn() };
const ruleSummary = (source: string) =>
  resolveSessionTitle(source, 'zh', async () => ({ title: null, unavailable: true }), NOOP_LOG);
const FUNCTION_WORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'for', 'and', 'or', 'in', 'on', 'at',
  'with', 'by', 'from', 'into', 'about', 'as', 'is', 'are', 'be',
]);
const SAMPLE_MEAN = 'Write the sample-mean formula in LaTeX. Use single dollars for inline math.';

function assertReadableTitle(title: string): void {
  const words = title.split(' ').filter((word) => word.length > 0);
  const last = words[words.length - 1]?.replace(/\.+$/g, '').toLowerCase() ?? '';
  expect(FUNCTION_WORDS.has(last), title).toBe(false);
  const contentWords = words.filter((word) => !FUNCTION_WORDS.has(word.replace(/\.+$/g, '').toLowerCase()));
  expect(contentWords.length, title).toBeGreaterThanOrEqual(2);
}
/** 模型两次都给同一个标题：被接受 = 不是回声；被换成规则摘要 = 回声。 */
async function isEchoSessionTitle(title: string, source: string): Promise<boolean> {
  return (await resolveSessionTitle(source, 'zh', async () => ({ title }), NOOP_LOG)) !== title;
}

describe('echo check', () => {
  it.each([
    ['请分析这个 sales.csv：按地区汇总金额...', '请分析这个 sales.csv：按地区汇总金额，告诉我哪个地区最高', true],
    ['请分析这个 sales.csv：按地区汇总', '请分析这个 sales.csv：按地区汇总金额，告诉我哪个地区最高', true],
    ['销售数据按地区汇总', '请分析这个 sales.csv：按地区汇总金额，告诉我哪个地区最高', false],
    ['/init-memory', '/init-memory', false],
    ['你好呀', '你好呀', false],
    ['汇总销售表', '帮我汇总销售表', false],
    ['帮我汇总销售表格', '帮我汇总销售表格', false],
    ['帮我汇总华东地区销售表格', '帮我汇总华东地区销售表格', true],
  ])('%s', async (title, source, expected) => {
    expect(await isEchoSessionTitle(title, source)).toBe(expected);
  });
});

describe('rule summary', () => {
  it('strips zh request boilerplate and cuts at the first clause', async () => {
    expect(await ruleSummary('请帮我分析这个 sales.csv，按地区汇总金额')).toBe('分析这个 sales.csv');
    expect(await ruleSummary('帮我汇总销售表')).toBe('汇总销售表');
  });
  it('strips en boilerplate, never ends with ellipsis, max 20 chars', async () => {
    const out = await ruleSummary('Can you help me draft the weekly report about the release, thanks');
    expect(out).toBe('draft the weekly');
    expect(out.length).toBeLessThanOrEqual(20);
    expect(await ruleSummary('一二三四五六七八九十一二三四五六七八九十一二三四五')).toHaveLength(20);
  });

  it('quick model returned no title -> rule summary yields Write the sample-mean', async () => {
    const warn = vi.fn();
    const title = await resolveSessionTitle(
      SAMPLE_MEAN,
      'zh',
      async () => ({ title: null }),
      { info: vi.fn(), warn },
    );
    expect(warn).toHaveBeenCalledWith('quick model returned no title -> rule summary');
    expect(title).toBe('Write the sample-mean');
    assertReadableTitle(title);
  });

  it('quick model unavailable -> rule summary yields Write the sample-mean', async () => {
    const warn = vi.fn();
    const title = await resolveSessionTitle(
      SAMPLE_MEAN,
      'zh',
      async () => ({ title: null, unavailable: true }),
      { info: vi.fn(), warn },
    );
    expect(warn).toHaveBeenCalledWith('quick model unavailable -> rule summary');
    expect(title).toBe('Write the sample-mean');
    assertReadableTitle(title);
    const plan = await resolveSessionTitle(
      'Write the comprehensive plan for launch',
      'zh',
      async () => ({ title: null, unavailable: true }),
      NOOP_LOG,
    );
    expect(plan).toBe('Write the comprehensive');
    assertReadableTitle(plan);
  });

  it('retry still echo -> rule summary also avoids a function-word fragment', async () => {
    const echo = 'Write the sample-mean formula in LaTeX';
    const warn = vi.fn();
    const title = await resolveSessionTitle(
      SAMPLE_MEAN,
      'zh',
      async () => ({ title: echo }),
      { info: vi.fn(), warn },
    );
    expect(warn).toHaveBeenCalledWith('retry still echo -> rule summary', { title: echo });
    expect(title).toBe('Write the sample-mean');
  });

  it('a long run of function words then a very long word falls back within 53 chars', async () => {
    const source = `the a an of to for and or in on ${'Supercalifragilisticexpialidocious'.repeat(2)} explains the mean`;
    const title = await resolveSessionTitle(
      source,
      'zh',
      async () => ({ title: null }),
      NOOP_LOG,
    );
    expect(title).toBe(deriveFallbackSessionTitle(source, 'zh'));
    expect(title.length).toBeLessThanOrEqual(53);
    expect(title.endsWith('...')).toBe(true);
    const last = title.split(' ').pop()?.replace(/\.+$/g, '').toLowerCase() ?? '';
    expect(FUNCTION_WORDS.has(last), title).toBe(false);
  });

  it('a Chinese first sentence of 20+ chars stays exactly 20 chars', async () => {
    const source = '一二三四五六七八九十一二三四五六七八九十一二三四五';
    const expected = '一二三四五六七八九十一二三四五六七八九十';
    expect(await resolveSessionTitle(source, 'zh', async () => ({ title: null }), NOOP_LOG)).toBe(expected);
    expect(await ruleSummary(source)).toBe(expected);
    expect(expected).toHaveLength(20);
  });

  it('deriveRuleSummaryTitle without avoidFragment stays Write the for folder naming', () => {
    expect(deriveRuleSummaryTitle(SAMPLE_MEAN)).toBe('Write the');
    expect(deriveRuleSummaryTitle(SAMPLE_MEAN, 'zh')).toBe('Write the');
    expect(deriveRuleSummaryTitle(SAMPLE_MEAN, 'en', { avoidFragment: false })).toBe('Write the');
  });

  it('a model title that is literally Write the is left unchanged', async () => {
    const title = await resolveSessionTitle(
      SAMPLE_MEAN,
      'zh',
      async () => ({ title: 'Write the' }),
      NOOP_LOG,
    );
    expect(title).toBe('Write the');
  });
});

describe('isProvisionalAutoTitle for web pre-written short titles', () => {
  it('title identical to the first line is provisional; a renamed title is not', () => {
    expect(isProvisionalAutoTitle('帮我汇总销售表', '帮我汇总销售表')).toBe(true);
    expect(isProvisionalAutoTitle(' 帮我汇总  销售表 ', '帮我汇总 销售表\n更多')).toBe(true);
    expect(isProvisionalAutoTitle('我的销售表', '帮我汇总销售表')).toBe(false);
  });
});

describe('SessionManager.addMessage -> title update', () => {
  let tmpDir: string;
  let coreDb: DatabaseService;
  let conn: Database.Database;
  let manager: SessionManager;

  beforeEach(() => {
    quick.available = true;
    quick.replies = [];
    quick.prompts = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'title-echo-'));
    coreDb = new DatabaseService();
    conn = new Database(path.join(tmpDir, 'code-agent.db'));
    applySchema(conn, LOG as never);
    applySessionsMigrations(conn, LOG as never);
    Object.assign(coreDb as unknown as Record<string, unknown>, { db: conn, sessionRepo: new SessionRepository(conn) });
    coreDatabase.current = coreDb;
    manager = new SessionManager();
  });

  afterEach(async () => {
    await manager.dispose();
    try { coreDb.close(); } catch { /* noop */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function sendFirst(preTitle: string, text: string): Promise<string> {
    coreDb.createSessionWithId('title-session', { title: preTitle, modelConfig: { provider: 'zhipu', model: 'glm-5' } });
    manager.setCurrentSession('title-session');
    const msg: Message = { id: 'm1', role: 'user', content: text, timestamp: Date.now() };
    await manager.addMessage(msg);
    await vi.waitFor(async () => {
      expect((await manager.getSession('title-session'))?.title).not.toBe(preTitle);
    }, { timeout: 3000 });
    return (await manager.getSession('title-session'))!.title;
  }

  it('short prompt pre-written as full title still gets a summary title', async () => {
    quick.replies = ['销售表汇总'];
    expect(await sendFirst('帮我汇总销售表', '帮我汇总销售表')).toBe('销售表汇总');
  });

  it('echoing model title triggers one stricter retry', async () => {
    const text = '请分析这个 sales.csv：按地区汇总金额，告诉我哪个地区最高';
    quick.replies = ['请分析这个 sales.csv：按地区汇总金额', '销售数据地区汇总'];
    expect(await sendFirst(text.slice(0, 30) + '...', text)).toBe('销售数据地区汇总');
    expect(quick.prompts).toHaveLength(2);
    expect(quick.prompts[1]).toContain('Do NOT reuse');
    expect(quick.prompts[0]).not.toContain('Do NOT reuse');
  });

  it('retry still echo falls back to the rule summary', async () => {
    const text = '请分析这个 sales.csv：按地区汇总金额，告诉我哪个地区最高';
    quick.replies = ['请分析这个 sales.csv：按地区汇总金额', '请分析这个 sales.csv：按地区汇总'];
    expect(await sendFirst(text.slice(0, 30) + '...', text)).toBe('分析这个 sales.csv');
  });

  it('no quick model: rule summary, not a 50-char cut', async () => {
    quick.available = false;
    const text = '请帮我分析这个 sales.csv，按地区汇总金额并告诉我哪个地区最高，最好再给出同比变化';
    expect(await sendFirst(text.slice(0, 30) + '...', text)).toBe('分析这个 sales.csv');
  });

  it('no quick model: sample-mean prompt becomes Write the sample-mean', async () => {
    quick.available = false;
    expect(await sendFirst(SAMPLE_MEAN.slice(0, 30) + '...', SAMPLE_MEAN)).toBe('Write the sample-mean');
  });

  describe('/init-memory deterministic title', () => {
    async function sendInit(workingDirectory: string | undefined, preTitle = '/init-memory', text = '/init-memory'): Promise<string> {
      coreDb.createSessionWithId('init-session', { title: preTitle, workingDirectory, modelConfig: { provider: 'zhipu', model: 'glm-5' } });
      manager.setCurrentSession('init-session');
      await manager.addMessage({ id: 'm1', role: 'user', content: text, timestamp: Date.now() });
      await vi.waitFor(async () => {
        expect((await manager.getSession('init-session'))?.title).not.toBe(preTitle);
      }, { timeout: 3000 });
      return (await manager.getSession('init-session'))!.title;
    }

    beforeEach(() => { ui.language = 'zh'; quick.replies = ['会话记忆初始化指令说明']; });

    it('user-chosen folder: zh title carries the folder name, small model skipped', async () => {
      expect(await sendInit('/tmp/家庭账本项目')).toBe('初始化项目记忆 · 家庭账本项目');
      expect(quick.prompts).toHaveLength(0);
    });

    it('en UI uses the English template', async () => {
      ui.language = 'en';
      expect(await sendInit('/tmp/Family Ledger', '/init-memory --force', '/init-memory --force')).toBe('Set up project memory · Family Ledger');
    });

    it('system-assigned directory omits the folder part', async () => {
      const { getDefaultWorkDirectory } = await import('../../../src/host/config/configPaths');
      expect(await sendInit(getDefaultWorkDirectory())).toBe('初始化项目记忆');
    });

    it('a user-renamed session is never overwritten', async () => {
      coreDb.createSessionWithId('init-session', { title: '我的记忆', workingDirectory: '/tmp/家庭账本项目', modelConfig: { provider: 'zhipu', model: 'glm-5' } });
      manager.setCurrentSession('init-session');
      await manager.addMessage({ id: 'm1', role: 'user', content: '/init-memory', timestamp: Date.now() });
      await new Promise((r) => setTimeout(r, 300));
      expect((await manager.getSession('init-session'))!.title).toBe('我的记忆');
    });
  });
});
