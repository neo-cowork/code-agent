// ============================================================================
// deliverableDiskCheck — written 来源声称：回复措辞无关，本 run 写出的文件照扫占位符
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

vi.mock('../../../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  collectDeliverableClaims,
  runDeliverableDiskCheckGate,
} from '../../../../src/host/agent/runtime/deliverableDiskCheck';
import { applyDeliverableCloseGates } from '../../../../src/host/agent/runtime/artifactRenderReview';
import { ArtifactState } from '../../../../src/host/agent/runtime/artifactState';
import type { Message } from '../../../../src/shared/contract';

const workRoot = path.join(os.tmpdir(), `deliverable-written-claim-${process.pid}-${Date.now()}`);

beforeEach(() => mkdirSync(workRoot, { recursive: true }));
afterEach(() => {
  if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true });
});

function user(content = '做一份周报，保存成文件'): Message {
  return { id: 'u1', role: 'user', content, timestamp: 1_700_000_000_000 };
}

function writes(absFiles: string[], metadata: Record<string, unknown> = {}): Message {
  // 相对路径 = 工作区产物（绝对的系统临时目录路径会被当成 /tmp 逃逸）
  const files = absFiles.map((file) => path.relative(workRoot, file));
  return {
    id: 'a1',
    role: 'assistant',
    content: '',
    timestamp: 1_700_000_000_050,
    toolCalls: files.map((file, i) => ({ id: `w${i}`, name: 'Write', arguments: { file_path: file } })),
    toolResults: files.map((file, i) => ({
      toolCallId: `w${i}`,
      success: true,
      output: 'ok',
      metadata: { outputPath: file, ...metadata },
    })),
  };
}

function reads(file: string): Message {
  return {
    id: 'a2',
    role: 'assistant',
    content: '',
    timestamp: 1_700_000_000_060,
    toolCalls: [{ id: 'r1', name: 'Read', arguments: { file_path: file } }],
    toolResults: [{ toolCallId: 'r1', success: true, output: '待补充' }],
  };
}

async function writeDocx(file: string, text: string): Promise<void> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

function gate(messages: Message[], finalText: string, repairsUsed = 0) {
  return runDeliverableDiskCheckGate({ workingDirectory: workRoot, messages, finalText, repairsUsed });
}

describe('written claim source', () => {
  it.each(['做好了，放在桌面 报告.docx', '已整理完毕'])('docx with placeholder, reply %s -> repair, then note', async (reply) => {
    const file = path.join(workRoot, '报告.docx');
    await writeDocx(file, '下周计划：待补充');
    const messages = [user(), writes([file])];
    const first = await gate(messages, reply);
    expect(first.action).toBe('repair');
    expect(first.missing.map((m) => m.kind)).toEqual(['placeholder']);
    const last = await gate(messages, reply, 99);
    expect(last.action).toBe('pass');
    if (last.action === 'pass') {
      expect(last.content).toContain('交付物核对说明');
      expect(last.content).toContain('报告.docx');
      expect(last.content).toContain('待补充');
    }
  });

  it('md with placeholder and no claim verb -> repair, then note', async () => {
    const file = path.join(workRoot, 'report.md');
    writeFileSync(file, '# 周报\n\n下周计划：待补充\n');
    const messages = [user(), writes([file])];
    expect((await gate(messages, '已整理完毕')).action).toBe('repair');
    const last = await gate(messages, '已整理完毕', 99);
    expect(last.action === 'pass' && last.content).toContain('交付物核对说明');
  });

  it('template request stays exempt', async () => {
    const file = path.join(workRoot, 'tpl.md');
    writeFileSync(file, '待补充\n');
    const result = await gate([user('帮我做个模板'), writes([file])], '好了');
    expect(result.action).toBe('pass');
    expect(result.missing).toEqual([]);
  });

  it('user-approved write: note only, no repair', async () => {
    const file = path.join(workRoot, 'report.md');
    writeFileSync(file, '下周计划：待补充\n');
    const result = await gate([user(), writes([file], { userApproved: true })], '做好了，放在桌面 report.md');
    expect(result.action).toBe('pass');
    expect(result.action === 'pass' && result.content).toContain('交付物核对说明');
  });

  it('a file only Read is never scanned', async () => {
    const file = path.join(workRoot, 'notes.md');
    writeFileSync(file, '待补充\n');
    const messages = [user(), writes([path.join(workRoot, 'other.ts')]), reads(file)];
    expect(collectDeliverableClaims({ messages, workingDirectory: workRoot, finalText: '好了' })).toEqual([]);
  });

  it('a written file deleted afterwards yields no not_on_disk; empty file also silent', async () => {
    const empty = path.join(workRoot, 'empty.md');
    writeFileSync(empty, '');
    const result = await gate([user('整理一下本周笔记'), writes([path.join(workRoot, 'gone.md'), empty])], '好了');
    expect(result.action).toBe('pass');
    expect(result.missing).toEqual([]);
  });

  it('non-scannable extensions are not claimed', () => {
    const messages = [user(), writes([path.join(workRoot, 'a.ts'), path.join(workRoot, 'b.png'), path.join(workRoot, 'c.md')])];
    const claims = collectDeliverableClaims({ messages, workingDirectory: workRoot, finalText: '好了' });
    expect(claims.map((c) => [path.basename(c.resolved), c.source])).toEqual([['c.md', 'written']]);
  });

  it('51+ written files do not crowd out a declared claim', async () => {
    const files = Array.from({ length: 60 }, (_, i) => path.join(workRoot, `f${i}.md`));
    const declaredFile = path.join(workRoot, 'declared.md');
    writeFileSync(declaredFile, '下周计划：待补充\n');
    const result = await gate([user(), writes(files)], '好了', 99).then(async () =>
      runDeliverableDiskCheckGate({
        workingDirectory: workRoot,
        messages: [user(), writes(files)],
        finalText: '好了',
        repairsUsed: 0,
        declaredDeliverables: { declaredAtMs: 1_700_000_000_100, finalArtifacts: [declaredFile] } as never,
      }));
    expect(result.action).toBe('repair');
    expect(result.check.claims[0].source).toBe('declared');
  });

  it('a path already claimed keeps its original source', () => {
    const file = path.join(workRoot, 'report.md');
    const claims = collectDeliverableClaims({
      messages: [user(), writes([file])],
      workingDirectory: workRoot,
      finalText: `已生成 \`${file}\``,
    });
    expect(claims.map((c) => c.source)).toEqual(['inferred']);
  });
});

describe('render review ignores written claims', () => {
  it('a written clean docx with a claim-free reply triggers no VLM call', async () => {
    const file = path.join(workRoot, 'clean.docx');
    await writeDocx(file, '本周完成了三项工作');
    const vlm = vi.fn(async () => '[]');
    const result = await applyDeliverableCloseGates({
      workingDirectory: workRoot,
      messages: [user(), writes([file])],
      finalText: '已整理完毕',
      diskRepairsUsed: 0,
      visualRepairsUsed: 0,
      artifact: ArtifactState.forTest(),
      deps: { vlm, libreOfficeAvailable: () => true, rasterize: async () => ['x.png'] },
    });
    expect(result.action).toBe('pass');
    expect(vlm).not.toHaveBeenCalled();
  });
});
