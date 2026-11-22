// N-FIX-DOCX ... FU1 rework: a finished background task whose Bash step wrote a .docx
// puts that file on backgroundTaskResult.artifacts (production entry: projectTerminalResult + bashModule).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '../../../../src/shared/contract';
import type { ToolContext, Logger } from '../../../../src/host/protocol/tools';

const harness = vi.hoisted(() => ({
  messages: [] as unknown[],
  added: [] as Array<{ sessionId: string; message: Message }>,
}));

vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getSession: async () => ({ messages: harness.messages }),
    addMessageToSession: async (sessionId: string, message: Message) => { harness.added.push({ sessionId, message }); },
  }),
}));
vi.mock('../../../../src/host/services/core/configService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
}));
vi.mock('../../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: () => Promise.resolve(null),
}));

import { projectTerminalResult } from '../../../../src/host/services/commandCenter/terminalResultProjection';
import type { SessionCommandTask } from '../../../../src/host/services/commandCenter/sessionCommandCenter';
import { bashModule } from '../../../../src/host/tools/modules/shell/bash';

function makeCtx(workingDir: string): ToolContext {
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { sessionId: 's1', workingDir, abortSignal: new AbortController().signal, logger, emit: () => void 0, policyEnforcer: null } as unknown as ToolContext;
}

describe('projectTerminalResult carries background-run file artifacts', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'bg-docx-')));
    harness.messages = [];
    harness.added = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const task = (createdAt: number) => ({
    id: 'session-work-1', sessionId: 's1', title: '纪要', shortName: '纪要do', createdAt, resultText: '已生成', summary: '已生成',
  }) as unknown as SessionCommandTask;

  it('puts the .docx written by a Bash step on backgroundTaskResult.artifacts', async () => {
    const createdAt = Date.now() - 1000;
    const script = join(dir, 'gen.cjs');
    writeFileSync(script, `const fs=require('fs');const d=require(${JSON.stringify(require.resolve('docx'))});
d.Packer.toBuffer(new d.Document({sections:[{children:[new d.Paragraph('minutes')]}]})).then(b=>fs.writeFileSync('minutes.docx',b));`);
    const bash = await (await bashModule.createHandler()).execute({ command: 'node gen.cjs' }, makeCtx(dir), async () => ({ allow: true }));
    expect(bash.ok).toBe(true);
    if (!bash.ok) return;
    harness.messages = [
      // foreground tool message (not part of the task run) must be ignored
      { id: 'fg', role: 'tool', isMeta: false, timestamp: createdAt + 1, toolResults: [{ toolCallId: 'x', success: true, metadata: { artifacts: [{ artifactId: 'fg', kind: 'document', role: 'deliverable', sourceTool: 'docx_generate', name: 'other.docx', path: '/elsewhere/other.docx' }] } }] },
      { id: 'bg', role: 'tool', isMeta: true, timestamp: createdAt + 10, toolResults: [{ toolCallId: 'call-bash', success: true, metadata: bash.meta }] },
    ];

    await projectTerminalResult(task(createdAt), 'completed');

    const result = harness.added[0].message.metadata?.backgroundTaskResult;
    console.log('BG_TASK_RESULT_ARTIFACTS', JSON.stringify(result?.artifacts));
    expect(result?.artifacts).toHaveLength(1);
    expect(result?.artifacts?.[0]).toMatchObject({ role: 'deliverable', label: 'minutes.docx', path: join(dir, 'minutes.docx') });
  });

  it('writes no artifacts field when the run produced no file', async () => {
    harness.messages = [{ id: 'bg', role: 'tool', isMeta: true, timestamp: Date.now(), toolResults: [{ toolCallId: 'c', success: true, metadata: {} }] }];
    await projectTerminalResult(task(Date.now() - 1000), 'completed');
    expect(harness.added[0].message.metadata?.backgroundTaskResult).not.toHaveProperty('artifacts');
  });
});
