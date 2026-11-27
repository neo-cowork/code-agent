import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BACKGROUND_TASK_PREANNOUNCE } from '../../../src/shared/constants/backgroundTaskPreannounce';
import { emitCommandCenterToolStart, applyCommandCenterPreannounce } from '../../../src/host/agent/runtime/contextAssembly/sessionCommandCenterPreannounce';

describe('session command center renderer-visible preannounce', () => {
  it('emits non-empty task-bound assistant text before the delegate_task row', () => {
    const events: Array<{ type: string; text?: string }> = [];
    const preview = emitCommandCenterToolStart({
      toolName: 'delegate_task',
      commandCenterEnabled: true,
      streamedContent: '',
      existingPreannounce: '',
      userMessage: '<session_command_center>internal</session_command_center>\n<user_request>研究 React 的最新版本</user_request>',
      emitPreview: (text) => events.push({ type: 'message_delta', text }),
      emitToolStart: () => events.push({ type: 'stream_tool_call_start' }),
    });

    expect(preview).toContain('研究 React 的最新版本');
    expect(events).toEqual([
      { type: 'message_delta', text: preview },
      { type: 'stream_tool_call_start' },
    ]);
    expect(events[0].text?.trim()).not.toBe('');
  });

  it('does not duplicate a model-provided preamble', () => {
    const emitPreview = vi.fn();
    const emitToolStart = vi.fn();
    const preview = emitCommandCenterToolStart({
      toolName: 'delegate_task',
      commandCenterEnabled: true,
      streamedContent: '我先去研究。',
      existingPreannounce: '',
      userMessage: '研究 React',
      emitPreview,
      emitToolStart,
    });
    expect(preview).toBe('');
    expect(emitPreview).not.toHaveBeenCalled();
    expect(emitToolStart).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// N-FIX-DELEGATE-PREANNOUNCE-GARBLED（realrun35 / FB-596）端到端管线：
// 真实 buildCapabilityCandidateNotice（块内 prose 含行中 <user_request>）→
// wrapWithTurnSystemContext 包装 → emitCommandCenterToolStart。
// 修复前 preannounce 把「 里的用户原话。）统计内容：…」当用户任务转述。
// 候选数据按 capabilityCandidateNotice.test.ts 的方式喂真实 detector/store。
// ---------------------------------------------------------------------------

import * as os from 'os';
import * as path from 'path';

const tmpConfigDir = path.join(os.tmpdir(), `cap-notice-preannounce-${process.pid}`);
vi.mock('../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => tmpConfigDir,
}));

import { buildCapabilityCandidateNotice } from '../../../src/host/agent/capabilityCandidateNotice';
import { extractUserRequest, wrapWithTurnSystemContext } from '../../../src/shared/utils/turnScaffold';
import { getCapabilityCandidateStore } from '../../../src/host/services/skills/capabilityCandidateStore';
import { observeTurn } from '../../../src/host/services/skills/capabilityGapDetector';

const T0 = Date.now();

function step(toolName: string, command?: string) {
  return {
    toolCallId: `${toolName}-${Math.random()}`,
    toolName,
    args: command ? { command } : {},
    success: true,
    outputPreview: '',
    duration: 10,
    timestamp: T0,
  };
}

/** 攒一条真的进首屏的候选（与 capabilityCandidateNotice.test.ts 同款夹具）。 */
function seedAboveFoldCandidate(): void {
  const steps = [
    step('bash', 'screencapture -x a.png'),
    step('bash', 'tesseract a.png out'),
    step('write_file'),
  ];
  observeTurn({ userMessage: '把截图里的表格转成 Excel', steps, tokens: 30_000 }, T0);
  observeTurn({ userMessage: '再转一批', steps, tokens: 30_000 }, T0 + 1000);
}

describe('delegate_task preannounce 端到端管线（真实候选能力块 + 真实包装）', () => {
  beforeEach(() => {
    getCapabilityCandidateStore().resetForTests();
  });

  it('preannounce 引用的是用户原话，不是候选能力块的残句', () => {
    seedAboveFoldCandidate();
    const notice = buildCapabilityCandidateNotice('s-preannounce-pipeline');
    expect(notice).not.toBeNull();
    expect(notice).toContain('<user_request>'); // 块内 prose 确实带同名标签（病灶来源）

    const userRequest = '帮我研究 React 的最新版本';
    const wrapped = wrapWithTurnSystemContext([notice as string], userRequest);
    expect(extractUserRequest(wrapped)).toBe(userRequest);

    const preview = emitCommandCenterToolStart({
      toolName: 'delegate_task',
      commandCenterEnabled: true,
      streamedContent: '',
      existingPreannounce: '',
      userMessage: wrapped,
      emitPreview: () => {},
      emitToolStart: () => {},
    });

    // 证据 ③：直接把 preview 打进测试输出
    console.log('[preannounce-pipeline-preview]', preview);

    expect(preview).toContain(userRequest);
    expect(preview).not.toContain('统计内容');
    expect(preview).not.toContain('里的用户原话');
    expect(preview).not.toContain('background_capability_stats');
  });

  it('对照：同一管线在无候选（无注入块）时行为不变', () => {
    const wrapped = wrapWithTurnSystemContext([], '研究 React 的最新版本');
    const preview = emitCommandCenterToolStart({
      toolName: 'delegate_task',
      commandCenterEnabled: true,
      streamedContent: '',
      existingPreannounce: '',
      userMessage: wrapped,
      emitPreview: () => {},
      emitToolStart: () => {},
    });
    expect(preview).toContain('研究 React 的最新版本');
  });

  // 台账②三种形状（rework r2）：extractUserRequest 取不出可靠原话时，preannounce
  // 只能说固定句，不得拿脚手架片段凑数。三个形状都走真实 notice + 真实包装管线。
  const FIXED_SENTENCE = '我先把这项任务交给后台执行，完成后回到这里交付结果。';

  function expectNoScaffoldFragment(preview: string): void {
    expect(preview).not.toContain('统计内容');
    expect(preview).not.toContain('里的用户原话');
    expect(preview).not.toContain('background_capability_stats');
  }

  it('形状a：</user_request> 结束标签后还带内容 → 固定句，不引用脚手架', () => {
    seedAboveFoldCandidate();
    const notice = buildCapabilityCandidateNotice('s-shape-trailing');
    expect(notice).not.toBeNull();
    const wrapped = wrapWithTurnSystemContext([notice as string], '帮我研究 React 的最新版本');
    // 生产面不会产出这种形状（所有生产者都把包装体放在最末），这是防御形状：
    // 结束标签之后又被拼了一段脚手架内容。
    const withTrailing = `${wrapped}\n\n<turn_workbench_context>工作台偏好原文</turn_workbench_context>`;

    const preview = emitCommandCenterToolStart({
      toolName: 'delegate_task',
      commandCenterEnabled: true,
      streamedContent: '',
      existingPreannounce: '',
      userMessage: withTrailing,
      emitPreview: () => {},
      emitToolStart: () => {},
    });
    console.log('[preannounce-shape-a-trailing]', preview);
    expect(preview).toBe(FIXED_SENTENCE);
    expectNoScaffoldFragment(preview);
  });

  it('形状b：嵌套包装（已包装消息再被整条包一层）→ 固定句', () => {
    seedAboveFoldCandidate();
    const notice = buildCapabilityCandidateNotice('s-shape-nested');
    expect(notice).not.toBeNull();
    const once = wrapWithTurnSystemContext([notice as string], '帮我研究 React 的最新版本');
    const twice = wrapWithTurnSystemContext(['<turn_workbench_context>工作台偏好原文</turn_workbench_context>'], once);

    const preview = emitCommandCenterToolStart({
      toolName: 'delegate_task',
      commandCenterEnabled: true,
      streamedContent: '',
      existingPreannounce: '',
      userMessage: twice,
      emitPreview: () => {},
      emitToolStart: () => {},
    });
    console.log('[preannounce-shape-b-nested]', preview);
    expect(preview).toBe(FIXED_SENTENCE);
    expectNoScaffoldFragment(preview);
  });

  it('形状c：没有包装但脚手架块在 → 固定句', () => {
    seedAboveFoldCandidate();
    const notice = buildCapabilityCandidateNotice('s-shape-unwrapped');
    expect(notice).not.toBeNull();
    // 块直接拼在原话前、没有 <user_request> 包装（未走 wrap 的防御形状）
    const bare = `${notice}\n\n帮我研究 React 的最新版本`;

    const preview = emitCommandCenterToolStart({
      toolName: 'delegate_task',
      commandCenterEnabled: true,
      streamedContent: '',
      existingPreannounce: '',
      userMessage: bare,
      emitPreview: () => {},
      emitToolStart: () => {},
    });
    console.log('[preannounce-shape-c-unwrapped]', preview);
    expect(preview).toBe(FIXED_SENTENCE);
    expectNoScaffoldFragment(preview);
  });
});

describe('session command center renderer-visible preannounce', () => {
  it('emits non-empty task-bound assistant text before the delegate_task row', () => {
    const events: Array<{ type: string; text?: string }> = [];
    const preview = emitCommandCenterToolStart({
      toolName: 'delegate_task',
      commandCenterEnabled: true,
      streamedContent: '',
      existingPreannounce: '',
      userMessage: '<session_command_center>internal</session_command_center>\n<user_request>研究 React 的最新版本</user_request>',
      emitPreview: (text) => events.push({ type: 'message_delta', text }),
      emitToolStart: () => events.push({ type: 'stream_tool_call_start' }),
    });

    expect(preview).toContain('研究 React 的最新版本');
    expect(events).toEqual([
      { type: 'message_delta', text: preview },
      { type: 'stream_tool_call_start' },
    ]);
    expect(events[0].text?.trim()).not.toBe('');
  });

  it('does not duplicate a model-provided preamble', () => {
    const emitPreview = vi.fn();
    const emitToolStart = vi.fn();
    const preview = emitCommandCenterToolStart({
      toolName: 'delegate_task',
      commandCenterEnabled: true,
      streamedContent: '我先去研究。',
      existingPreannounce: '',
      userMessage: '研究 React',
      emitPreview,
      emitToolStart,
    });
    expect(preview).toBe('');
    expect(emitPreview).not.toHaveBeenCalled();
    expect(emitToolStart).toHaveBeenCalledOnce();
  });
});


describe('generic scaffold rejection through emitCommandCenterToolStart', () => {
  it.each(['repeated_workarounds', 'other_tag', 'SYSTEM-context', 'tag42'])('rejects <%s> anywhere in extracted requests', (tag) => {
    for (const locale of ['zh', 'en'] as const) {
      for (const request of [`<${tag}>system context</${tag}>`, `整理周报 </${tag}>`, `整理周报 <${tag}>`]) {
        const preview = emitCommandCenterToolStart({
          toolName: 'delegate_task', locale, commandCenterEnabled: true,
          streamedContent: '', existingPreannounce: '',
          userMessage: wrapWithTurnSystemContext([], request),
          emitPreview: () => {}, emitToolStart: () => {},
        });
        expect(preview).toBe(BACKGROUND_TASK_PREANNOUNCE[locale].generic);
      }
    }
  });

  it.each(['zh', 'en'] as const)('keeps the named sentence for a plain request in %s', (locale) => {
    const preview = emitCommandCenterToolStart({
      toolName: 'delegate_task', locale, commandCenterEnabled: true,
      streamedContent: '', existingPreannounce: '', userMessage: '整理周报',
      emitPreview: () => {}, emitToolStart: () => {},
    });
    expect(preview).toBe(BACKGROUND_TASK_PREANNOUNCE[locale].named.replace('{title}', '整理周报'));
  });
});

// ---------------------------------------------------------------------------
// N-FIX-DELEGATE-PREANNOUNCE-TITLE-HARD-TRUNCATE（FB-3029 / FB-1933）：
// 转述标题 28 码位预算内只许整词截断，工具名/命令痕迹一律回落固定句。
// 全部通过生产入口 emitCommandCenterToolStart（预览文案）与
// applyCommandCenterPreannounce（backgroundTaskPreannounce.title 元数据）验证。
// ---------------------------------------------------------------------------

describe('preannounce title boundary truncation', () => {
  function previewFor(userMessage: string, locale: 'zh' | 'en' = 'zh'): string {
    return emitCommandCenterToolStart({
      toolName: 'delegate_task', locale, commandCenterEnabled: true,
      streamedContent: '', existingPreannounce: '', userMessage,
      emitPreview: () => {}, emitToolStart: () => {},
    });
  }

  function metadataTitleFor(userMessage: string): string | undefined {
    const response = applyCommandCenterPreannounce(
      { type: 'tool_use', content: '', toolCalls: [{ id: 'call-1', name: 'delegate_task', arguments: {} }] },
      'preface',
      userMessage,
    );
    return response.backgroundTaskPreannounce?.title;
  }

  /** 标题去省略号后必须是 request 的前缀，且结尾正好落在某个分词段末尾（整词）。 */
  function endsOnWordBoundary(request: string, title: string): boolean {
    const head = title.endsWith('…') ? title.slice(0, -1) : title;
    if (!request.startsWith(head)) return false;
    const locale = /[\p{Script=Han}]/u.test(request) ? 'zh' : 'en';
    let acc = '';
    for (const part of new Intl.Segmenter(locale, { granularity: 'word' }).segment(request)) {
      acc += part.segment;
      if (acc === head) return true;
      if (acc.length > head.length) return false;
    }
    return acc === head;
  }

  it.each([
    {
      name: 'Chinese',
      request: '帮我研究一下 Tauri 2 和 Electron 在体积和启动速度上的差别并整理成一页对比',
      title: '帮我研究一下 Tauri 2 和 Electron 在…',
    },
    {
      name: 'English',
      request: 'Research the differences between Tauri 2 and Electron in bundle size and startup speed',
      title: 'Research the differences…',
    },
    {
      name: 'mixed Chinese-English',
      request: '帮我对比 Tauri 2 和 Electron 在 installer size、startup time 上的差别并整理',
      title: '帮我对比 Tauri 2 和 Electron 在…',
    },
  ])('cuts a >28-code-point $name request at a word boundary', ({ request, title }) => {
    const preview = previewFor(request);
    expect(preview).toBe(BACKGROUND_TASK_PREANNOUNCE.zh.named.replace('{title}', title));
    expect(endsOnWordBoundary(request, title)).toBe(true);
    expect(metadataTitleFor(request)).toBe(title);
  });

  it('prefers the last clause punctuation inside the budget', () => {
    const request = 'Compare Tauri and Electron, then write a one-page summary for me';
    const title = 'Compare Tauri and Electron…';
    expect(previewFor(request, 'en')).toBe(BACKGROUND_TASK_PREANNOUNCE.en.named.replace('{title}', title));
    expect(metadataTitleFor(request)).toBe(title);
  });

  it.each([
    { locale: 'zh' as const, request: '帮我用 Bash 跑一段 osascript，十分钟后弹窗提醒我喝水' },
    { locale: 'en' as const, request: 'use bash to run a multi-line osascript reminder for me please' },
  ])('falls back to generic copy when the request names tools ($locale)', ({ locale, request }) => {
    const preview = previewFor(request, locale);
    expect(preview).toBe(BACKGROUND_TASK_PREANNOUNCE[locale].generic);
    expect(preview).not.toMatch(/bash|zsh|shell|terminal|osascript|applescript|powershell|curl|sudo/i);
    expect(metadataTitleFor(request)).toBeUndefined();
  });

  it.each([
    'run delegate_task for this and report back here when it finishes',
    '请运行 `npm test` 然后把失败用例整理给我',
    'run this script\n$ ls -la /tmp 然后把输出整理成表格',
  ])('falls back to generic copy for command-like request: %j', (request) => {
    for (const locale of ['zh', 'en'] as const) {
      expect(previewFor(request, locale)).toBe(BACKGROUND_TASK_PREANNOUNCE[locale].generic);
      expect(metadataTitleFor(request)).toBeUndefined();
    }
  });

  it('a ≤28-code-point request is used whole with no ellipsis', () => {
    const request = '研究 Tauri 和 Electron 的体积差别';
    const preview = previewFor(request);
    expect(preview).toBe(BACKGROUND_TASK_PREANNOUNCE.zh.named.replace('{title}', request));
    expect(preview).not.toContain('…');
    expect(metadataTitleFor(request)).toBe(request);
  });

  it('a >28-code-point request gets exactly one ellipsis', () => {
    const preview = previewFor('帮我研究一下 Tauri 2 和 Electron 在体积和启动速度上的差别并整理成一页对比');
    expect(preview.match(/…/g)).toHaveLength(1);
  });

  it('a single token longer than the budget has no boundary → generic copy', () => {
    const request = 'a'.repeat(29);
    expect(previewFor(request)).toBe(BACKGROUND_TASK_PREANNOUNCE.zh.generic);
    expect(metadataTitleFor(request)).toBeUndefined();
  });
});
