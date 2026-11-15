// @vitest-environment jsdom
// 返修 r5（FB-1489 / 1492 / 1493 / 1495 / 1497）：五处文案跟随界面语言。
// 英文：不含中文，也不含中文标点；中文：与迁入语言包之前写在代码里的字面量逐字相同。
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentEngineDescriptor } from '../../../src/shared/contract/agentEngine';
import { languages } from '../../../src/renderer/i18n';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { formatDateTime } from '../../../src/renderer/utils/formatDateTime';
import {
  ProviderSourceBadge,
  buildEngineReliabilitySummary,
  buildModelRowHealthSummary,
  buildProviderBillingSummary,
  buildProviderHealthSummary,
  buildProviderMetaTitle,
  getEngineEffortOptions,
  getEngineUnavailableReason,
} from '../../../src/renderer/components/StatusBar/modelSwitcherHelpers';
import {
  formatExternalModelSwitcherTooltip,
  formatNativeModelSwitcherTooltip,
} from '../../../src/renderer/components/StatusBar/modelSwitcherTooltips';

// 汉字 + 常见中文标点
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/u;

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => strings(item, out));
  return out;
}

const descriptor = (overrides: Partial<AgentEngineDescriptor> = {}): AgentEngineDescriptor => ({
  manifestId: 'codex_cli', kind: 'codex_cli', label: 'Codex CLI', summary: '', installState: 'installed', runtimeState: 'ready',
  executable: true, capabilities: ['execute', 'stream_events'], defaultPermissionProfile: 'read_only', cwdPolicy: 'workspace',
  riskTier: 'medium', detectedAt: 1, modelSelection: 'runtime_catalog', ...overrides,
} as AgentEngineDescriptor);

/** 模型切换器 helper 在当前界面语言下给出的各类文字。 */
function helperOutputs(): string[] {
  const health = buildProviderHealthSummary({ status: 'degraded', errorRate: 0.42, latencyP50: 120 } as never);
  const billing = buildProviderBillingSummary('payg');
  return strings([
    buildProviderHealthSummary(null),
    health,
    billing,
    buildProviderBillingSummary(null),
    buildModelRowHealthSummary({ providerMark: { kind: 'auth' } } as never, 'm'),
    buildProviderMetaTitle({ healthSummary: health, billingSummary: billing, providerSourceLabel: 'team', providerProtocol: 'openai' } as never),
    getEngineUnavailableReason(descriptor(), true),
    getEngineUnavailableReason(descriptor({ executable: false }), false),
    getEngineUnavailableReason(descriptor({ installState: 'missing' }), false),
    buildEngineReliabilitySummary({ descriptor: descriptor(), needsWorkspace: false } as never),
    buildEngineReliabilitySummary({ descriptor: descriptor({ runtimeState: 'not_configured' }), needsWorkspace: false } as never),
    buildEngineReliabilitySummary({ descriptor: descriptor({ runtimeState: 'unknown' }), needsWorkspace: false } as never),
    buildEngineReliabilitySummary({ descriptor: descriptor(), needsWorkspace: true } as never),
    renderToStaticMarkup(<ProviderSourceBadge sourceLabel="team" />).replace(/<[^>]+>/g, ' '),
  ]);
}

afterEach(() => useAppStore.setState({ language: 'zh' }));

describe('FB-1489 模型切换器', () => {
  it('英文语言包整包不含中文和中文标点', () => {
    expect(strings(languages.en.modelSwitcherCopy).filter((text) => CJK.test(text))).toEqual([]);
    expect(strings(languages.en.modelSwitcherTooltip).filter((text) => CJK.test(text))).toEqual([]);
  });

  it('helper 输出：英文界面不含中文；中文界面与迁入前逐字相同', () => {
    const zh = helperOutputs();
    for (const expected of [
      '未检测', '最近健康状态未上报', '降级', 'P50 120ms · 错误率 42%', '按量',
      '按量付费：简单任务可由自动策略切到快模型降低成本和延迟。', '计费未知', '密钥用不了',
      '状态: 降级 · P50 120ms · 错误率 42%\n计费: 按量 · 按量付费：简单任务可由自动策略切到快模型降低成本和延迟。\n来源: team\n协议: OpenAI-compatible',
      '需要先选择工作目录', 'CLI 不可执行', '未安装', '可用', 'Codex CLI 可用，当前模型 使用默认选择。',
      '需要配置', 'Codex CLI 已检测到，但还需要完成登录或默认配置。', '待确认', 'Codex CLI 已列出，但运行状态还没有确认。',
      '需要处理', '这条外部引擎链路会影响订阅模型的输出可靠性。',
    ]) expect(zh).toContain(expected);
    expect(zh.some((text) => text.includes('来源 team'))).toBe(true);
    expect(zh.some((text) => text.includes('支持流式事件 · CLI 执行能力可用 · 模型目录未标记代码任务能力'))).toBe(true);

    useAppStore.setState({ language: 'en' });
    const en = helperOutputs();
    expect(en.length).toBe(zh.length);
    expect(en.filter((text) => CJK.test(text))).toEqual([]);
    expect(en).toContain('Choose a working folder first');
    expect(en).toContain('Codex CLI is ready. Current model: default selection.');
  });

  it('推理强度的短标签在取值那一刻才看语言（不是模块加载时定死）', () => {
    const shortLabels = () => getEngineEffortOptions('codex_cli').map((option) => option.shortLabel);
    const zh = shortLabels();
    expect(zh.some((label) => ['低', '中', '高', '极高'].includes(label))).toBe(true);
    useAppStore.setState({ language: 'en' });
    const en = shortLabels();
    expect(en.length).toBe(zh.length);
    expect(en.filter((label) => CJK.test(label))).toEqual([]);
  });

  it('悬停提示：中文与迁入前逐字相同，英文不含中文', () => {
    const native = (language: 'zh' | 'en', extra: Record<string, unknown> = {}) => formatNativeModelSwitcherTooltip({
      language, engineLabel: 'Neo', currentModel: 'main', displayProvider: 'longcat', displayModel: 'LongCat-2.0',
      adaptive: false, overridden: false, billingSummary: { label: language === 'zh' ? '按量' : 'Pay as you go' },
      effort: { label: 'High', shortLabel: '高' }, thinkingLabel: language === 'zh' ? '思考' : 'Thinking', ...extra,
    } as never);
    expect(native('zh')).toBe('主任务模型: longcat/LongCat-2.0 · 计费: 按量 · 推理强度: 高 · 思考: 思考');
    expect(native('zh', { adaptive: true })).toContain('自动路由（按任务、成本和能力切换，当前主任务 main）');
    expect(native('zh', { overridden: true })).toContain('已覆盖: longcat/LongCat-2.0 (原主任务: main)');
    expect(native('zh', { switchedFrom: { provider: 'a', model: 'b' }, shownProvider: 'c', shownModel: 'd' }))
      .toContain('这一轮实际在用: c/d（你选的是 a/b，已自动换过）');
    expect(formatExternalModelSwitcherTooltip({ language: 'zh', engineLabel: 'Claude', model: 'sonnet' }))
      .toBe('运行引擎: Claude · 主任务模型: sonnet');
    for (const extra of [{}, { adaptive: true }, { overridden: true }, { switchedFrom: { provider: 'a', model: 'b' }, shownProvider: 'c', shownModel: 'd' }]) {
      expect(native('en', extra)).not.toMatch(CJK);
    }
    expect(native('en')).toBe('Main task model: longcat/LongCat-2.0 · Billing: Pay as you go · Effort: High · Thinking: Thinking');
  });

  it('组件里的文案：中文与迁入前逐字相同', () => {
    const zh = languages.zh.modelSwitcherCopy;
    expect([
      zh.panelTitle, zh.searchPlaceholder, zh.noModelHint, zh.restoreMainModel, zh.switchModelAria, zh.goToModelSettings,
      zh.auto, zh.autoHint, zh.noMatchingModel, zh.noModelYet, zh.configureModel, zh.defaultModel, zh.thinking, zh.notThinking,
      zh.switchFailed.replace('{error}', 'E'), zh.autoSwitchFailed.replace('{error}', 'E'), zh.unknownError,
      zh.switchedSuffix.replace('{label}', 'M'), zh.engineProbeUnavailable, zh.engineSwitchFailed, zh.externalModelSwitchFailed,
    ]).toEqual([
      '主任务模型', '搜索主任务模型…', '配好 Provider 和 API Key 后再选择主任务模型。', '恢复主任务模型', '切换模型', '去模型设置',
      '自动', '按任务、成本和能力切换', '无匹配模型', '还没有可用模型', '配置模型', '默认模型', '思考', '不思考',
      '模型切换失败: E。请检查 API Key 或网络连接', '切换到自动模式失败: E', '未知错误',
      'M（已换）', '执行引擎探测结果不可用', '执行引擎切换失败', '外部引擎模型切换失败',
    ]);
  });
});

describe('FB-1492 协作空间任务 tab', () => {
  it('中文与迁入前逐字相同；英文不含中文和中文标点', () => {
    const zh = languages.zh.neoTopics;
    expect(zh.phaseFilters).toEqual({ all: '全部', running: '运行中', needs_input: '待确认', done: '已完成', failed: '失败', closed: '已结束' });
    expect([
      zh.searchPlaceholder, zh.onlyMine, zh.loadingTopics, zh.detailAria, zh.closeDetailAria, zh.loadFailed, zh.refreshFailed,
      zh.cancelFeedback, zh.cancelFailed, zh.archiveFailed, zh.memoryWriteFailed, zh.openSessionFailed,
    ]).toEqual([
      '搜索 topic / 步骤 / 文件', '只看我的', '正在加载 topic', 'topic 详情', '关闭详情', '加载 Neo topic 失败', '刷新 Neo topic 失败',
      '用户取消', '取消 topic 失败', '归档 topic 失败', '写入记忆失败', '打开会话失败',
    ]);
    expect(strings(languages.en.neoTopics).filter((text) => CJK.test(text))).toEqual([]);
  });
});

describe('FB-1493 专家详情页人设正文', () => {
  it('标题不变；说明按约定改写（不再出现 frontmatter）；英文不含中文', () => {
    const zh = languages.zh.expert.roleDetail;
    expect(zh.definitionTitle).toBe('人设正文');
    expect(zh.definitionDescription).toBe('直接编辑专家的人设；保存只会替换正文，不会改动名称、图标等其它设置。');
    expect(zh.definitionDescription).not.toContain('frontmatter');
    const en = languages.en.expert.roleDetail;
    expect(`${en.definitionTitle}${en.definitionDescription}`).not.toMatch(CJK);
    expect(en.definitionDescription).not.toContain('frontmatter');
  });
});

describe('FB-1495 日期兜底词', () => {
  it('没有时间 / 时间无效：中文不变，英文跟界面语言；不传语言时仍按中文', () => {
    expect(formatDateTime(undefined, 'zh')).toBe('未设置');
    expect(formatDateTime(null as never, 'zh')).toBe('未设置');
    expect(formatDateTime('not-a-date', 'zh')).toBe('无效时间');
    expect(formatDateTime(undefined, 'en')).toBe('Not set');
    expect(formatDateTime('', 'en')).toBe('Invalid time');
    expect(formatDateTime('not-a-date', 'en')).toBe('Invalid time');
    expect(formatDateTime(undefined)).toBe('未设置');
    expect(formatDateTime(new Date(2026, 10, 15, 9, 5), 'en')).not.toMatch(CJK);
  });
});

describe('FB-1497 定时任务运行状态条', () => {
  it('「等你批准：xx」是一条完整文案：中文全角冒号不变，英文是半角冒号', () => {
    const zh = languages.zh.cronRunRecord;
    const en = languages.en.cronRunRecord;
    expect(zh.awaitingWithLabel.replace('{label}', '运行命令')).toBe(`${zh.awaiting}：运行命令`);
    expect(en.awaitingWithLabel.replace('{label}', 'Run a command')).toBe('Needs your approval: Run a command');
    expect(en.awaitingWithLabel).not.toMatch(CJK);
  });
});
