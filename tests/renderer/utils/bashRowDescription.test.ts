import { describe, expect, it } from 'vitest';
import { humanizeToolStep } from '../../../src/renderer/utils/humanizeToolStep';
import { toolPreflightCopy } from '../../../src/renderer/utils/toolPreflightPresentation';
import { buildToolStatusLineCopy } from '../../../src/renderer/utils/toolStatusLinePresentation';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import { AgentFailureCode, type ToolStepStatus } from '../../../src/shared/contract';

const STATUSES: ToolStepStatus[] = ['completed', 'running', 'pending-approval', 'failed'];

describe('Bash row uses the filtered model description', () => {
  it('zh: completed/running show the description alone; approval/failed follow the status phrase', () => {
    const args = { command: 'ls ~/Downloads', description: '列出下载文件夹' };
    expect(humanizeToolStep('Bash', args, zh, undefined, 'completed')).toBe('列出下载文件夹');
    expect(humanizeToolStep('Bash', args, zh, undefined, 'running')).toBe('列出下载文件夹');
    expect(humanizeToolStep('Bash', args, zh, undefined, 'pending-approval')).toBe('请求运行命令 · 列出下载文件夹');
    expect(humanizeToolStep('Bash', args, zh, undefined, 'failed')).toBe('运行命令未成功 · 列出下载文件夹');
  });

  it('en: same shape', () => {
    const args = { command: 'ls ~/Downloads', description: 'List the downloads folder' };
    expect(humanizeToolStep('Bash', args, en, undefined, 'completed')).toBe('List the downloads folder');
    expect(humanizeToolStep('Bash', args, en, undefined, 'running')).toBe('List the downloads folder');
    expect(humanizeToolStep('Bash', args, en, undefined, 'pending-approval')).toBe('Request to run a command · List the downloads folder');
    expect(humanizeToolStep('Bash', args, en, undefined, 'failed')).toBe('Could not run a command · List the downloads folder');
  });

  it('two Bash rows with different descriptions render differently', () => {
    const a = humanizeToolStep('Bash', { command: 'ls', description: '列出下载文件夹' }, zh);
    const b = humanizeToolStep('Bash', { command: 'ls | wc -l', description: '统计文件数量' }, zh);
    expect(a).not.toBe(b);
  });

  it.each([
    ['command-like', 'ls -la /tmp/example'],
    ['path', '查看 /tmp/example 目录'],
    ['home path', '列出 ~ 下的文件'],
    ['pipe', '列出文件 | 统计'],
    ['flag', '运行 --verbose 模式'],
    ['url', '下载 https://example.com/a'],
    ['wrong language (en in zh UI)', 'List the downloads folder'],
    ['too long', '列出下载文件夹里所有的文件并且统计每一种类型的数量再按大小排序然后输出前十个结果并保存'],
    ['multi-line', '列出下载\n文件夹'],
    ['raw tool name', '用 Bash 列出下载'],
    ['empty', '   '],
  ])('zh falls back for %s description', (_label, description) => {
    for (const status of STATUSES) {
      const withDesc = humanizeToolStep('Bash', { command: 'ls /tmp/example', description }, zh, undefined, status);
      const without = humanizeToolStep('Bash', { command: 'ls /tmp/example' }, zh, undefined, status);
      expect(withDesc).toBe(without);
    }
  });

  it('en UI rejects a Chinese description and the command first word', () => {
    expect(humanizeToolStep('Bash', { command: 'ls', description: '列出下载文件夹' }, en)).toBe('Ran a command');
    expect(humanizeToolStep('Bash', { command: 'git status', description: 'Run git' }, en)).toBe('Ran a command');
  });

  it('missing description and Run:-style shortDescription both fall back', () => {
    expect(humanizeToolStep('Bash', { command: 'ls src/' }, zh)).toBe('运行了一条命令');
    expect(humanizeToolStep('Bash', { command: 'ls src/' }, zh, 'Run: ls src/')).toBe('运行了一条命令');
    expect(humanizeToolStep('Bash', { command: 'ls src/' }, zh, '列出源码目录')).toBe('运行了一条命令');
  });

  it('only Bash/bash use the description', () => {
    expect(humanizeToolStep('terminal_write', { description: '列出下载文件夹' }, zh)).toBe('运行了一条命令');
    expect(humanizeToolStep('Process', { description: '列出下载文件夹' }, zh)).toBe('运行了一条命令');
  });

  it('the raw command never appears in any row text', () => {
    const command = 'find ~/Downloads -name "*.csv" | wc -l';
    for (const status of STATUSES) {
      for (const t of [zh, en]) {
        const text = humanizeToolStep('Bash', { command, description: t === zh ? '统计表格数量' : 'Count the csv files' }, t, `Run: ${command}`, status);
        expect(text).not.toContain('find');
        expect(text).not.toContain('Downloads');
      }
    }
  });
});

describe('blocked / interrupted Bash rows', () => {
  const denied = (args: Record<string, unknown>) => ({
    name: 'Bash',
    arguments: args,
    result: { toolCallId: 't1', success: false, error: 'denied', metadata: { failureCode: AgentFailureCode.PermissionDenied } },
  }) as unknown as Parameters<typeof toolPreflightCopy>[0];

  it('toolPreflightCopy appends the description after the blocked word', () => {
    const d = { command: 'ls ~', description: '统计表格数量' };
    const withDesc = toolPreflightCopy(denied(d), zh);
    const without = toolPreflightCopy(denied({ command: 'ls ~' }), zh);
    expect(withDesc?.action).toBe(`${without?.action} · 统计表格数量`);
    expect(toolPreflightCopy(denied({ command: 'ls ~', description: 'ls -la ~' }), zh)?.action).toBe(without?.action);
    expect(toolPreflightCopy(denied({ command: 'ls ~', description: 'Count csv files' }), en)?.action)
      .toBe(`${toolPreflightCopy(denied({ command: 'ls ~' }), en)?.action} · Count csv files`);
  });

  it('interrupted line carries a single terminal word plus the description', () => {
    const copy = buildToolStatusLineCopy({
      status: 'interrupted',
      toolCall: { name: 'Bash', arguments: { command: 'ls ~', description: '统计表格数量' } },
    } as unknown as Parameters<typeof buildToolStatusLineCopy>[0], zh);
    expect(copy.action).toBe('运行命令 · 统计表格数量');
    expect(copy.line.endsWith(' · 运行命令 · 统计表格数量')).toBe(true);
    expect(copy.line).not.toContain('未成功');
  });
});
