// @vitest-environment jsdom
// ============================================================================
// N-WRITEBACK-EDIT —— 审批卡「改一改再发」编辑态（renderer 侧）
//   正向：改收件人 → 点「按修改后发送」→ IPC 第 5 参带改后的 updatedArgs
//   fail-closed：只改不点 / 收件人清空 / 编辑态按 y / 放弃修改 → IPC 零调用
//   呈现：查看态正文上屏、卡头是「发送邮件」不是「危险操作」
// ============================================================================
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { decisionCardEn } from '../../../src/renderer/i18n/decisionCard';

const state = vi.hoisted(() => ({ request: null as PermissionRequest | null, sessionId: null as string | null, language: 'zh' as 'zh' | 'en' }));
const readCalendarEvent = vi.hoisted(() => vi.fn());
const readReminder = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/connectors', () => ({
  getConnectorRegistry: () => ({
    get: (id: string) => ({ execute: id === 'reminders' ? readReminder : readCalendarEvent }),
  }),
}));

const invoke = vi.hoisted(() => vi.fn());
const setPendingPermissionRequest = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: state.language === 'en' ? en : zh, language: state.language }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: state.request,
    pendingPermissionSessionId: state.sessionId,
    setPendingPermissionRequest,
    language: state.language,
    setLanguage: () => {},
    cloudUIStrings: undefined,
  }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (value: { currentSessionId: string }) => unknown) => selector({ currentSessionId: 'session-current' }),
}));
vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => true, invoke },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { error: vi.fn() } }));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';
import { validateWritebackDraft } from '../../../src/renderer/components/PermissionDialog/WritebackFields';
import { calendarApprovalDetails } from '../../../src/host/tools/modules/connectors/calendarApprovalDetails';
import { applyRemindersDeletePreview, remindersApprovalDetails } from '../../../src/host/tools/modules/connectors/remindersApprovalDetails';
import { ConfirmationGate } from '../../../src/host/agent/confirmationGate';
import { EDITABLE_TOOL_FIELDS, applyEditedArgs } from '../../../src/shared/contract/permissionEdit';
import { releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';

// host 默认分支：details = {...params} + 透传字段；mail_send 是 write 级 ⇒ type file_write、risk high ⇒ danger
const request: PermissionRequest = {
  id: 'permission-mail-1',
  sessionId: 'request-session',
  tool: 'mail_send',
  type: 'file_write',
  forceConfirm: true,
  dangerLevel: 'danger',
  details: {
    subject: 'Q3 供应商对账单',
    to: ['li.wei@acme.com'],
    cc: ['finance@acme.com'],
    content: '李伟你好，\n附件是 Q3 对账单，请在周五前确认。',
    attachments: ['/Users/me/Q3.pdf'],
  } as PermissionRequest['details'],
  timestamp: 1,
};

const meetingRequest: PermissionRequest = {
  id: 'permission-tmeet-1',
  sessionId: 'request-session',
  tool: 'tmeetMeetingCreate',
  type: 'file_write',
  forceConfirm: true,
  details: {
    subject: 'quick meeting',
    start: '2026-08-26T09:00:00+08:00',
    end: '2026-08-26T09:30:00+08:00',
  } as PermissionRequest['details'],
  reason: '要在外部系统里写入（腾讯会议：创建会议），需要你确认',
  boundary: {
    id: 'connector.external_write',
    connectorName: '腾讯会议',
  },
  timestamp: 1,
};

const localMs = (hour: number, minute = 0) => new Date(2026, 7, 26, hour, minute).getTime();
const pad = (value: number) => String(value).padStart(2, '0');
const localIso = (date: Date) => {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
};
function changeDatetime(field: string, value: string) {
  const [date, time] = value.split('T');
  const [hour, minute] = time.split(':');
  const input = screen.getByTestId(`writeback-edit-${field}-date`) as HTMLInputElement;
  expect(input.type).toBe('date');
  fireEvent.change(input, { target: { value: date } });
  fireEvent.change(screen.getByTestId(`writeback-edit-${field}-time-hour`), { target: { value: hour } });
  fireEvent.change(screen.getByTestId(`writeback-edit-${field}-time-minute`), { target: { value: minute } });
}

function nativeRequest(
  id: string,
  tool: string,
  details: Record<string, unknown>,
  connectorName: string,
): PermissionRequest {
  return {
    id,
    sessionId: 'request-session',
    tool,
    type: 'file_write',
    forceConfirm: true,
    details: details as PermissionRequest['details'],
    boundary: { id: 'connector.external_write', connectorName },
    timestamp: 1,
  };
}

/** Button primitive 的 primary 变体标记（主按钮渐变底） */
const PRIMARY_MARK = 'from-primary-800';

const calendarCreateRequest = nativeRequest('permission-calendar-create', 'calendar_create_event', {
  calendar: '工作',
  title: '季度评审会',
  start_ms: localMs(9),
  end_ms: localMs(9, 30),
  location: '3F-01',
}, '日历');
const calendarUpdateRequest = nativeRequest('permission-calendar-update', 'calendar_update_event', {
  calendar: '工作',
  event_uid: 'event-uid-1',
  title: '季度评审会',
  start_ms: localMs(10),
  end_ms: localMs(10, 30),
  location: '3F-02',
}, '日历');
const remindersCreateRequest = nativeRequest('permission-reminders-create', 'reminders_create', {
  list: '工作',
  title: '提交评审纪要',
  notes: '附上行动项',
  remind_at_ms: localMs(15),
}, '提醒事项');
const remindersUpdateRequest = nativeRequest('permission-reminders-update', 'reminders_update', {
  list: '工作',
  reminder_id: 'reminder-1',
  title: '提交最终评审纪要',
  notes: '补上负责人',
  remind_at_ms: localMs(16),
}, '提醒事项');

function enterEdit() {
  fireEvent.click(screen.getByRole('button', { name: /修改后/ }));
}
const toInput = () => screen.getByTestId('writeback-edit-to') as HTMLInputElement;
const sendEdited = () => screen.getByRole('button', { name: '按修改后的内容发送' });

describe('PermissionCard · mail_send 改一改再发', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invoke.mockResolvedValue(undefined);
    state.language = 'zh';
    state.request = request;
    state.sessionId = 'session-current';
  });
  afterEach(() => {
    cleanup();
    releaseApprovalResponse(request.id);
    releaseApprovalResponse(meetingRequest.id);
    releaseApprovalResponse(calendarCreateRequest.id);
    releaseApprovalResponse(calendarUpdateRequest.id);
    releaseApprovalResponse(remindersCreateRequest.id);
    releaseApprovalResponse(remindersUpdateRequest.id);
    releaseApprovalResponse('permission-reminders-no-time');
    releaseApprovalResponse('permission-reminders-update-hidden-id');
    releaseApprovalResponse('permission-reminders-delete-hidden-id');
  });

  it('查看态：卡头是「发送邮件」，正文上屏，不再是危险命令红卡', () => {
    render(<PermissionCard />);
    expect(screen.getByText('发送邮件')).toBeTruthy();
    expect(screen.queryByText('危险操作')).toBeNull();
    expect(screen.getByTestId('writeback-view-content').textContent).toContain('请在周五前确认');
    expect(screen.getByText('发这封邮件给 li.wei@acme.com？')).toBeTruthy();
    expect(screen.getByRole('button', { name: /修改后发送/ })).toBeTruthy();
  });

  it('改收件人 → 按修改后发送 → IPC 带改后的 updatedArgs，response 是一次性 allow', async () => {
    render(<PermissionCard />);
    enterEdit();
    fireEvent.change(toInput(), { target: { value: 'li.wei@acme.com, zhang.min@acme.com' } });
    fireEvent.click(sendEdited());
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
        request.id,
        'allow',
        request.sessionId,
        {
          to: ['li.wei@acme.com', 'zhang.min@acme.com'],
          cc: ['finance@acme.com'],
          bcc: [],
          subject: 'Q3 供应商对账单',
          content: '李伟你好，\n附件是 Q3 对账单，请在周五前确认。',
        },
      );
    });
  });

  it('fail-closed：只改不点 → 不发；收件人清空 → 主按钮禁用且不发', async () => {
    render(<PermissionCard />);
    enterEdit();
    fireEvent.change(toInput(), { target: { value: 'zhang.min@acme.com' } });
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.change(toInput(), { target: { value: '' } });
    expect((sendEdited() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('必填')).toBeTruthy();
    expect(screen.queryByText('结束时间不能早于开始时间')).toBeNull();
    fireEvent.click(sendEdited());
    await new Promise((r) => setTimeout(r, 20));
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fail-closed：编辑态里按 y 不会把原稿发出去；放弃修改回查看态也不发', async () => {
    render(<PermissionCard />);
    enterEdit();
    fireEvent.keyDown(window, { key: 'y' });
    await new Promise((r) => setTimeout(r, 20));
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }));
    expect(screen.queryByTestId('writeback-edit-form')).toBeNull();
    expect(screen.getByTestId('writeback-fields-view')).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('不改直接「发送」→ IPC 不带第 5 参（走原参数，旧调用形状不变）', async () => {
    render(<PermissionCard />);
    fireEvent.click(screen.getByRole('button', { name: /^发送/ }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, request.id, 'allow', request.sessionId);
      expect(invoke.mock.calls[0]).toHaveLength(4);
    });
  });

  it('腾讯会议查看态摊开主题和时间，并显示外部写回边界', () => {
    state.request = meetingRequest;
    render(<PermissionCard />);

    expect(screen.getByText('创建腾讯会议')).toBeTruthy();
    expect(screen.getByText('创建会议「quick meeting」？')).toBeTruthy();
    expect(screen.getByText('数据与隐私详情')).toBeTruthy();
    expect(screen.getByTestId('writeback-view-subject').textContent).toBe('quick meeting');
    expect(screen.getByTestId('writeback-view-start').textContent).toContain('2026');
    expect(screen.getByTestId('writeback-view-end').textContent).toContain('2026');
    expect(screen.getByText('数据与隐私详情')).toBeTruthy();
    expect(screen.getByRole('button', { name: /修改后创建/ })).toBeTruthy();
  });

  it('默认值可改提示有中英文卡面文案', () => {
    expect(decisionCardEn.decisionCard.permission.writeback.tmeetWriteWarning)
      .toContain('“Edit, then create”');
  });

  it('腾讯会议改主题和本地时间后把 ISO updatedArgs 直达一次性 allow 通道', async () => {
    state.request = meetingRequest;
    render(<PermissionCard />);
    fireEvent.click(screen.getByRole('button', { name: /修改后创建/ }));
    fireEvent.change(screen.getByTestId('writeback-edit-subject'), { target: { value: 'product sync' } });
    const editedStart = new Date('2026-08-26T09:15:00+08:00');
    changeDatetime('start', `${editedStart.getFullYear()}-${pad(editedStart.getMonth() + 1)}-${pad(editedStart.getDate())}T${pad(editedStart.getHours())}:${pad(editedStart.getMinutes())}`);
    fireEvent.click(screen.getByRole('button', { name: '按修改后的内容创建' }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
        meetingRequest.id,
        'allow',
        meetingRequest.sessionId,
        {
          subject: 'product sync',
          start: localIso(editedStart),
          end: localIso(new Date('2026-08-26T09:30:00+08:00')),
        },
      );
    });
  });

  it.each([
    [calendarCreateRequest, '创建日历事件', ['calendar', 'title', 'start_ms', 'end_ms', 'location'], ['calendar']],
    [calendarUpdateRequest, '更新日历事件', ['calendar', 'title', 'start_ms', 'end_ms', 'location'], ['calendar', 'event_uid']],
    [remindersCreateRequest, '新建提醒', ['list', 'title', 'notes', 'remind_at_ms'], ['list']],
    [remindersUpdateRequest, '更新提醒', ['list', 'title', 'notes', 'remind_at_ms'], ['list', 'reminder_id']],
  ] as const)('%s：查看态字段齐全，标识只展示不出编辑控件', (native, expectedTitle, viewFields, readonlyFields) => {
    state.request = native;
    render(<PermissionCard />);

    expect(screen.getByText(expectedTitle)).toBeTruthy();
    for (const field of viewFields) {
      if (field === 'notes') {
        expect(screen.getByTestId('writeback-view-content')).toBeTruthy();
      } else {
        expect(screen.getByTestId(`writeback-view-${field}`)).toBeTruthy();
      }
    }

    enterEdit();
    const readonlyFieldNames = new Set<string>(readonlyFields);
    for (const field of viewFields) {
      if (!readonlyFieldNames.has(field)) {
        expect(screen.getByTestId(`writeback-edit-${field}`)).toBeTruthy();
      }
    }
    for (const field of readonlyFields) {
      expect(screen.queryByTestId(`writeback-edit-${field}`)).toBeNull();
    }
  });

  it.each(['zh', 'en'] as const)('%s: update names the event, labels calendar/title correctly, hides the ID, and allows the original args', async (language) => {
    state.language = language;
    state.request = calendarUpdateRequest;
    render(<PermissionCard />);
    const card = screen.getByTestId('permission-card');
    expect(card.textContent).toContain(language === 'zh' ? '更新日历事件「季度评审会」？' : 'Update calendar event “季度评审会”?');
    expect(screen.getByTestId('writeback-view-calendar').parentElement?.parentElement?.textContent)
      .toBe(`${language === 'zh' ? '日历' : 'Calendar'}工作`);
    expect(screen.getByTestId('writeback-view-title').parentElement?.parentElement?.textContent)
      .toBe(`${language === 'zh' ? '标题' : 'Title'}季度评审会`);
    expect(card.textContent).not.toMatch(/Event ID|事件 ID|event-uid-1/);
    expect(screen.queryByTestId('writeback-view-event_uid')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: language === 'zh' ? /^更新/ : /^Update/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, calendarUpdateRequest.id, 'allow', calendarUpdateRequest.sessionId,
    ));
    expect(invoke.mock.calls[0]).toHaveLength(4);
  });

  it.each(['zh', 'en'] as const)('%s: update reminder card lists list, title and time, and hides the reminder id', async (language) => {
    readReminder.mockResolvedValue({
      data: { id: 'rem-opaque-91', list: '工作', title: '交电费', completed: false, remindAtMs: localMs(8) },
    });
    const params = { list: '工作', reminder_id: 'rem-opaque-91', remind_at_ms: localMs(20) };
    const extra = await remindersApprovalDetails('reminders_update', params);
    state.language = language;
    state.request = nativeRequest('permission-reminders-update-hidden-id', 'reminders_update', { ...params, ...extra }, '提醒事项');
    render(<PermissionCard />);
    const card = screen.getByTestId('permission-card');
    expect(card.textContent).toContain(language === 'zh' ? '更新提醒「交电费」？' : 'Update reminder “交电费”?');
    expect(screen.getByTestId('writeback-view-list').textContent).toBe('工作');
    expect(screen.getByTestId('writeback-view-title').textContent).toBe('交电费');
    expect(screen.getByTestId('writeback-view-remind_at_ms').textContent).toContain('20');
    expect(card.textContent).not.toMatch(/rem-opaque-91|提醒 ID|Reminder ID|reminder_id/);
    expect(screen.queryByTestId('writeback-view-reminder_id')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: language === 'zh' ? /^更新/ : /^Update/ }));
    await waitFor(() => expect(invoke.mock.calls[0]).toHaveLength(4));
  });

  it.each(['zh', 'en'] as const)('%s: delete reminder card names the reminder and hides the id', async (language) => {
    readReminder.mockResolvedValue({
      data: { id: 'rem-opaque-91', list: '工作', title: '交电费', completed: false, remindAtMs: localMs(20) },
    });
    const params = { list: '工作', reminder_id: 'rem-opaque-91' };
    const preview = new ConfirmationGate().buildPreview('reminders_delete', params);
    const extra = await remindersApprovalDetails('reminders_delete', params);
    applyRemindersDeletePreview(preview, extra);
    state.language = language;
    state.request = {
      ...nativeRequest('permission-reminders-delete-hidden-id', 'reminders_delete', { ...params, ...extra, preview }, '提醒事项'),
      dangerLevel: 'danger',
    };
    render(<PermissionCard />);
    const card = screen.getByTestId('permission-card');
    const text = card.textContent ?? '';
    expect(text).toContain(language === 'zh' ? '删除提醒「交电费」？' : 'Delete reminder “交电费”?');
    expect(text).toContain('工作');
    expect(text).toContain('交电费');
    expect(text).not.toMatch(/List:|Title:|Remind At:/);
    if (language === 'zh') {
      expect(text).toContain('清单');
      expect(text).toContain('标题');
      expect(text).toContain('提醒时间');
    } else {
      expect(text).toContain('List');
      expect(text).toContain('Title');
      expect(text).toContain('Reminder time');
      expect(text).not.toContain('删除提醒');
    }
    expect(text).not.toMatch(/rem-opaque-91|提醒 ID|Reminder ID|reminder_id/);
  });

  it('a readonly internal id never renders, for reminders as well as calendar', () => {
    const marked: string[] = [];
    for (const [tool, fields] of Object.entries(EDITABLE_TOOL_FIELDS)) {
      const details: Record<string, unknown> = {};
      let visible = '';
      for (const field of fields) {
        if (field.readonly && field.internalId) {
          details[field.key] = 'INTERNAL-ID-SENTINEL';
          marked.push(`${tool}.${field.key}`);
          continue;
        }
        if (field.kind === 'string_list') {
          details[field.key] = ['visible-list-value'];
          visible = 'visible-list-value';
        } else if (field.kind === 'datetime') {
          details[field.key] = field.key.endsWith('_ms') ? localMs(9) : '2026-08-26T09:00:00+08:00';
        } else {
          details[field.key] = `visible-${field.key}`;
          visible = `visible-${field.key}`;
        }
      }
      state.request = nativeRequest(`permission-internal-${tool}`, tool, details, '清单');
      const view = render(<PermissionCard />);
      const text = screen.getByTestId('permission-card').textContent ?? '';
      expect(text, tool).not.toContain('INTERNAL-ID-SENTINEL');
      expect(text, tool).not.toMatch(/提醒 ID|Reminder ID|事件 ID|Event ID/);
      if (visible) expect(text, tool).toContain(visible);
      view.unmount();
      cleanup();
    }
    expect(marked).toEqual(['calendar_update_event.event_uid', 'reminders_update.reminder_id']);
  });

  it('host still rejects a rewritten reminder id', () => {
    const result = applyEditedArgs(
      'reminders_update',
      { list: '工作', reminder_id: 'rem-opaque-91', title: '交电费' },
      { reminder_id: 'other-id' },
    );
    expect(result.ok).toBe(false);
  });

  it('failed enrichment still renders a sparse update; editing time does not clear untouched title/location', async () => {
    state.request = { ...calendarUpdateRequest, details: {
      calendar: '工作', event_uid: 'event-uid-1', start_ms: localMs(10),
    } as PermissionRequest['details'] };
    render(<PermissionCard />);
    expect(screen.getByText('更新这个日历事件？')).toBeTruthy();
    expect(screen.getByTestId('permission-card').textContent).not.toMatch(/事件 ID|event-uid-1/);
    enterEdit();
    expect((screen.getByTestId('writeback-edit-title') as HTMLInputElement).value).toBe('');
    changeDatetime('start_ms', '2026-08-26T10:15');
    fireEvent.click(screen.getByRole('button', { name: '按修改后的内容更新' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, calendarUpdateRequest.id, 'allow', calendarUpdateRequest.sessionId,
      { start_ms: localMs(10, 15) },
    ));
  });

  it('update form is prefilled and an explicitly cleared location is sent', async () => {
    state.request = calendarUpdateRequest;
    render(<PermissionCard />);
    enterEdit();
    expect((screen.getByTestId('writeback-edit-title') as HTMLInputElement).value).toBe('季度评审会');
    expect((screen.getByTestId('writeback-edit-start_ms-time-hour') as HTMLSelectElement).value).toBe('10');
    fireEvent.change(screen.getByTestId('writeback-edit-location'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '按修改后的内容更新' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, calendarUpdateRequest.id, 'allow', calendarUpdateRequest.sessionId,
      { title: '季度评审会', start_ms: localMs(10), end_ms: localMs(10, 30), location: '' },
    ));
  });

  it.each(['zh', 'en'] as const)('%s: start-only outcome never renders a snapshot End before the proposed Start', async (language) => {
    state.language = language;
    const proposed = { calendar: 'Work', event_uid: 'event-uid-1', start_ms: localMs(16) };
    readCalendarEvent.mockResolvedValue({ data: {
      calendar: 'Work', title: 'Quarterly review', startAtMs: localMs(9), endAtMs: localMs(9, 30),
    } });
    state.request = { ...calendarUpdateRequest, details: {
      ...proposed, ...await calendarApprovalDetails('calendar_update_event', proposed),
    } as PermissionRequest['details'] };
    render(<PermissionCard />);
    expect(screen.getByTestId('writeback-view-start_ms').textContent).toContain('16:00');
    expect(screen.queryByTestId('writeback-view-end_ms')).toBeNull();
    expect(screen.getByTestId('permission-card').textContent).not.toMatch(/Event ID|事件 ID|event-uid-1/);
    fireEvent.click(screen.getByRole('button', { name: language === 'zh' ? /修改后更新/ : /Edit, then update/ }));
    expect((screen.getByTestId('writeback-edit-end_ms-date') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByTestId('writeback-edit-title'), { target: { value: 'Revised review' } });
    fireEvent.click(screen.getByRole('button', { name: language === 'zh' ? '按修改后的内容更新' : 'Update edited version' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, calendarUpdateRequest.id, 'allow', calendarUpdateRequest.sessionId,
      { start_ms: localMs(16), title: 'Revised review' },
    ));
  });

  it.each([8, 10])('end-only proposal at %s:30 requires an explicit start in the edit form', async (hour) => {
    const proposed = { calendar: 'Work', event_uid: 'event-uid-1', end_ms: localMs(hour, 30) };
    readCalendarEvent.mockResolvedValue({ data: {
      calendar: 'Work', title: 'Quarterly review', startAtMs: localMs(9), endAtMs: localMs(9, 30),
    } });
    state.request = { ...calendarUpdateRequest, details: {
      ...proposed, ...await calendarApprovalDetails('calendar_update_event', proposed),
    } as PermissionRequest['details'] };
    render(<PermissionCard />);
    expect(screen.queryByTestId('writeback-view-start_ms')).toBeNull();
    expect(screen.getByTestId('writeback-view-end_ms')).toBeTruthy();
    enterEdit();
    expect((screen.getByTestId('writeback-edit-start_ms-date') as HTMLInputElement).value).toBe('');
    changeDatetime('start_ms', '2026-08-26T08:00');
    fireEvent.click(screen.getByRole('button', { name: '按修改后的内容更新' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, calendarUpdateRequest.id, 'allow', calendarUpdateRequest.sessionId,
      { start_ms: localMs(8), end_ms: localMs(hour, 30) },
    ));
  });

  it.each([8, 16])('snapshot context: start-only move to %s:00 plus a title edit never sends the old end/location', async (hour) => {
    const proposed = { calendar: '工作', event_uid: 'event-uid-1', start_ms: localMs(hour) };
    readCalendarEvent.mockResolvedValue({ data: {
      calendar: '工作', title: '季度评审会', startAtMs: localMs(9), endAtMs: localMs(9, 30), location: 'Room 3',
    } });
    const snapshot = await calendarApprovalDetails('calendar_update_event', proposed);
    state.request = { ...calendarUpdateRequest, details: { ...proposed, ...snapshot } as PermissionRequest['details'] };
    render(<PermissionCard />);
    expect(screen.getByTestId('writeback-view-title').textContent).toBe('季度评审会');
    expect(screen.queryByTestId('writeback-view-end_ms')).toBeNull();
    enterEdit();
    expect((screen.getByTestId('writeback-edit-title') as HTMLInputElement).value).toBe('季度评审会');
    expect((screen.getByTestId('writeback-edit-end_ms-date') as HTMLInputElement).value)
      .toBe('');
    fireEvent.change(screen.getByTestId('writeback-edit-title'), { target: { value: '改后的评审会' } });
    const submit = screen.getByRole('button', { name: '按修改后的内容更新' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, calendarUpdateRequest.id, 'allow', calendarUpdateRequest.sessionId,
      { start_ms: localMs(hour), title: '改后的评审会' },
    ));
    const edited = applyEditedArgs('calendar_update_event', proposed, invoke.mock.calls[0][4]);
    expect(edited).toMatchObject({ ok: true, params: { ...proposed, title: '改后的评审会' } });
    if (edited.ok) {
      expect(edited.params).not.toHaveProperty('end_ms');
      expect(edited.params).not.toHaveProperty('location');
    }
  });

  it('snapshot context: untouched prefilled title/times/location are omitted while explicit clearing is preserved', async () => {
    const proposed = { calendar: '工作', event_uid: 'event-uid-1', title: '新标题' };
    readCalendarEvent.mockResolvedValue({ data: {
      calendar: '工作', title: '旧标题', startAtMs: localMs(9), endAtMs: localMs(9, 30), location: 'Room 3',
    } });
    state.request = { ...calendarUpdateRequest, details: {
      ...proposed, ...await calendarApprovalDetails('calendar_update_event', proposed),
    } as PermissionRequest['details'] };
    render(<PermissionCard />);
    enterEdit();
    fireEvent.change(screen.getByTestId('writeback-edit-location'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '按修改后的内容更新' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, calendarUpdateRequest.id, 'allow', calendarUpdateRequest.sessionId,
      { title: '新标题', location: '' },
    ));
  });

  it('snapshot context: editing the displayed end explicitly supplies its current start and still validates the range', async () => {
    const proposed = { calendar: '工作', event_uid: 'event-uid-1', title: '新标题' };
    readCalendarEvent.mockResolvedValue({ data: {
      calendar: '工作', title: '旧标题', startAtMs: localMs(9), endAtMs: localMs(9, 30), location: 'Room 3',
    } });
    state.request = { ...calendarUpdateRequest, details: {
      ...proposed, ...await calendarApprovalDetails('calendar_update_event', proposed),
    } as PermissionRequest['details'] };
    render(<PermissionCard />);
    enterEdit();
    changeDatetime('end_ms', '2026-08-26T08:45');
    expect((screen.getByRole('button', { name: '按修改后的内容更新' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('结束时间不能早于开始时间')).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
    changeDatetime('end_ms', '2026-08-26T10:15');
    fireEvent.click(screen.getByRole('button', { name: '按修改后的内容更新' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, calendarUpdateRequest.id, 'allow', calendarUpdateRequest.sessionId,
      { title: '新标题', start_ms: localMs(9), end_ms: localMs(10, 15) },
    ));
  });

  it('日历创建改本地时间后回传 Unix ms，calendar 标识不进入 updatedArgs', async () => {
    state.request = calendarCreateRequest;
    render(<PermissionCard />);
    enterEdit();
    changeDatetime('start_ms', '2026-08-26T09:15');
    fireEvent.click(screen.getByRole('button', { name: '按修改后的内容创建' }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
        calendarCreateRequest.id,
        'allow',
        calendarCreateRequest.sessionId,
        {
          title: '季度评审会',
          start_ms: localMs(9, 15),
          end_ms: localMs(9, 30),
          location: '3F-01',
        },
      );
    });
  });

  it('提醒创建改本地时间后回传 Unix ms', async () => {
    state.request = remindersCreateRequest;
    render(<PermissionCard />);
    enterEdit();
    changeDatetime('remind_at_ms', '2026-08-26T17:45');
    fireEvent.click(screen.getByRole('button', { name: '按修改后的内容创建' }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
        remindersCreateRequest.id,
        'allow',
        remindersCreateRequest.sessionId,
        { title: '提交评审纪要', notes: '附上行动项', remind_at_ms: localMs(17, 45) },
      );
    });
  });

  it.each([
    [calendarUpdateRequest, 'start_ms', '2026-08-26T10:15', {
      title: '季度评审会', start_ms: localMs(10, 15), end_ms: localMs(10, 30), location: '3F-02',
    }],
    [remindersUpdateRequest, 'remind_at_ms', '2026-08-26T17:15', {
      title: '提交最终评审纪要', notes: '补上负责人', remind_at_ms: localMs(17, 15),
    }],
  ] as const)('%s：更新卡改时间后回传 Unix ms，标识不进入 updatedArgs', async (native, field, value, expectedArgs) => {
    state.request = native;
    render(<PermissionCard />);
    enterEdit();
    changeDatetime(field, value);
    fireEvent.click(screen.getByRole('button', { name: '按修改后的内容更新' }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
        native.id,
        'allow',
        native.sessionId,
        expectedArgs,
      );
    });
  });

  it('可选 datetime 为空时不进入 updatedArgs', async () => {
    state.request = nativeRequest('permission-reminders-no-time', 'reminders_create', {
      list: '工作',
      title: '整理行动项',
      notes: '',
    }, '提醒事项');
    render(<PermissionCard />);
    enterEdit();
    expect((screen.getByTestId('writeback-edit-remind_at_ms-date') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '按修改后的内容创建' }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
        'permission-reminders-no-time',
        'allow',
        'request-session',
        { title: '整理行动项', notes: '' },
      );
    });
  });

  it('结束时间早于开始时间时禁用提交', async () => {
    state.request = calendarCreateRequest;
    render(<PermissionCard />);
    enterEdit();
    changeDatetime('end_ms', '2026-08-26T08:59');
    const submit = screen.getByRole('button', { name: '按修改后的内容创建' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByText('结束时间不能早于开始时间')).toBeTruthy();
    expect(screen.queryByText('必填')).toBeNull();
    fireEvent.click(submit);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(['calendar_create_event', 'reminders_create'])('en-US hour12：%s 编辑控件为 24 小时，未触碰日期保留秒和毫秒', async (tool) => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      locale: 'en-US', calendar: 'gregory', numberingSystem: 'latn',
      timeZone: 'America/Los_Angeles', hourCycle: 'h12', hour12: true,
    });
    const millis = new Date(2026, 10, 12, 23, 45, 37, 123).getTime();
    const field = tool === 'calendar_create_event' ? 'start_ms' : 'remind_at_ms';
    state.request = nativeRequest(`precision-${tool}`, tool, {
      title: '发送周报', [field]: millis,
    }, tool === 'calendar_create_event' ? '日历' : '提醒事项');
    const { container } = render(<PermissionCard />);
    enterEdit();
    expect(new Intl.DateTimeFormat().resolvedOptions().hour12).toBe(true);
    expect(container.querySelector('input[type="datetime-local"], input[type="time"]')).toBeNull();
    expect((screen.getByTestId(`writeback-edit-${field}-date`) as HTMLInputElement).value).toBe('2026-11-12');
    expect((screen.getByTestId(`writeback-edit-${field}-time-hour`) as HTMLSelectElement).value).toBe('23');
    expect((screen.getByTestId(`writeback-edit-${field}-time-minute`) as HTMLSelectElement).value).toBe('45');
    expect(screen.getByTestId('writeback-edit-form').textContent).not.toMatch(/AM|PM/);
    fireEvent.click(screen.getByRole('button', { name: '按修改后的内容创建' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, `precision-${tool}`, 'allow', 'request-session',
      expect.objectContaining({ [field]: millis }),
    ));
    vi.restoreAllMocks();
  });

  it('删除单条日程：同一套中性写回卡（不是红色危险卡），写清标题/时间/日历，只有「删除 / 取消」，提示可撤销', async () => {
    // 真机第五轮：host 给删除请求带 dangerLevel=warning，卡片曾因此走「默认突出取消 + 删除红框」的安全默认样式
    state.request = { ...nativeRequest('permission-calendar-delete', 'calendar_delete_event', {
      calendar: '日历', event_uid: 'cal:EV1', title: 'F 真机测试', start_ms: localMs(9), end_ms: localMs(10), location: '三楼',
    }, '日历'), dangerLevel: 'warning' };
    render(<PermissionCard />);
    const deleteButton = screen.getByRole('button', { name: /^删除/ });
    const cancelButton = screen.getByRole('button', { name: /^取消/ });
    expect(deleteButton.className).not.toContain('border-red-500');
    expect(deleteButton.className).toContain(PRIMARY_MARK);
    expect(cancelButton.className).not.toContain(PRIMARY_MARK);
    expect(screen.getByText('删除日历事件')).toBeTruthy();
    expect(screen.getByText('删除日历事件「F 真机测试」？')).toBeTruthy();
    expect(screen.queryByText('危险操作')).toBeNull();
    expect(screen.queryByText(/仍然执行/)).toBeNull();
    expect(screen.getByTestId('writeback-view-calendar').textContent).toBe('日历');
    expect(screen.getByTestId('writeback-view-title').textContent).toBe('F 真机测试');
    expect(screen.getByTestId('writeback-view-start_ms').textContent).not.toBe('');
    expect(screen.getByTestId('calendar-delete-note')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /修改后/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^删除/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, 'permission-calendar-delete', 'allow', 'request-session',
    ));
    releaseApprovalResponse('permission-calendar-delete');
  });

  it('改日程只改地点：没改的标题 / 开始 / 结束整行不显示，不写「无」', () => {
    state.request = nativeRequest('permission-calendar-update-location', 'calendar_update_event', {
      calendar: '日历', event_uid: 'cal:EV1', location: '五楼会议室',
    }, '日历');
    render(<PermissionCard />);
    expect(screen.getByTestId('writeback-view-location').textContent).toBe('五楼会议室');
    for (const key of ['title', 'start_ms', 'end_ms']) expect(screen.queryByTestId(`writeback-view-${key}`)).toBeNull();
    expect(screen.getByTestId('writeback-fields-view').textContent).not.toContain('无');
    releaseApprovalResponse('permission-calendar-update-location');
  });

  it('日期时间格式无效时保留独立原因码', () => {
    expect(validateWritebackDraft('calendar_create_event', {
      title: '季度评审会',
      start_ms: '2026-02-30T10:00',
      end_ms: '',
      location: '',
    })).toEqual([{ fieldKey: 'start_ms', reason: 'invalid_datetime' }]);
  });

});
