import { describe, expect, it } from 'vitest';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import { formatSessionTaskOutput } from '../../../src/renderer/utils/sessionTaskPresentation';

const rawStatus = [
  '1. 写稿 [running] id=session-work-running',
  '2. 校对 [completed] id=session-work-completed',
  '3. 发布 [failed] id=session-work-failed',
  '4. 归档 [cancelled] id=session-work-cancelled',
].join('\n');

const statusMetadata = {
  sessionTask: {
    outcome: 'status',
    tasks: [
      { shortName: '写稿', status: 'running' },
      { shortName: '校对', status: 'completed', detail: '已经核对' },
      { shortName: '发布', status: 'failed', detail: '服务暂时不可用' },
      { shortName: '归档', status: 'cancelled' },
    ],
  },
};

describe('sessionTaskPresentation', () => {
  it('renders structured running, completed, failed, and interrupted statuses in plain zh and en', () => {
    expect(formatSessionTaskOutput(statusMetadata, rawStatus, zh)).toBe([
      '写稿　进行中',
      '校对　已完成：已经核对',
      '发布　失败：服务暂时不可用',
      '归档　已中断',
    ].join('\n'));
    expect(formatSessionTaskOutput(statusMetadata, rawStatus, en)).toBe([
      '写稿　Running',
      '校对　Completed: 已经核对',
      '发布　Failed: 服务暂时不可用',
      '归档　Interrupted',
    ].join('\n'));
  });

  it('renders accepted, queued, and reused outcomes without model-facing ids or outcome tokens', () => {
    expect(formatSessionTaskOutput({
      sessionTask: { outcome: 'accepted', tasks: [{ shortName: '小测', status: 'running' }] },
    }, 'accepted raw id=session-work-a', zh)).toBe('已在后台开始：小测，完成后会告诉你。');
    expect(formatSessionTaskOutput({
      sessionTask: { outcome: 'queued', tasks: [{ shortName: '校对', status: 'queued' }] },
    }, 'queued raw id=session-work-b', en)).toBe('Queued: 校对. It will start automatically when its turn comes.');
    expect(formatSessionTaskOutput({
      sessionTask: { outcome: 'reused', tasks: [{ shortName: '写稿', status: 'running' }] },
    }, 'reused raw id=session-work-c', zh)).toBe('继续跟踪后台任务：写稿　进行中');
  });

  it('preserves replacement confirmation without exposing internal state or ids', () => {
    const metadata = { sessionTask: { outcome: 'accepted', tasks: [{ shortName: '简报', status: 'running' }] }, sessionTaskReplacement: { shortName: '周报', stopped: true } };
    expect(formatSessionTaskOutput(metadata, 'accepted id=session-work-x', zh)).toBe('已停止「周报」。已在后台开始：简报，完成后会告诉你。');
    expect(formatSessionTaskOutput(metadata, 'accepted id=session-work-x', en)).toContain('Stopped “周报”. ');
  });

  it('keeps result details and filenames without exposing the workspace prefix or raw file tools', () => {
    const metadata = { sessionTaskWorkspaceRoots: ['/work/My Project'], sessionTask: {
      outcome: 'status', tasks: [{ shortName: '报告', status: 'completed', detail: '已用 Read 核对，写入 /work/My Project/报告.md。' }],
    } };
    expect(formatSessionTaskOutput(metadata, '', zh)).toBe('报告　已完成：已用 读取文件 核对，写入 报告.md。');
    expect(formatSessionTaskOutput(metadata, '', en)).toBe('报告　Completed: 已用 Read file 核对，写入 报告.md。');
    expect(metadata.sessionTask.tasks[0].detail).toContain('/work/My Project/报告.md');
  });

  it('localizes background file actions without changing shared approval labels', () => {
    const metadata = { sessionTask: { outcome: 'status', tasks: [
      { shortName: '报告', status: 'completed', detail: 'Write 后用 Edit 修改。' },
    ] } };
    expect(formatSessionTaskOutput(metadata, '', zh)).toBe('报告　已完成：写入文件 后用 编辑文件 修改。');
    expect(formatSessionTaskOutput(metadata, '', en)).toBe('报告　Completed: Write file 后用 Edit file 修改。');
  });

  it('preserves the old raw output when sessionTask metadata is absent or invalid', () => {
    expect(formatSessionTaskOutput(undefined, rawStatus, zh)).toBe(rawStatus);
    expect(formatSessionTaskOutput({ sessionTask: { outcome: 'status', tasks: [] } }, rawStatus, en))
      .toBe(rawStatus);
  });

  it('hides the model-facing Agent ID suffix of background sub-agent rows (only and mixed with tasks), zh and en', () => {
    const only = '- coder ：进行中，已用时3 秒（Agent ID: agent_coder_123）\n没有剩余时间数据，请勿估算完成时间。';
    for (const t of [zh, en]) {
      const out = formatSessionTaskOutput({ sessionTask: { outcome: 'status', tasks: [] } }, only, t);
      expect(out).toContain('coder ：进行中，已用时3 秒');
      expect(out).not.toMatch(/Agent ID|agent_/);
    }
    const mixed = `1. 写稿：进行中\n${only}`;
    for (const t of [zh, en]) {
      const out = formatSessionTaskOutput(statusMetadata, mixed, t);
      expect(out).not.toMatch(/Agent ID|agent_/);
      const out2 = formatSessionTaskOutput({ sessionTask: { outcome: 'status', tasks: [{ shortName: '写稿', status: 'running' }] } }, mixed, t);
      expect(out2).not.toMatch(/Agent ID|agent_/);
    }
  });
});
