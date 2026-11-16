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
    expect(toolUserLabel('mcp__feishu__sendMessage')).toBe('外部工具'); // 目录里没有的 MCP server 仍是中性词
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
  it('英文界面给英文动作名', () => {
    expect(toolUserLabel('Bash', 'en')).toBe('Run command');
    expect(toolUserLabel('mcp__x__y', 'en')).toBe('External tool');
    expect(toolUserLabel('some_internal_tool_v2', 'en')).toBe('Action');
    expect(toolUserLabel('Grep')).toBe('搜索内容');
  });
  it('目录连接器（飞书）写入给「在飞书创建日程」，不露 mcp__ / lark / 参数名', () => {
    const tool = 'mcp__lark__calendar_v4_calendarEvent_create';
    expect(toolUserLabel(tool)).toBe('在飞书创建日程');
    expect(toolUserLabel(tool, 'en')).toBe('Create an event in Feishu');
    expect(permissionNoticeBody(tool)).toBe('需要授权：在飞书创建日程');
    for (const text of [toolUserLabel(tool), toolUserLabel(tool, 'en'), permissionNoticeBody(tool)]) {
      expect(text).not.toMatch(/mcp__|lark|start_time|start time/i);
    }
  });
  it('目录连接器认不出的动作退到「写入/读取 + 连接器名」，绝不回落原名', () => {
    expect(toolUserLabel('mcp__lark__weird_thing_do')).toBe('写入飞书');
    expect(toolUserLabel('mcp__lark__weird_thing_do', 'en')).toBe('Write to Feishu');
    expect(toolUserLabel('mcp__lark__bitable_v1_appTable_list')).toBe('读取飞书');
  });
  it('CLI/原生连接器标签不变', () => {
    expect(toolUserLabel('mail_send')).toBe('邮件：发送邮件');
    expect(toolUserLabel('mail_send', 'en')).toBe('Mail: send an email');
  });
});
