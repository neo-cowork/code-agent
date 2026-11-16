// @vitest-environment jsdom
// N-APPROVAL-CARD-USER-QUOTE-FU1-FIX-FU1-FU1-NAMES：目录连接器写入的审批卡预览只说连接器名与人话动作
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';

const state = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: state.language === 'zh' ? zh : en, language: state.language }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({ useAppStore: () => ({ language: state.language }) }));

import { RequestDetails } from '../../../src/renderer/components/PermissionDialog/RequestDetails';
import { describeApproval } from '../../../src/renderer/components/PermissionDialog/describeApproval';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import { classifyConnectorTool } from '../../../src/host/permissions/connectorToolAccess';
import { ConfirmationGate } from '../../../src/host/agent/confirmationGate';

const TOOL = 'mcp__lark__calendar_v4_calendarEvent_create';
const params = { start_time: '2026-11-17 10:00', summary: 'weekly sync', mood: 'happy' };

function hostShapedRequest(): PermissionRequest {
  const preview = new ConfirmationGate().buildPreview(TOOL, params);
  return {
    id: 'p1', sessionId: 's1', tool: TOOL, type: 'mcp', timestamp: 1,
    details: { server: 'lark', toolName: 'calendar_v4_calendarEvent_create', connectorAccess: classifyConnectorTool(TOOL)!, preview },
  } as PermissionRequest;
}

describe('catalog connector write approval preview', () => {
  it('host preview summary is the zh action phrase, not 执行工具 <raw name>', () => {
    expect(hostShapedRequest().details.preview?.summary).toBe('在飞书创建日程');
  });

  beforeEach(() => { state.language = 'zh'; });
  afterEach(cleanup);

  it.each(['zh', 'en'] as const)('shows catalog name + action, no raw names (%s)', (language) => {
    state.language = language;
    const request = hostShapedRequest();
    const { container } = render(<RequestDetails request={request} />);
    const text = [container.textContent, describeApproval(request, language === 'zh' ? zh : en, language).question].join('\n');
    process.stdout.write(`[${language}] ${JSON.stringify(text)}\n`);
    expect(text).toContain(language === 'zh' ? '开始时间' : 'Start time');
    expect(text).toContain('weekly sync');
    expect(text).toContain('happy'); // 未知参数只留值
    expect(text).not.toMatch(/mcp__|lark|start_time|end_time|mood/i);
    expect(text).not.toMatch(/start time/); // 机械去下划线的泄露形态（en 标签是首字母大写的 Start time）
  });
});

import { humanizeToolStep } from '../../../src/renderer/utils/humanizeToolStep';

describe('status bar step for catalog connector writes', () => {
  it.each([['zh', zh, '正在飞书创建日程'], ['en', en, 'Creating an event in Feishu']] as const)('running (%s)', (_l, t, expected) => {
    const text = humanizeToolStep(TOOL, params, t, undefined, 'running');
    process.stdout.write(`[step ${_l}] ${text}\n`);
    expect(text).toBe(expected);
  });
});
