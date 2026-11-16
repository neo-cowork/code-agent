// N-FIX-UI-RAW-TOOL-NAMES-EXPOSED：host 通知/收件箱不得把内部工具名、原始命令露给用户
import { describe, expect, it } from 'vitest';
import { permissionNoticeBody, toolUserLabel } from '../../../src/shared/utils/toolUserLabel';

describe('toolUserLabel', () => {
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
    const body = permissionNoticeBody('Bash');
    expect(body).toBe('需要授权：运行命令');
    expect(body).not.toMatch(/Bash|rm |npm/);
    expect(permissionNoticeBody('mail_send')).not.toContain('mail_send');
    expect(permissionNoticeBody(undefined)).toBe('请求执行权限');
  });
  it('通知动作名跟随界面语言，保留原有通知模板', () => {
    expect(permissionNoticeBody('Bash', 'en')).toContain('Run command');
    expect(permissionNoticeBody('Write', 'en')).toContain('Write file');
    expect(permissionNoticeBody('Edit', 'en')).toContain('Edit file');
    expect(permissionNoticeBody('Read', 'en')).toContain('Read file');
    expect(permissionNoticeBody('Bash')).toBe('需要授权：运行命令');
  });
  it('英文界面给英文动作名', () => {
    expect(toolUserLabel('Bash', 'en')).toBe('Run command');
    expect(toolUserLabel('mcp__x__y', 'en')).toBe('External tool');
    expect(toolUserLabel('some_internal_tool_v2', 'en')).toBe('Action');
    expect(toolUserLabel('Grep')).toBe('搜索内容');
  });
});
