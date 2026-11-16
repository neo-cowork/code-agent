// N-FIX-UI-RAW-TOOL-NAMES-EXPOSED：host 通知/收件箱不得把内部工具名、原始命令露给用户
import { describe, expect, it } from 'vitest';
import { permissionNotice, toolUserLabel } from '../../../src/shared/utils/toolUserLabel';

describe('toolUserLabel', () => {
  it.each([
    ['DocEdit', '编辑文档', 'Edit document'],
    ['excel_generate', '导出表格', 'Export spreadsheet'],
    ['docx_generate', '生成文档', 'Create document'],
    ['Bash', '运行命令', 'Run command'],
    ['mail_send', '邮件：发送', 'Mail: send an email'],
  ])('%s labels name the action in zh/en without tool ids', (tool, zh, en) => {
    expect(toolUserLabel(tool, 'zh')).toContain(zh);
    expect(toolUserLabel(tool, 'en')).toContain(en);
    for (const locale of ['zh', 'en'] as const) {
      expect(toolUserLabel(tool, locale)).not.toContain(tool);
    }
    expect(toolUserLabel(tool, 'en')).not.toMatch(/[\u3400-\u9fff]/);
  });
  it('unknown and missing tools keep generic localized approval copy', () => {
    expect(permissionNotice(undefined, 'en')).toEqual({ title: 'Approval needed', body: 'Review the proposed action.' });
    expect(permissionNotice('internal_tool', 'en').body).toBe('Approval needed: Action');
  });
  it('内置工具给动作名，不露原名', () => {
    expect(toolUserLabel('Bash')).toBe('运行命令');
    expect(toolUserLabel('Write')).toBe('写入文件');
    expect(toolUserLabel('web_fetch')).toBe('网页抓取');
  });
  it('连接器工具给连接器名，外部工具给「外部工具」，未知给「操作」', () => {
    expect(toolUserLabel('mail_send')).toContain('邮件');
    expect(toolUserLabel('mcp__feishu__sendMessage')).toBe('外部工具');
    expect(toolUserLabel('some_internal_tool_v2')).toBe('操作');
    expect(toolUserLabel(undefined)).toBe('操作');
  });
  it('授权通知正文只含动作，不含原始工具名或命令', () => {
    const body = permissionNotice('Bash', 'zh').body;
    expect(body).toBe('需要授权：运行命令');
    expect(body).not.toMatch(/Bash|rm |npm/);
    expect(permissionNotice('mail_send', 'zh').body).not.toContain('mail_send');
    expect(permissionNotice(undefined, 'zh').body).toBe('请求执行权限');
  });
  it('英文界面给英文动作名', () => {
    expect(toolUserLabel('Bash', 'en')).toBe('Run command');
    expect(toolUserLabel('mcp__x__y', 'en')).toBe('External tool');
    expect(toolUserLabel('some_internal_tool_v2', 'en')).toBe('Action');
    expect(toolUserLabel('Grep')).toBe('搜索内容');
  });
});
