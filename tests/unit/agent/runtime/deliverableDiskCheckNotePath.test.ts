// ============================================================================
// N-FIX-DELIVERABLE-DISK-CHECK-NOTE-ABSOLUTE-PATH — 用户可见「交付物核对说明」只显示
// 文件名 / 工作区相对路径，不外露机器绝对路径（家目录、临时根）。
// 全部走生产入口 runDeliverableDiskCheckGate，覆盖 appendUndeliveredNote 的两个调用方
// （用户批准豁免分支 / 补轮预算用尽分支）与四类缺漏（not_on_disk / empty / placeholder /
// markdown_residue），三种声称写法：工作区内绝对路径 / 工作区外绝对路径 / ~/ 家目录路径。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { runDeliverableDiskCheckGate } from '../../../../src/host/agent/runtime/deliverableDiskCheck';
import { writeMarkdownResidueDocx } from './artifactRenderReview.fixtures';
import type { Message } from '../../../../src/shared/contract';

const stamp = `${process.pid}-${Date.now()}`;
const workRoot = path.join(os.tmpdir(), `deliverable-note-path-ws-${stamp}`);
const outsideRoot = path.join(os.tmpdir(), `deliverable-note-path-out-${stamp}`);
const homeDirName = `.neo-note-path-test-${stamp}`;
const homeRoot = path.join(os.homedir(), homeDirName);

type Kind = 'not_on_disk' | 'empty' | 'placeholder' | 'markdown_residue';
type Style = 'abs-in-workspace' | 'abs-outside-workspace' | 'home-tilde';

const REASON: Record<Kind, string> = {
  not_on_disk: '文件不存在',
  empty: '文件为空',
  placeholder: '未替换的占位符',
  markdown_residue: '字面 Markdown 标记',
};

function userRequest(text: string): Message {
  return { id: 'user-1', role: 'user', content: text, timestamp: 1_700_000_000_000 };
}

function writeActivity(filePath: string, userApproved: boolean): Message {
  const metadata: Record<string, unknown> = { outputPath: filePath };
  if (userApproved) metadata.userApproved = true;
  return {
    id: `tool-${path.basename(filePath)}`,
    role: 'assistant',
    content: '',
    timestamp: 1_700_000_000_050,
    toolCalls: [{ id: `w-${path.basename(filePath)}`, name: 'Write', arguments: { file_path: filePath } }],
    toolResults: [{ toolCallId: `w-${path.basename(filePath)}`, success: true, output: 'ok', metadata }],
  };
}

async function prepare(kind: Kind, style: Style): Promise<{ dir: string; file: string; claimed: string; expectedName: string }> {
  const dir = style === 'abs-in-workspace' ? path.join(workRoot, 'reports')
    : style === 'abs-outside-workspace' ? outsideRoot
      : homeRoot;
  mkdirSync(dir, { recursive: true });
  const ext = kind === 'markdown_residue' ? 'docx' : kind === 'placeholder' ? 'md' : 'md';
  const file = path.join(dir, `weekly-${kind}.${ext}`);
  if (kind === 'empty') writeFileSync(file, '');
  else if (kind === 'placeholder') writeFileSync(file, '结论：待补充\n');
  else if (kind === 'markdown_residue') await writeMarkdownResidueDocx(file);
  const name = path.basename(file);
  const claimed = style === 'home-tilde' ? `~/${homeDirName}/${name}` : file;
  const expectedName = style === 'abs-in-workspace' ? `reports/${name}` : name;
  return { dir, file, claimed, expectedName };
}

/** 让「本 run 有产出活动」成立（推断声称要求），产物本身干净、不进缺漏账。 */
function cleanActivity(): Message {
  const other = path.join(workRoot, 'notes-clean.md');
  writeFileSync(other, '# 已完成的笔记\n\n正文内容完整。\n');
  return writeActivity(other, false);
}

function expectNoPathLeak(note: string): void {
  const body = note.slice(note.indexOf('⚠️ 交付物核对说明'));
  expect(body).not.toContain(os.homedir());
  expect(body).not.toContain('/Users/');
  expect(body).not.toContain(os.tmpdir());
  expect(body).not.toContain(homeDirName);
  expect(body).not.toContain('deliverable-note-path-');
  for (const line of body.split('\n')) {
    expect(line.startsWith('- /')).toBe(false);
    expect(line.startsWith('- ~')).toBe(false);
  }
}

beforeEach(() => {
  mkdirSync(workRoot, { recursive: true });
});

afterEach(() => {
  for (const dir of [workRoot, outsideRoot, homeRoot]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

const STYLES: Style[] = ['abs-in-workspace', 'abs-outside-workspace', 'home-tilde'];
const KINDS: Kind[] = ['not_on_disk', 'empty', 'placeholder', 'markdown_residue'];

describe('undelivered note never shows machine absolute paths', () => {
  describe('budget-exhausted branch (repairsUsed: 1)', () => {
    for (const style of STYLES) {
      for (const kind of KINDS) {
        it(`${kind} claimed as ${style} → file name / workspace-relative path only`, async () => {
          const { file, claimed, expectedName } = await prepare(kind, style);
          const messages = [userRequest(`整理成 ${path.basename(file)}`)];
          messages.push(kind === 'not_on_disk' ? cleanActivity() : writeActivity(file, false));
          const result = await runDeliverableDiskCheckGate({
            workingDirectory: workRoot,
            messages,
            finalText: `已生成 \`${claimed}\`，请查收。`,
            repairsUsed: 1,
          });
          expect(result.action).toBe('pass');
          if (result.action !== 'pass') throw new Error('expected pass');
          expect(result.missing.map((m) => m.kind)).toEqual([kind]);
          expect(result.content).toContain('⚠️ 交付物核对说明');
          expect(result.content).toContain(`- ${expectedName}（`);
          expect(result.content).toContain(REASON[kind]);
          expectNoPathLeak(result.content);
        });
      }
    }
  });

  describe('user-approved exemption branch (repairsUsed: 0)', () => {
    for (const style of STYLES) {
      for (const kind of ['placeholder', 'markdown_residue'] as const) {
        it(`${kind} claimed as ${style} → file name / workspace-relative path only`, async () => {
          const { file, claimed, expectedName } = await prepare(kind, style);
          const result = await runDeliverableDiskCheckGate({
            workingDirectory: workRoot,
            messages: [userRequest('整理成周报文件'), writeActivity(file, true)],
            finalText: `已生成 \`${claimed}\`，请查收。`,
            repairsUsed: 0,
          });
          // 豁免分支：预算未尽也直接 pass（走的是 exempt 调用方）。
          expect(result.action).toBe('pass');
          if (result.action !== 'pass') throw new Error('expected pass');
          expect(result.missing.map((m) => m.kind)).toEqual([kind]);
          expect(result.content).toContain(`- ${expectedName}（`);
          expect(result.content).toContain(REASON[kind]);
          expectNoPathLeak(result.content);
        });
      }
    }
  });

  it('relative claim and bare file name are shown unchanged', async () => {
    const result = await runDeliverableDiskCheckGate({
      workingDirectory: workRoot,
      messages: [userRequest('整理成 reports/a.md 和 b.md'), cleanActivity()],
      finalText: '已生成 `reports/a.md` 和 `b.md`，请查收。',
      repairsUsed: 1,
    });
    expect(result.action).toBe('pass');
    if (result.action !== 'pass') throw new Error('expected pass');
    expect(result.content).toContain('- reports/a.md（文件不存在）');
    expect(result.content).toContain('- b.md（文件不存在）');
    expectNoPathLeak(result.content);
  });
});
