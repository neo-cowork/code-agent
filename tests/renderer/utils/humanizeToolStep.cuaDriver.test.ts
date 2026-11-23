import { describe, expect, it } from 'vitest';
import { humanizeToolStep } from '../../../src/renderer/utils/humanizeToolStep';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

// cua-driver（Computer Use 后端）的全部 25 个 MCP 工具名，与 src/host/mcp/cuaNarration.ts
// 的 switch、ToolCallDisplay CUA_TOOL_ICONS 对齐。仅本测试文件使用。
const CUA_DRIVER_TOOLS = [
  'click', 'double_click', 'right_click', 'type_text', 'set_value',
  'press_key', 'hotkey', 'scroll', 'move_cursor', 'drag',
  'launch_app', 'kill_app', 'bring_to_front', 'screenshot', 'zoom',
  'get_window_state', 'get_accessibility_tree', 'list_apps', 'list_windows', 'get_screen_size',
  'get_cursor_position', 'check_permissions', 'start_recording', 'stop_recording', 'replay_trajectory',
] as const;

const STATUSES = ['pending-approval', 'running', 'completed', 'failed'] as const;

const LANGUAGES = [
  ['zh', zh],
  ['en', en],
] as const;

describe('humanizeToolStep cua-driver MCP 工具（FB-2291）', () => {
  it('全部 25 个工具 × 4 个状态 × 中英：步骤行不出现 cua-driver / mcp__', () => {
    for (const tool of CUA_DRIVER_TOOLS) {
      for (const status of STATUSES) {
        for (const [lang, t] of LANGUAGES) {
          const line = humanizeToolStep(`mcp__cua-driver__${tool}`, {}, t, undefined, status);
          expect(line, `${tool}/${status}/${lang}: ${line}`).not.toContain('cua-driver');
          expect(line, `${tool}/${status}/${lang}: ${line}`).not.toContain('mcp__');
          expect(line.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('list_apps / launch_app 复用 computer 域既有措辞', () => {
    expect(humanizeToolStep('mcp__cua-driver__list_apps', {}, zh, undefined, 'completed'))
      .toBe('查看了电脑状态');
    expect(humanizeToolStep('mcp__cua-driver__launch_app', { app: '备忘录' }, zh, undefined, 'pending-approval'))
      .toBe('请求操作电脑');
    expect(humanizeToolStep('mcp__cua-driver__launch_app', { app: '备忘录' }, zh, undefined, 'completed'))
      .toBe('操作了电脑');
    expect(humanizeToolStep('mcp__cua-driver__click', { coordinates: [12, 34] }, zh, undefined, 'running'))
      .toBe('正在操作电脑');
    expect(humanizeToolStep('mcp__cua-driver__list_apps', {}, en, undefined, 'completed'))
      .toBe('Inspected computer state');
  });

  it('历史单下划线形态同样走 computer 域人话', () => {
    expect(humanizeToolStep('mcp_cua-driver_list_apps', {}, zh, undefined, 'completed'))
      .toBe('查看了电脑状态');
  });

  it('未知且 slug 带连字符的 server 走通用工具句，不拼 slug', () => {
    for (const status of STATUSES) {
      for (const [, t] of LANGUAGES) {
        const line = humanizeToolStep('mcp__totally-unknown-server__do_thing', {}, t, undefined, status);
        expect(line).not.toContain('totally-unknown-server');
        expect(line).not.toContain('mcp__');
      }
    }
    expect(humanizeToolStep('mcp__totally-unknown-server__do_thing', {}, zh, undefined, 'completed'))
      .toBe('执行了工具操作');
    expect(humanizeToolStep('mcp__totally-unknown-server__do_thing', {}, zh, undefined, 'pending-approval'))
      .toBe('请求执行工具操作');
  });

  it('解不动的 mcp__ 残名走中性兜底，不回原文', () => {
    const line = humanizeToolStep('mcp__', {}, zh, undefined, 'completed');
    expect(line).not.toContain('mcp__');
    expect(line).toBe('执行了工具操作');
    const enLine = humanizeToolStep('mcp__', {}, en, undefined, 'completed');
    expect(enLine).not.toContain('mcp__');
  });

  it('已知友好 server（含映射表里的连字符名）照旧展示', () => {
    expect(humanizeToolStep('mcp__github__create_issue', {}, zh)).toBe('通过 github 创建了内容');
    expect(humanizeToolStep('mcp__chrome-devtools__navigate_page', {}, zh)).toBe('调用了 chrome-devtools');
    // lark 命中目录连接器短句（早于本单新增的两条分支），措辞不变、同样不露 slug
    expect(humanizeToolStep('mcp__lark__calendar_v4_event_list', {}, zh)).toBe('已读取飞书');
  });
});
