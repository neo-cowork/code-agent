import { describe, expect, it } from 'vitest';
import { getToolDisplayName } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/utils';
import { getHumanToolLabel } from '../../../src/renderer/utils/toolHumanLabel';
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

const expectNoInternalName = (label: string, source: string): void => {
  expect(label, source).not.toContain('cua-driver');
  expect(label, source).not.toContain('mcp__');
};

describe('getToolDisplayName cua-driver / mcp__（FB-2291）', () => {
  it('双下划线与历史单下划线形态全部出人话名，不漏 cua-driver / mcp__', () => {
    for (const tool of CUA_DRIVER_TOOLS) {
      expectNoInternalName(getToolDisplayName(`mcp__cua-driver__${tool}`), `mcp__cua-driver__${tool}`);
      expectNoInternalName(getToolDisplayName(`mcp_cua-driver_${tool}`), `mcp_cua-driver_${tool}`);
    }
    expect(getToolDisplayName('mcp__cua-driver__list_apps')).toBe('Computer');
  });

  it('未知 server 出 Title Case 展示名，残名出中性词，永不回原文', () => {
    expect(getToolDisplayName('mcp__totally-unknown-server__do_thing')).toBe('Totally Unknown Server');
    expect(getToolDisplayName('mcp__')).toBe('Tool');
    expect(getToolDisplayName('mcp__cua-driver')).toBe('Tool');
  });

  it('已知 server 与历史单下划线行为不变', () => {
    expect(getToolDisplayName('mcp__exa__search')).toBe('Exa');
    expect(getToolDisplayName('mcp_exa_search')).toBe('Exa');
    expect(getToolDisplayName('mcp__github__create_issue')).toBe('GitHub');
    expect(getToolDisplayName('mcp__chrome-devtools__navigate_page')).toBe('Chrome DevTools');
    expect(getToolDisplayName('Bash')).toBe('Bash');
  });
});

describe('getHumanToolLabel cua-driver / mcp__（FB-2291）', () => {
  it('cua-driver 出语言感知的 Computer Use 人话名', () => {
    expect(getHumanToolLabel({
      toolName: 'mcp__cua-driver__list_apps',
      labels: zh.receiptPresentation.humanToolLabels,
    })).toBe('电脑操作');
    expect(getHumanToolLabel({
      toolName: 'mcp__cua-driver__launch_app',
      labels: en.receiptPresentation.humanToolLabels,
    })).toBe('Computer action');
    expect(getHumanToolLabel({
      toolName: 'mcp_cua-driver_screenshot',
      labels: zh.receiptPresentation.humanToolLabels,
    })).toBe('电脑操作');
  });

  it('残名与未知 server 不漏原文', () => {
    expect(getHumanToolLabel({
      toolName: 'mcp__',
      labels: zh.receiptPresentation.humanToolLabels,
    })).toBe('工具');
    expect(getHumanToolLabel({
      toolName: 'mcp__',
      labels: en.receiptPresentation.humanToolLabels,
    })).toBe('Tool');
    const label = getHumanToolLabel({
      toolName: 'mcp__totally-unknown-server__do_thing',
      labels: zh.receiptPresentation.humanToolLabels,
    });
    expectNoInternalName(label, 'mcp__totally-unknown-server__do_thing');
    expect(label).toBe('Totally Unknown Server');
  });

  it('已知 server / 既有工具键行为不变', () => {
    expect(getHumanToolLabel({
      toolName: 'mcp__exa__search',
      labels: zh.receiptPresentation.humanToolLabels,
    })).toBe('Exa');
    expect(getHumanToolLabel({
      toolName: 'Bash',
      labels: zh.receiptPresentation.humanToolLabels,
    })).toBe('Bash');
  });
});
