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
vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { SessionManager } from '../../../src/host/services/infra/sessionManager';

const LOG = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const NOOP_LOG = { info: vi.fn(), warn: vi.fn() };
const deriveRuleSummaryTitle = (source: string) =>
  resolveSessionTitle(source, 'zh', async () => ({ title: null, unavailable: true }), NOOP_LOG);
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
    expect(await deriveRuleSummaryTitle('请帮我分析这个 sales.csv，按地区汇总金额')).toBe('分析这个 sales.csv');
    expect(await deriveRuleSummaryTitle('帮我汇总销售表')).toBe('汇总销售表');
  });
  it('strips en boilerplate, never ends with ellipsis, max 20 chars', async () => {
    const out = await deriveRuleSummaryTitle('Can you help me draft the weekly report about the release, thanks');
    expect(out).toBe('draft the weekly');
    expect(out.length).toBeLessThanOrEqual(20);
    expect(await deriveRuleSummaryTitle('一二三四五六七八九十一二三四五六七八九十一二三四五')).toHaveLength(20);
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
});
