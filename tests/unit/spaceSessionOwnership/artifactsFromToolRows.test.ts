// 落库形态：Write 的结果在后继 tool 行（assistant.toolCalls[].result 为空）——空间资产页仍要列出该文件。
import { describe, expect, it } from 'vitest';
import { buildProjectArtifacts } from '../../../src/host/services/project/projectService';

describe('buildProjectArtifacts with persisted tool-result rows', () => {
  it('lists a file written by Write when its result lives on the tool row', () => {
    const wd = '/tmp/neo-space-work/任务_x';
    const out = buildProjectArtifacts(
      [{ id: 's1', title: '周计划', workingDirectory: wd }],
      () => [
        { id: 'm1', role: 'user', content: '整理成 weekly-plan.md', timestamp: 1 },
        { id: 'm2', role: 'assistant', timestamp: 2, toolCalls: [{ id: 'c1', name: 'Write', arguments: { file_path: 'weekly-plan.md' } }] as never },
        { id: 'm3', role: 'tool', timestamp: 3, toolResults: [{ toolCallId: 'c1', success: true, output: 'Created file', outputPath: `${wd}/weekly-plan.md` }] as never },
      ],
    );
    expect(out.map((a) => a.path)).toContain(`${wd}/weekly-plan.md`);
  });
});
