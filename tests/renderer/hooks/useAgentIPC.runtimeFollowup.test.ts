import { describe, expect, it } from 'vitest';
import {
  getAgentSendFailureMessage,
  isSessionBusyRunConflict,
  isRuntimeBusyStatus,
} from '../../../src/renderer/hooks/agent/agentRuntimeFollowup';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { getRuntimeFollowupFailureMessage } from '../../../src/renderer/hooks/agent/useAgentIPC';

describe('runtime follow-up helpers', () => {
  it('treats active task states as busy', () => {
    expect(isRuntimeBusyStatus('running')).toBe(true);
    expect(isRuntimeBusyStatus('paused')).toBe(true);
    expect(isRuntimeBusyStatus('queued')).toBe(true);
    // 'cancelling' 在 commit bce470a2 后从 busy 集合里分离出来：
    // busy = 可接受运行中引导的活跃态；cancelling = 不能接，专门走 isRuntimeCancellingStatus
    // 防止用户在 cancelling 期间发引导消息而被静默吞掉。
    expect(isRuntimeBusyStatus('cancelling')).toBe(false);
    expect(isRuntimeBusyStatus('idle')).toBe(false);
    expect(isRuntimeBusyStatus('error')).toBe(false);
  });

  it('keeps Agent not initialized out of the chat-facing copy', () => {
    const message = getRuntimeFollowupFailureMessage(new Error('Agent not initialized'));

    expect(message).toBe('当前任务还没准备好接收引导消息，稍后再发一次。');
    expect(message).not.toContain('Agent not initialized');
    expect(message).not.toContain('中断失败');
  });

  it('uses actionable copy when send-message rejects without an Error message', () => {
    expect(getAgentSendFailureMessage(undefined)).toBe('Error: 消息发送失败，但前端没有收到具体错误。请查看后台日志。');
    expect(getAgentSendFailureMessage(new Error('network down'))).toBe('Error: network down');
  });

  it.each([
    ['zh', '请补一句话说明想让我做什么，然后再发送一次。'],
    ['en', 'Add a sentence saying what you want done, then send again.'],
  ] as const)('maps PROMPT_REQUIRED and a plain 400 to a plain %s sentence', (language, sentence) => {
    const original = useAppStore.getState().language;
    useAppStore.setState({ language: language });
    try {
      const coded = Object.assign(new Error('云端代理请求失败 (400): Missing prompt'), { status: 400, code: 'PROMPT_REQUIRED' });
      const plain = Object.assign(new Error('云端代理请求失败 (400): Missing prompt'), { status: 400 });
      for (const error of [coded, plain]) {
        const message = getAgentSendFailureMessage(error);
        expect(message).toBe(sentence);
        expect(message).not.toMatch(/云端代理请求失败|Missing prompt|400/);
      }
    } finally {
      useAppStore.setState({ language: original });
    }
  });

  // 这一档不是失败：模型上一轮已经答完（用户也看到了），只是 run 还没收干净。
  // 判据必须认结构化 status，不能只靠中文文案——文案一改就静默失效。
  it('recognises the session-busy run conflict from status and from the raw host message', () => {
    expect(isSessionBusyRunConflict(Object.assign(new Error('云端代理请求失败 (409): x'), { status: 409 })))
      .toBe(true);
    expect(isSessionBusyRunConflict(new Error('Session s1 already has active run run-abc'))).toBe(true);
    expect(isSessionBusyRunConflict(Object.assign(new Error('boom'), { status: 500 }))).toBe(false);
    expect(isSessionBusyRunConflict(new Error('network down'))).toBe(false);
    expect(isSessionBusyRunConflict(undefined)).toBe(false);
  });

  // N-FIX-SIGNED-OUT-SEND-500-RAW-HTML-REDESIGN：同为 422 时先认稳定码——
  // PROJECT_SOURCE_TRUST 是「旧项目 Source 身份快照缺失」，不是「补一句话」。
  it.each([
    ['zh', '这个项目文件夹需要你确认后 Neo 才能使用。'],
    ['en', 'This project folder needs your confirmation before Neo can use it.'],
  ] as const)('maps 422 PROJECT_SOURCE_TRUST to the %s trust sentence before the generic 422 rule', (language, sentence) => {
    const original = useAppStore.getState().language;
    useAppStore.setState({ language: language });
    try {
      const coded = Object.assign(
        new Error('Neo 暂时没能完成这次请求，请稍后再试。'),
        { status: 422, code: 'PROJECT_SOURCE_TRUST' },
      );
      const message = getAgentSendFailureMessage(coded);
      expect(message).toBe(sentence);
      expect(message).not.toContain('补一句话');
    } finally {
      useAppStore.setState({ language: original });
    }
  });

  // ⑤：通用 500（含整页 HTML 错误体）只出一句话，不带 Error: 前缀、不透传响应体。
  it.each([
    ['zh', 'Neo 暂时没能完成这次请求，请稍后再试。'],
    ['en', 'Neo could not complete the request; please try again in a moment.'],
  ] as const)('maps a 500 with an HTML body to one plain %s sentence without the Error: prefix', (language, sentence) => {
    const original = useAppStore.getState().language;
    useAppStore.setState({ language: language });
    try {
      const html = '<!DOCTYPE html><html lang="en"><head><title>Error</title></head><body><pre>boom</pre></body></html>';
      const error = Object.assign(new Error(html), { status: 500 });
      const message = getAgentSendFailureMessage(error);
      expect(message).toBe(sentence);
      expect(message).not.toMatch(/Error:|DOCTYPE|<html|boom/);
    } finally {
      useAppStore.setState({ language: original });
    }
  });

  // 非 HTTP 失败（无 status）保持原有 Error: 前缀路径，不受状态映射影响。
  it('keeps the Error: prefix path for failures without an HTTP status', () => {
    expect(getAgentSendFailureMessage(new Error('network down'))).toBe('Error: network down');
  });
});
