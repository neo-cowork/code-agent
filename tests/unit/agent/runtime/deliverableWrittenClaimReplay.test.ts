// ============================================================================
// REST2 对照 5 次样本重放：老构建里回复措辞不命中声称动词 → DeliverableDiskCheck 命中 0。
// 夹具取自当时的 db-1.json（真实用户提示词、最终回复、Write 工具调用与结果行；
// 文件正文 try2–5 取自 c*-report.md，try1 由其后 Read 工具的回读输出还原），
// 走生产入口 runDeliverableDiskCheckGate。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const logInfo = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/host/services/infra/logger', () => ({
  logger: { info: logInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ info: logInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { runDeliverableDiskCheckGate } from '../../../../src/host/agent/runtime/deliverableDiskCheck';
import type { Message } from '../../../../src/shared/contract';

interface Sample {
  sample: string;
  userPrompt: string;
  userTs: number;
  writeCall: { id: string; name: string; arguments: Record<string, unknown> };
  writeCallTs: number;
  writeResult: Record<string, unknown> & { toolCallId: string };
  finalReply: string;
  finalTs: number;
  fileContent: string;
}

const samples = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures/rest2ControlSamples.json'), 'utf8'),
) as Sample[];

const root = path.join(os.tmpdir(), `rest2-replay-${process.pid}-${Date.now()}`);
const outDir = path.join(root, 'rr105out');
const wsDir = path.join(root, 'workspace');

beforeEach(() => {
  mkdirSync(outDir, { recursive: true });
  mkdirSync(wsDir, { recursive: true });
  logInfo.mockClear();
});
afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

const fill = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value).replaceAll('{{OUT}}', outDir).replaceAll('{{WS}}', wsDir)) as T;

function replayMessages(sample: Sample): Message[] {
  const call = fill(sample.writeCall);
  return [
    { id: 'u', role: 'user', content: fill(sample.userPrompt), timestamp: sample.userTs },
    {
      id: 'a1', role: 'assistant', content: '', timestamp: sample.writeCallTs,
      toolCalls: [call],
      toolResults: [fill(sample.writeResult)],
    } as unknown as Message,
    { id: 'f', role: 'assistant', content: fill(sample.finalReply), timestamp: sample.finalTs },
  ];
}

function replayGate(sample: Sample, repairsUsed: number) {
  writeFileSync(path.join(outDir, '本周周报.md'), sample.fileContent);
  const messages = replayMessages(sample);
  return runDeliverableDiskCheckGate({
    workingDirectory: wsDir,
    messages,
    finalText: fill(sample.finalReply),
    repairsUsed,
  });
}

describe('REST2 control samples replayed on the written-claim branch', () => {
  it('has all 5 samples', () => {
    expect(samples.map((s) => s.sample)).toEqual(['try1', 'try2', 'try3', 'try4', 'try5']);
  });

  it.each(samples.map((s) => [s.sample, s] as const))('%s: repair with budget left', async (_name, sample) => {
    const result = await replayGate(sample, 0);
    expect(result.action).toBe('repair');
    // 重放目录在 os.tmpdir() 下，/tmp 逃逸判据可能额外带出 none_produced（真跑路径不在 tmp），只断言占位项。
    const placeholder = result.missing.filter((m) => m.kind === 'placeholder');
    expect(placeholder).toHaveLength(1);
    expect(placeholder[0].claim.source).toBe('written');
    const event = logInfo.mock.calls.find(([, meta]) => (meta as { event?: string } | undefined)?.event === 'deliverable_written_claim_finding');
    expect(event).toBeDefined();
    expect((event?.[1] as { items: Array<{ kind: string; path: string }> }).items).toEqual([
      { kind: 'placeholder', path: path.join(outDir, '本周周报.md') },
    ]);
  });

  it.each(samples.map((s) => [s.sample, s] as const))('%s: budget spent -> note naming file and placeholder line', async (_name, sample) => {
    const result = await replayGate(sample, 99);
    expect(result.action).toBe('pass');
    if (result.action !== 'pass') return;
    expect(result.content).toContain('交付物核对说明');
    expect(result.content).toContain('本周周报.md');
    expect(result.content).toMatch(/第 \d+ 行/);
    expect(result.content).toMatch(/待补充|待填写/);
  });
});
