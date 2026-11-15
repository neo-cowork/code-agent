import type { SurfaceConversationSnapshotV1 } from '@shared/contract/surfaceExecution';
import { IPC_DOMAINS } from '@shared/ipc';
import { useAppStore } from '../stores/appStore';
import { useSurfaceExecutionStore } from '../stores/surfaceExecutionStore';
import { createLogger } from '../utils/logger';

const logger = createLogger('KeptResultPage');

interface AdoptKeptResultPageResult {
  conversationId: string;
  runId: string;
  surfaceSessionId: string;
  snapshot: SurfaceConversationSnapshotV1;
}

function domainBridge() {
  return window.codeAgentDomainAPI || window.domainAPI;
}

/**
 * kept 窗三态（N-BROWSER-KEEP-RESULT-PAGE / N-FIX-FIX-BROWSER-SECRETREF-HARDEN）：
 * none=无；kept=窗还活着；closed=已关、URL 留存。reason 区分停靠来由：
 * keep_result_page=模型保留的结果页（工作台条）；takeover=secretRef 接管停靠
 * （聊天「继续」卡）。
 */
export interface KeptResultPage {
  state: 'none' | 'kept' | 'closed';
  url: string | null;
  title: string | null;
  reason: 'keep_result_page' | 'takeover' | null;
}

const NONE_KEPT_RESULT_PAGE: KeptResultPage = {
  state: 'none',
  url: null,
  title: null,
  reason: null,
};

/** 查询本会话 kept 结果页状态；host 不可达或无会话按 none 处理（终态条不硬依赖 IPC）。 */
export async function getKeptResultPage(
  conversationId: string | null | undefined,
): Promise<KeptResultPage> {
  const normalized = conversationId?.trim();
  const bridge = domainBridge();
  if (!bridge || !normalized) return NONE_KEPT_RESULT_PAGE;
  try {
    const response = await bridge.invoke<KeptResultPage>(
      IPC_DOMAINS.WORKSPACE,
      'getKeptResultPage',
      { conversationId: normalized },
    );
    if (!response?.success || !response.data) {
      return NONE_KEPT_RESULT_PAGE;
    }
    return {
      ...response.data,
      reason: response.data.reason ?? null,
    };
  } catch (error) {
    logger.error('Failed to fetch kept result page state', error, { conversationId: normalized });
    return NONE_KEPT_RESULT_PAGE;
  }
}

/** 认领 kept 结果页：user run 绑上模型留下的活窗（不导航）；返回与 openLinkInRail 同形快照。 */
export async function adoptKeptResultPage(input: {
  conversationId: string | null | undefined;
  workspace: string | null | undefined;
}): Promise<AdoptKeptResultPageResult> {
  const conversationId = input.conversationId?.trim();
  const workspace = input.workspace?.trim() ?? '';
  const bridge = domainBridge();
  if (!bridge || !conversationId) {
    throw new Error('Kept result page adoption requires a conversation.');
  }
  useAppStore.getState().openWorkbenchTab('browser', { source: 'user' });
  const response = await bridge.invoke<AdoptKeptResultPageResult>(
    IPC_DOMAINS.WORKSPACE,
    'adoptKeptResultPage',
    { conversationId, workspace },
  );
  if (!response?.success || !response.data) {
    throw new Error(response?.error?.message || 'Failed to open the kept result page.');
  }
  const applied = useSurfaceExecutionStore.getState().setNativeSnapshot(
    conversationId,
    response.data.snapshot,
  );
  if (applied === 'invalid') {
    throw new Error('Kept result page returned an invalid Surface snapshot.');
  }
  return response.data;
}
