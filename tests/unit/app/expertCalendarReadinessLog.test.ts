// ============================================================================
// 专家声明的 calendar 连接器就绪 failed/unavailable：可区分原因的日志 + 不晾专家
// ============================================================================
//
// N-FIX-ROLE-CHAT-CALENDAR-TOOLS-NARROWED-FU1（无头半边，条款3）：
// 真机半边（新建日历专家真答「今天有什么日程」）已由编排从 Dev app DB 验完；
// macOS 桥恒探测 OK，readiness failed/unavailable 在真机上到不了，且 "readiness_failed"
// 是模板拼出来的、对打包 app 做字面搜索搜不到——只能从生产入口无头证明。钉三件事：
//   (a1) withWorkbenchTurnSystemContext（生产入口）对**专家声明**的 calendar 就绪
//        failed/unavailable 落 logger.info「Expert-declared connector omitted from
//        turn scope」，cause 落 readiness_failed / readiness_unavailable（'selected'
//        变体在 workbenchTurnContext.test.ts 有测试，'expert' 变体此前零覆盖）；
//   (a2) 同一轮 getNativeConnectorToolNamesForIntent 对 enabled 的 calendar 落
//        warn「not preloaded (reason: readiness-<x>): calendar」并跳过预载；
//   (b)  先宽后收：没连上的声明过滤后为空 = 不收窄（不是锁成空集），turnSystemContext
//        给出「这些 connectors 尚未连接：calendar…」显式提示，calendar 读工具仍过
//        真实派发门 + 真实 tool_search。
// 现实口径（calendar.ts buildCalendarStatus）：真实 calendar 连接器只会报
// unavailable（非 macOS）/ ready / unchecked——'failed' 是本测试的合成 stub，
// 'unavailable' 才是生产可达分支，两个都钉。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorStatus } from '../../../src/host/connectors';
import { getConnectorRegistry } from '../../../src/host/connectors';

const resolveAgentMock = vi.hoisted(() => vi.fn());
const trackNodeMock = vi.hoisted(() => vi.fn());
const loggerSpies = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));

vi.mock('../../../src/host/agent/agentRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/agent/agentRegistry')>();
  return { ...actual, resolveAgent: resolveAgentMock };
});

vi.mock('../../../src/host/observability/posthogNode', () => ({
  trackNode: trackNodeMock,
}));

// 同一个 createLogger 假件接管两张日志：WorkbenchTurnContext 的 info（omitted）
// 与 ContextAssembly 的 warn（not preloaded）——两处都是模块级 createLogger。
vi.mock('../../../src/host/services/infra/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/infra/logger')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: loggerSpies.info,
      warn: loggerSpies.warn,
      error: vi.fn(),
    }),
  };
});

// nativeConnectorIntent 的 enabledNative 边界：设置里启用了 calendar（其余 getApiKey
// 之类的成员给安全兜底，本图里的消费方只在运行时按需调用）。
vi.mock('../../../src/host/services/core/configService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/core/configService')>();
  return {
    ...actual,
    getConfigService: () => ({
      getSettings: () => ({ connectors: { enabledNative: ['calendar'] } }),
      getApiKey: () => undefined,
    }),
  };
});

import { withWorkbenchTurnSystemContext } from '../../../src/host/app/workbenchTurnContext';
import { getNativeConnectorToolNamesForIntent } from '../../../src/host/connectors/nativeConnectorIntent';
import { isToolNameAllowedByWorkbenchScope } from '../../../src/host/tools/workbenchToolScope';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolSearchService } from '../../../src/host/services/toolSearch/toolSearchService';

const registry = getConnectorRegistry();

function registerCalendarConnector(status: Partial<ConnectorStatus>): void {
  registry.register({
    id: 'calendar',
    label: 'calendar',
    capabilities: ['get_status'],
    getCachedStatus: () => ({ connected: false, capabilities: ['get_status'], ...status }),
    async getStatus() { return this.getCachedStatus!(); },
    async execute() { return { data: null }; },
  });
}

// createLogger 被整图共用：按消息前缀过滤，别让无关模块的 info/warn 噪声进来
const omittedInfoCalls = () => loggerSpies.info.mock.calls.filter(
  ([message]) => typeof message === 'string' && message.includes('omitted from turn scope'),
);
const notPreloadedWarnCalls = () => loggerSpies.warn.mock.calls.filter(
  ([message]) => typeof message === 'string' && message.includes('not preloaded'),
);

describe('专家声明 calendar 连接器就绪 failed/unavailable（无头半边）', () => {
  beforeEach(() => {
    resolveAgentMock.mockReset();
    trackNodeMock.mockReset();
    loggerSpies.info.mockClear();
    loggerSpies.warn.mockClear();
    resolveAgentMock.mockReturnValue({
      id: 'scheduler',
      name: '日程管家',
      connectors: [{ id: 'calendar', level: 'core' }],
    });
  });

  afterEach(() => {
    registry.unregister('calendar');
  });

  it.each(['failed', 'unavailable'] as const)(
    'readiness %s：omitted 日志带可区分 cause，同轮 not preloaded warn，且不晾专家',
    (readiness) => {
      registerCalendarConnector({ readiness, connected: false });

      // 生产入口，不拼装替代品：专家身份走 context.preferredAgentId
      const merged = withWorkbenchTurnSystemContext(undefined, { preferredAgentId: 'scheduler' });

      // (a1) 专家声明（非用户手选）这支的 omitted 日志：恰好一条 + 可区分 cause
      expect(omittedInfoCalls()).toHaveLength(1);
      expect(omittedInfoCalls()[0]?.[0])
        .toBe('[WorkbenchTurnContext] Expert-declared connector omitted from turn scope');
      expect(omittedInfoCalls()[0]?.[1]).toEqual({
        connectorId: 'calendar',
        readiness,
        connected: false,
        cause: `readiness_${readiness}`,
      });

      // (a2) 同一轮：enabled 的 calendar 因 readiness 被跳过预载，warn 带同一档原因
      const names = getNativeConnectorToolNamesForIntent({
        userText: '今天有什么日程',
        allowedConnectorIds: merged?.toolScope?.allowedConnectorIds,
      });
      expect(notPreloadedWarnCalls()).toHaveLength(1);
      expect(notPreloadedWarnCalls()[0]?.[0]).toBe(
        `[ContextAssembly] Enabled native connector not preloaded (reason: readiness-${readiness}): calendar`,
      );
      expect(names).toEqual([]);

      // (b) 先宽后收：声明过滤后为空 = 不收窄；calendar 读工具过真实派发门
      expect(merged?.toolScope?.allowedConnectorIds ?? []).toHaveLength(0);
      expect(isToolNameAllowedByWorkbenchScope('calendar', merged?.toolScope)).toBe(true);
      // 反例对照：这道门真的会拦——scope 若收窄到别的连接器，calendar 工具就被挡，
      // 证明上面那个 true 不是「这条路本来就不设防」的空转。
      expect(isToolNameAllowedByWorkbenchScope('calendar', { allowedConnectorIds: ['mail'] })).toBe(false);
      // 显式连接提示：turnSystemContext 点名 calendar
      const notConnectedLine = merged?.turnSystemContext?.find((line) => line.includes('尚未连接'));
      expect(notConnectedLine).toContain('calendar');
    },
  );

  it('readiness ready（负向对照）：不落 omitted 日志、不落 not preloaded warn，声明照常收窄', () => {
    registerCalendarConnector({ readiness: 'ready', connected: true });

    const merged = withWorkbenchTurnSystemContext(undefined, { preferredAgentId: 'scheduler' });

    expect(omittedInfoCalls()).toHaveLength(0);
    const names = getNativeConnectorToolNamesForIntent({
      userText: '今天有什么日程',
      allowedConnectorIds: merged?.toolScope?.allowedConnectorIds,
    });
    expect(notPreloadedWarnCalls()).toHaveLength(0);
    // ready 时声明生效：收窄到 calendar，读写工具齐上（含读工具 calendar）
    expect(merged?.toolScope?.allowedConnectorIds).toEqual(['calendar']);
    expect(names).toEqual(expect.arrayContaining(['calendar', 'calendar_create_event']));
    expect((merged?.turnSystemContext ?? []).some((line) => line.includes('尚未连接'))).toBe(false);
  });

  it('(b) 补充：calendar 读工具仍可经真实 tool_search 搜到并加载（不因未预载而失踪）', async () => {
    registerCalendarConnector({ readiness: 'failed', connected: false });
    // 确保 calendar schema 已在 protocol registry、tool-search 的 name checker 已接线
    getProtocolRegistry();

    const merged = withWorkbenchTurnSystemContext(undefined, { preferredAgentId: 'scheduler' });

    const service = new ToolSearchService();
    for (const query of ['calendar', 'schedule events']) {
      const result = await service.searchTools(query, { maxResults: 20 });
      expect(result.tools.map((tool) => tool.name), `query=${query}`).toContain('calendar');
    }
    const selected = service.selectTool('calendar');
    expect(selected.tools[0]?.name).toBe('calendar');
    expect(selected.tools[0]?.loadable).toBe(true);
    expect(selected.loadedTools).toContain('calendar');
    // 同一份 toolScope 下派发门放行 calendar 读工具
    expect(isToolNameAllowedByWorkbenchScope('calendar', merged?.toolScope)).toBe(true);
  });
});
