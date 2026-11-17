// @vitest-environment jsdom
// ============================================================================
// 全局记忆确认卡属性测试（production path）：
//   ToolExecutor.execute → requestDirectiveMemoryConfirmation → broadcast →
//   useMemoryLearning（MemoryLearningProvider）→ MemoryConfirmModal
// 两条不变量：(A) 将落盘的每个字符串叶子都在卡上；(B) 卡上没有任何标识符。
// ============================================================================
import React from 'react';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const bridge = vi.hoisted(() => ({
  listeners: new Map<string, (payload: unknown) => void>(),
  respond: undefined as undefined | ((id: string, confirmed: boolean) => boolean),
}));
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  getSchemas: vi.fn(),
  has: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('../../../src/host/platform/windowBridge', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/host/platform/windowBridge')>(),
  hasInteractiveUi: () => true,
  broadcastToRenderer: (channel: string, payload: unknown) => bridge.listeners.get(channel)?.(payload),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => true,
    on: (channel: string, cb: (payload: unknown) => void) => {
      bridge.listeners.set(channel, cb);
      return () => bridge.listeners.delete(channel);
    },
    invoke: async (_channel: string, payload: { id: string; confirmed: boolean }) => {
      bridge.respond?.(payload.id, payload.confirmed);
    },
  },
}));

vi.mock('../../../src/host/tools/protocolRegistry', () => ({
  getProtocolRegistry: () => ({ getSchemas: mocks.getSchemas, has: mocks.has, resolve: mocks.resolve }),
  isProtocolToolName: vi.fn(() => false),
  resetProtocolRegistry: vi.fn(),
}));
vi.mock('../../../src/host/tools/protocolToolRegistration', () => ({
  getProtocolToolSchemas: mocks.getSchemas,
  hasProtocolTool: mocks.has,
  resolveProtocolTool: mocks.resolve,
  registerProtocolTool: vi.fn(),
  unregisterProtocolTool: vi.fn(),
  setProtocolToolRegistryPort: vi.fn(),
}));
vi.mock('../../../src/host/services/cloud', () => ({ getCloudConfigService: () => ({ getAllToolMeta: () => ({}) }) }));
vi.mock('../../../src/host/mcp', () => ({
  getMCPClient: () => ({ getToolDefinitions: () => [], parseMCPToolName: () => null }),
}));
vi.mock('../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({
    isCacheable: () => false, get: () => null, set: vi.fn(),
    invalidateForPath: vi.fn(), invalidateForWorkspace: vi.fn(),
  }),
}));
vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { ToolExecutor } = await import('../../../src/host/tools/toolExecutor');
const { resetToolResolver } = await import('../../../src/host/tools/dispatch/toolResolver');
const { respondToDirectiveMemoryConfirmation, clearDirectiveMemoryConfirmationsForTest } =
  await import('../../../src/host/memory/directiveMemoryConfirmation');
const { memoryWriteSchema } = await import('../../../src/host/tools/modules/lightMemory/memoryWrite.schema');
const { writeSchema } = await import('../../../src/host/tools/modules/file/write.schema');
const { multiEditSchema } = await import('../../../src/host/tools/modules/file/multiEdit.schema');
const { bashSchema } = await import('../../../src/host/tools/modules/shell/bash.schema');
const { MemoryLearningProvider } = await import('../../../src/renderer/components/features/memory/MemoryLearningProvider');
const { useAppStore } = await import('../../../src/renderer/stores/appStore');

const docEditSchema = {
  name: 'DocEdit',
  description: 'edit a document',
  inputSchema: {
    type: 'object',
    properties: { file_path: { type: 'string' }, operations: { type: 'array' } },
    required: ['file_path'],
  },
  category: 'fs',
  permissionLevel: 'write',
  pathAuthority: [{ kind: 'path', pathParameter: 'file_path' }],
};
// 历史 legacy 平铺形状（Edit 注册 schema 要求 edits[]，平铺参数过不了入参校验，走 edit_file）
const legacyEditSchema = {
  name: 'edit_file',
  description: 'legacy flat edit',
  inputSchema: {
    type: 'object',
    properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
    required: ['file_path', 'old_string', 'new_string'],
  },
  category: 'fs',
  permissionLevel: 'write',
  pathAuthority: [{ kind: 'path', pathParameter: 'file_path', mutation: 'edit' }],
};
const mysterySchema = {
  name: 'MysteryTool',
  description: 'unknown shape',
  inputSchema: {
    type: 'object',
    properties: { destination: { type: 'string' }, mystery_field: { type: 'string' } },
    required: ['destination'],
  },
  category: 'fs',
  permissionLevel: 'write',
  pathAuthority: [{ kind: 'path', pathParameter: 'destination' }],
};

/** 控制字段：决定怎么写而不是写什么。MemoryWrite 的 filename 同属此类（卡上只用来推标题）。 */
const CONTROL_KEYS = new Set(['action', 'scope', 'type', 'replace_all']);

function leaves(value: unknown, skip: Set<string>, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.trim()) out.push(value);
  } else if (Array.isArray(value)) value.forEach((v) => leaves(v, skip, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) if (!skip.has(k)) leaves(v, skip, out);
  }
  return out;
}

let dataDir = '';
let memoryDir = '';
const originalDataDir = process.env.CODE_AGENT_DATA_DIR;

interface Case {
  label: string;
  tool: string;
  params: (dir: string) => Record<string, unknown>;
  expectZh?: string[];
  expectEn?: string[];
}

const CASES: Case[] = [
  {
    label: 'MemoryWrite write with description + name',
    tool: 'MemoryWrite',
    params: () => ({
      action: 'write', scope: 'global', type: 'directive', filename: 'lead_with_conclusion.md',
      content: 'Always lead with the conclusion in weekly reports, for all projects.',
      description: 'Weekly report structure rule. Keywords: report, weekly',
      name: 'Lead with the conclusion',
    }),
    expectZh: ['记住：'], expectEn: ['Remember: '],
  },
  {
    label: 'MemoryWrite overwrite of an existing file',
    tool: 'MemoryWrite',
    params: () => ({
      action: 'write', scope: 'global', type: 'directive', filename: 'existing_rule.md',
      content: 'Keep summaries under five lines.', description: 'Summary length', name: 'Short summaries',
    }),
    expectZh: ['这会替换一条已有的规则'], expectEn: ['This replaces an existing rule'],
  },
  {
    label: 'MemoryWrite delete with name',
    tool: 'MemoryWrite',
    params: () => ({ action: 'delete', scope: 'global', filename: 'old_rule.md', name: 'Old tone rule' }),
    expectZh: ['删除（归档）这条记忆：Old tone rule'], expectEn: ['Delete (archive) this memory: Old tone rule'],
  },
  {
    label: 'MemoryWrite delete without name (title derived from filename)',
    tool: 'MemoryWrite',
    params: () => ({ action: 'delete', scope: 'global', filename: 'weekly_report_lead.md' }),
    expectZh: ['weekly report lead'], expectEn: ['weekly report lead'],
  },
  {
    label: 'Bash heredoc into the memory dir',
    tool: 'Bash',
    params: (dir) => ({ command: `cat > ${dir}/rule.md <<'EOF'\nAlways answer in short paragraphs\nEOF` }),
  },
  {
    label: 'Write',
    tool: 'Write',
    params: (dir) => ({ file_path: `${dir}/note.md`, content: 'Prefer metric units in every report.' }),
  },
  {
    label: 'Edit with 2 edits',
    tool: 'Edit',
    params: (dir) => ({
      file_path: `${dir}/rule.md`,
      edits: [
        { old_text: 'five lines', new_text: 'three lines' },
        { old_text: 'formal tone', new_text: 'friendly tone', replace_all: true },
      ],
    }),
    expectZh: ['把「five lines」改成「three lines」'], expectEn: ["Change 'five lines' to 'three lines'"],
  },
  {
    label: 'Edit legacy old_string/new_string',
    tool: 'edit_file',
    params: (dir) => ({ file_path: `${dir}/rule.md`, old_string: 'monthly digest', new_string: 'weekly digest' }),
    expectEn: ["Change 'monthly digest' to 'weekly digest'"],
  },
  {
    label: 'DocEdit operations[]',
    tool: 'DocEdit',
    params: (dir) => ({
      file_path: `${dir}/guide.md`,
      operations: [
        { action: 'replace', find: 'old heading text', text: 'new heading text' },
        { action: 'insert', text: 'a brand new closing paragraph' },
      ],
    }),
  },
  {
    label: 'unknown tool with mystery_field',
    tool: 'MysteryTool',
    params: (dir) => ({ destination: `${dir}/mystery.md`, mystery_field: 'secret sauce value' }),
  },
];

const FORBIDDEN_PLAIN = [
  'memorywrite', 'directive', 'persistent memory', '{"', 'multiedit', 'edit_file', 'edit file', 'docedit', 'mysterytool',
  'operations', 'edits', 'old_text', 'new_text', 'old_string', 'new_string', 'file_path', 'mystery_field',
  'filename', 'replace_all',
];
const FORBIDDEN_WORDS = [/\bbash\b/i, /\bwrite\b/i, /\bedit\b/i];
const FORBIDDEN_KEY_SYNTAX = [/"(description|name|content|command|action|scope|type)"/i, /\b(content|command|action|scope)=/i];

async function renderCard(tool: string, params: Record<string, unknown>, language: 'zh' | 'en') {
  useAppStore.setState({ language });
  const view = render(<MemoryLearningProvider><div /></MemoryLearningProvider>);
  const executor = new ToolExecutor({ workingDirectory: '/tmp', requestPermission: vi.fn(async () => true) });
  executor.setAuditEnabled(false);
  const run = executor.execute(tool, params, { preApprovedTools: new Set([tool]) });
  const card = await screen.findByTestId('memory-confirm-view');
  const text = card.closest('.fixed')?.textContent ?? '';
  return { run, text, view };
}

describe('memory confirm card — production path property', () => {
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-card-'));
    memoryDir = path.join(dataDir, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'existing_rule.md'), 'old');
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    bridge.listeners.clear();
    bridge.respond = respondToDirectiveMemoryConfirmation;
    resetToolResolver();
    mocks.getSchemas.mockReturnValue([memoryWriteSchema, writeSchema, multiEditSchema, bashSchema, docEditSchema, legacyEditSchema, mysterySchema]);
    mocks.has.mockReturnValue(true);
    mocks.execute.mockReset().mockResolvedValue({ ok: true, output: 'written' });
    mocks.resolve.mockResolvedValue({ execute: mocks.execute });
  });

  afterEach(() => {
    cleanup();
    clearDirectiveMemoryConfirmationsForTest();
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  for (const language of ['zh', 'en'] as const) {
    describe(language, () => {
      for (const c of CASES) {
        it(`① every string leaf is visible, ② no identifiers: ${c.label}`, async () => {
          const params = c.params(memoryDir);
          const { run, text } = await renderCard(c.tool, params, language);

          const skip = new Set(CONTROL_KEYS);
          if (c.tool === 'MemoryWrite') skip.add('filename');
          // Edit 的 replace_all 之外都是内容；delete 无 name 时标题由 filename 推出，另行断言
          for (const leaf of leaves(params, skip)) {
            expect(text, `leaf not on card: ${JSON.stringify(leaf)}`).toContain(leaf);
          }
          for (const expected of (language === 'zh' ? c.expectZh : c.expectEn) ?? []) {
            expect(text).toContain(expected);
          }

          const lower = text.toLowerCase();
          for (const bad of FORBIDDEN_PLAIN) expect(lower, `identifier on card: ${bad}`).not.toContain(bad);
          for (const re of [...FORBIDDEN_WORDS, ...FORBIDDEN_KEY_SYNTAX]) expect(text, `identifier on card: ${re}`).not.toMatch(re);
          expect(text).not.toMatch(/\b(description|name|content|command):\s*$/im);
          if (language === 'en') expect(text).toContain('Confirm user rule');

          fireEvent.click(screen.getByRole('button', { name: language === 'en' ? /Skip/ : /跳过/ }));
          await act(async () => { await run; });
          expect(mocks.execute).not.toHaveBeenCalled();
        });
      }
    });
  }

  it('Confirm lets the write through (buttons unchanged)', async () => {
    const { run } = await renderCard('MemoryWrite', {
      action: 'write', scope: 'global', type: 'directive', filename: 'x.md', content: 'Use metric units.',
    }, 'en');
    fireEvent.click(screen.getByRole('button', { name: /Confirm Rule/ }));
    const result = await act(async () => run);
    expect(result).toMatchObject({ success: true });
    expect(IPC_CHANNELS.MEMORY_CONFIRM_REQUEST).toBeTruthy();
  });
});
