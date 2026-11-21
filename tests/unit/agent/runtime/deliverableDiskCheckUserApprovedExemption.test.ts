// ============================================================================
// N-FIX-DELIVERABLE-DISK-CHECK-FALSE-MISSING-DOUBLE-APPROVAL-REST1（realrun105 item 1）
// Owner decision B：用户本轮亲手批准写入的文件，正文残留（placeholder / markdown_residue）
// 不再触发补轮——批准即拍板，不重写、不重弹同一张审批卡；最终回复追加如实说明。
// 闸入口走生产 applyDeliverableCloseGates（不手搓 gate 替身），消息用真实 Message 形状。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const logInfo = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/host/services/infra/logger', () => ({
  logger: { info: logInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ info: logInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { applyDeliverableCloseGates } from '../../../../src/host/agent/runtime/artifactRenderReview';
import { sanitizeToolResultsForHistoryWithCalls } from '../../../../src/host/agent/messageHandling/converter';
import { writeMarkdownResidueDocx } from './artifactRenderReview.fixtures';
import type { Message } from '../../../../src/shared/contract';

const workRoot = path.join(os.tmpdir(), `deliverable-approved-exempt-${process.pid}-${Date.now()}`);

function userRequest(text: string): Message {
  return {
    id: 'user-1',
    role: 'user',
    content: text,
    timestamp: 1_700_000_000_000,
  };
}

/** 本 run 的写入工具结果。userApproved = toolExecutor 在真人审批放行时盖的 metadata 印。 */
function approvedWriteActivity(filePath: string, options: { userApproved?: boolean } = {}): Message {
  const metadata: Record<string, unknown> = { outputPath: filePath };
  if (options.userApproved !== undefined) metadata.userApproved = options.userApproved;
  return {
    id: `tool-${path.basename(filePath)}`,
    role: 'assistant',
    content: '',
    timestamp: 1_700_000_000_050,
    toolCalls: [{ id: `write-${path.basename(filePath)}`, name: 'Write', arguments: { file_path: filePath } }],
    toolResults: [{
      toolCallId: `write-${path.basename(filePath)}`,
      success: true,
      output: 'ok',
      metadata,
    }],
  };
}

async function runCloseGate(input: {
  finalText: string;
  messages: readonly Message[];
  deps?: Parameters<typeof applyDeliverableCloseGates>[0]['deps'];
}) {
  return applyDeliverableCloseGates({
    workingDirectory: workRoot,
    messages: input.messages,
    finalText: input.finalText,
    diskRepairsUsed: 0,
    visualRepairsUsed: 0,
    ...(input.deps ? { deps: input.deps } : {}),
  });
}

beforeEach(() => {
  mkdirSync(workRoot, { recursive: true });
  logInfo.mockClear();
});

afterEach(() => {
  if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true });
});

describe('applyDeliverableCloseGates user-approved placeholder exemption (realrun105)', () => {
  // realrun105 item-1 原样夹具：Write 已落盘的本周周报.md（下周计划一节留「待补充」），
  // final 声称已生成；历史里有用户批准过的 Write 结果。
  const WEEKLY_REPORT_TASK = '把 notes.txt 整理成本周周报，保存为 本周周报.md，下周计划那节留给我自己填，标上 待补充';

  function realrun105Messages(options: { userApproved?: boolean } = {}): Message[] {
    const artifact = path.join(workRoot, '本周周报.md');
    return [
      userRequest(WEEKLY_REPORT_TASK),
      approvedWriteActivity(artifact, options),
    ];
  }

  it('approved write + 待补充 residue → pass，回复末尾如实说明文件与占位符位置，不进补轮', async () => {
    const artifact = path.join(workRoot, '本周周报.md');
    writeFileSync(artifact, ['# 本周周报', '', '## 本周完成', '', '- 完成 A', '- 完成 B', '', '## 下周计划', '', '待补充', ''].join('\n'));

    const result = await runCloseGate({
      messages: realrun105Messages({ userApproved: true }),
      finalText: '已生成 `本周周报.md`，请查收。',
    });

    expect(result.action).toBe('pass');
    if (result.action !== 'pass') throw new Error('expected pass');
    // 回复末尾的如实说明：点名文件 + 占位符在哪（行号 + 片段），且只在正文之后追加。
    expect(result.content).toContain('⚠️ 交付物核对说明');
    expect(result.content).toContain('本周周报.md');
    expect(result.content).toContain('正文仍有未替换的占位符');
    expect(result.content).toContain('待补充');
    expect(result.content.indexOf('⚠️ 交付物核对说明')).toBeGreaterThan(result.content.indexOf('已生成'));
    // 不可信内容边界照旧：正文摘录进包络。
    expect(result.content).toContain('<untrusted-content source="deliverable-content"');
  });

  it('exemption logs reason + kind + path at info level, never silent', async () => {
    const artifact = path.join(workRoot, '本周周报.md');
    writeFileSync(artifact, '# 本周周报\n\n待补充\n');

    await runCloseGate({
      messages: realrun105Messages({ userApproved: true }),
      finalText: '已生成 `本周周报.md`。',
    });

    const exemptLog = logInfo.mock.calls.map(([message, payload]) => ({ message, payload }))
      .find((entry) => entry.payload?.event === 'deliverable_user_approved_write_exempt');
    expect(exemptLog).toBeDefined();
    expect(exemptLog?.message).toContain('user-approved write');
    expect(exemptLog?.payload.items).toEqual([{ kind: 'placeholder', path: artifact }]);
  });

  it('counter-example: same shape without the approval stamp still repairs', async () => {
    const artifact = path.join(workRoot, '本周周报.md');
    writeFileSync(artifact, '# 本周周报\n\n待补充\n');

    const result = await runCloseGate({
      messages: realrun105Messages(),
      finalText: '已生成 `本周周报.md`，请查收。',
    });

    expect(result.action).toBe('repair');
    if (result.action !== 'repair') throw new Error('expected repair');
    expect(result.kind).toBe('disk');
    expect(result.items).toEqual([{ kind: 'placeholder', path: artifact, location: expect.stringMatching(/第 \d+ 行/), fragment: '待补充' }]);
    expect(result.prompt).toContain('正文残留未替换的占位符');
  });

  it('counter-example: machine-approved write (no user stamp) still repairs', async () => {
    const artifact = path.join(workRoot, '本周周报.md');
    writeFileSync(artifact, '# 本周周报\n\n待补充\n');

    // 机器批准（session-allowlist / dev-auto-approve / 裸 boolean…）在 toolExecutor 不盖章，
    // 到闸这里就是「没有 userApproved 印的成功写入结果」。
    const result = await runCloseGate({
      messages: realrun105Messages({ userApproved: false }),
      finalText: '已生成 `本周周报.md`，请查收。',
    });

    expect(result.action).toBe('repair');
    if (result.action !== 'repair') throw new Error('expected repair');
    expect(result.items?.[0]).toMatchObject({ kind: 'placeholder', path: artifact });
  });

  it('approved write of a docx with literal Markdown residue → pass with honest note', async () => {
    const artifact = path.join(workRoot, 'marked.docx');
    await writeMarkdownResidueDocx(artifact);

    const result = await runCloseGate({
      messages: [
        userRequest('把会议纪要整理成 word 文档'),
        approvedWriteActivity(artifact, { userApproved: true }),
      ],
      finalText: '已生成 `marked.docx`，请查收。',
      // 渲染审查工具链不可用即跳过（本单只钉落盘闸的豁免分支）。
      deps: { libreOfficeAvailable: () => false },
    });

    expect(result.action).toBe('pass');
    if (result.action !== 'pass') throw new Error('expected pass');
    expect(result.content).toContain('⚠️ 交付物核对说明');
    expect(result.content).toContain('marked.docx');
    expect(result.content).toContain('字面 Markdown 标记');
  });

  it('approved-but-empty file still repairs (empty is never exempt)', async () => {
    const artifact = path.join(workRoot, 'blank.md');
    writeFileSync(artifact, '');

    const result = await runCloseGate({
      messages: [
        userRequest('整理成周报，存成 blank.md'),
        approvedWriteActivity(artifact, { userApproved: true }),
      ],
      finalText: '已生成 `blank.md`，请查收。',
    });

    expect(result.action).toBe('repair');
    if (result.action !== 'repair') throw new Error('expected repair');
    expect(result.items).toEqual([{ kind: 'empty', path: artifact }]);
  });

  it('approved-but-missing file still repairs (not_on_disk is never exempt)', async () => {
    // 批准的 Write 报过这个路径（盖了章），但文件现已不在盘上——真缺文件照旧补轮。
    const artifact = path.join(workRoot, 'gone.md');

    const result = await runCloseGate({
      messages: [
        userRequest('整理成周报，存成 gone.md'),
        approvedWriteActivity(artifact, { userApproved: true }),
      ],
      finalText: '已生成 `gone.md`，请查收。',
    });

    expect(result.action).toBe('repair');
    if (result.action !== 'repair') throw new Error('expected repair');
    expect(result.items).toEqual([{ kind: 'not_on_disk', path: artifact }]);
    expect(result.prompt).toContain('文件不存在');
  });

  it('mixed findings: repair prompt lists only the non-exempt item, exemption still logged', async () => {
    const approvedArtifact = path.join(workRoot, '本周周报.md');
    writeFileSync(approvedArtifact, '# 本周周报\n\n待补充\n');

    const result = await runCloseGate({
      messages: [
        userRequest('整理成本周周报.md 和 summary.md'),
        approvedWriteActivity(approvedArtifact, { userApproved: true }),
      ],
      finalText: '已生成 `本周周报.md` 和 `summary.md`。',
    });

    expect(result.action).toBe('repair');
    if (result.action !== 'repair') throw new Error('expected repair');
    // 修复提示只列未豁免的那条；豁免条目只在 info 日志里。
    expect(result.missing).toEqual([path.join(workRoot, 'summary.md')]);
    expect(result.items).toEqual([{ kind: 'not_on_disk', path: path.join(workRoot, 'summary.md') }]);
    expect(result.prompt).toContain('summary.md');
    expect(result.prompt).toContain('文件不存在');
    expect(result.prompt).not.toContain('本周周报.md（核验路径');
    expect(result.prompt).not.toContain('正文残留未替换的占位符');
    const exemptLog = logInfo.mock.calls.map(([message, payload]) => ({ message, payload }))
      .find((entry) => entry.payload?.event === 'deliverable_user_approved_write_exempt');
    expect(exemptLog?.payload.items).toEqual([{ kind: 'placeholder', path: approvedArtifact }]);
  });

  // ⑤ 印章从工具结果进闸的历史形状：toolExecutor 返回的结果经
  // sanitizeToolResultsForHistoryWithCalls（messageProcessor 落库进 Message.toolResults 的
  // 那一步）后 userApproved 印仍在，闸据此匹配豁免。
  it('userApproved stamp survives history sanitization into the message shape the gate reads', () => {
    const artifact = path.join(workRoot, '本周周报.md');
    const toolResults = [{
      toolCallId: 'write-本周周报.md',
      success: true,
      output: 'ok',
      metadata: { outputPath: artifact, userApproved: true },
    }] as unknown as import('../../../../src/shared/contract').ToolResult[];

    const sanitized = sanitizeToolResultsForHistoryWithCalls(toolResults, [
      { id: 'write-本周周报.md', name: 'Write', arguments: { file_path: artifact } },
    ]);

    expect(sanitized[0].metadata).toMatchObject({ outputPath: artifact, userApproved: true });
  });
});
