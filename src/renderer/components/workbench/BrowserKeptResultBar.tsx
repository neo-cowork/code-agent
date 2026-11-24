import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { Button, Modal } from '../primitives';
import { useSurfaceExecutionStore } from '../../stores/surfaceExecutionStore';
import { browserStageOverlayMarker } from '../../utils/browserStageInteractionGate';
import {
  adoptKeptResultPage,
  getKeptResultPage,
  type KeptResultPage,
} from '../../services/keptResultPage';
import { openHttpLinkInRailAsync } from '../../services/userBrowserLink';

// N-BROWSER-KEEP-RESULT-PAGE：agent run 终态时叠加在留影/摘要卡底部的结果页条。
// 三态：none（不渲染）/ kept（窗还活着，认领接上活页继续操作）/ closed（窗已被
// 闲置回收或关闭）。无 query 且有保存页时，重新打开先显示只读快照；否则只恢复网址。

/** 终态可见期间的低频轮询：30 分钟闲置回收发生时把「已保留」翻成「已关闭」。 */
const KEPT_STATE_POLL_MS = 30_000;

type KeptCopy = ReturnType<typeof useI18n>['t']['workbenchTabs']['agentWindow']['keptResult'];

function formatTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (
    vars[key] !== undefined ? vars[key] : match
  ));
}

export interface BrowserKeptResultBarProps {
  conversationId: string | null | undefined;
  workspace: string | null | undefined;
  turnActive?: boolean;
  pageRunning?: boolean;
}

export const BrowserKeptResultBar: React.FC<BrowserKeptResultBarProps> = ({
  conversationId,
  workspace,
  turnActive = false,
  pageRunning = false,
}) => {
  const { t } = useI18n();
  const openedState = useSurfaceExecutionStore((state) => (
    conversationId ? state.openedKeptResultsByConversation[conversationId]?.state : undefined
  ));
  const copy: KeptCopy = t.workbenchTabs.agentWindow.keptResult;
  const [kept, setKept] = useState<KeptResultPage>({ state: 'none', url: null, title: null, reason: null });
  const [busy, setBusy] = useState<'adopt' | 'reopen' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keptSnapshot = useSurfaceExecutionStore((state) => (
    conversationId ? state.keptResultSnapshotByConversation[conversationId] : undefined
  ));
  const snapshotOpen = keptSnapshot?.snapshotOpen ?? false;
  const snapshotHtml = keptSnapshot?.snapshotHtml ?? null;
  const mountedRef = useRef(true);
  const turnActiveRef = useRef(turnActive);
  turnActiveRef.current = turnActive;
  const wasTurnActiveRef = useRef(turnActive);

  const refresh = useCallback(async () => {
    const next = await getKeptResultPage(conversationId);
    if (mountedRef.current) setKept(next);
  }, [conversationId]);

  useEffect(() => {
    mountedRef.current = true;
    wasTurnActiveRef.current = turnActiveRef.current;
    void refresh();
    const timer = setInterval(() => void refresh(), KEPT_STATE_POLL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const wasActive = wasTurnActiveRef.current;
    wasTurnActiveRef.current = turnActive;
    if (wasActive && !turnActive) {
      void refresh();
    }
  }, [turnActive, refresh]);

  const onAdopt = useCallback(async () => {
    if (!conversationId || turnActiveRef.current) return;
    setBusy('adopt');
    setError(null);
    try {
      const opened = await adoptKeptResultPage({ conversationId, workspace });
      useSurfaceExecutionStore.getState().noteKeptResultOpened(conversationId, {
        surfaceSessionId: opened.surfaceSessionId, state: 'kept',
      });
    } catch (caught) {
      setError(formatTemplate(copy.adoptFailed, {
        error: caught instanceof Error ? caught.message : String(caught),
      }));
      await refresh();
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [conversationId, workspace, copy.adoptFailed, refresh]);

  const reopenByUrl = useCallback(async () => {
    if (!kept.url || !conversationId || turnActiveRef.current) return;
    setBusy('reopen');
    setError(null);
    try {
      const opened = await openHttpLinkInRailAsync({ href: kept.url, conversationId, workspace });
      useSurfaceExecutionStore.getState().noteKeptResultOpened(conversationId, {
        surfaceSessionId: opened.surfaceSessionId, state: 'closed',
      });
    } catch (caught) {
      setError(formatTemplate(copy.reopenFailed, {
        error: caught instanceof Error ? caught.message : String(caught),
      }));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [kept.url, conversationId, workspace, copy.reopenFailed]);

  const reopenMode = kept.state === 'none' ? undefined : kept.reopenMode;

  const closeSnapshot = useCallback(() => {
    if (!conversationId) return;
    const current = useSurfaceExecutionStore.getState().keptResultSnapshotByConversation[conversationId];
    useSurfaceExecutionStore.getState().noteKeptResultSnapshot(conversationId, {
      url: current?.url ?? '',
      snapshotHtml: current?.snapshotHtml ?? '',
      snapshotOpen: false,
    });
  }, [conversationId]);

  const onReopen = useCallback(async () => {
    if (!kept.url || !conversationId || turnActiveRef.current) return;
    if (kept.state === 'closed' && reopenMode === 'snapshot') {
      setBusy('reopen');
      setError(null);
      let openedSnapshot = false;
      try {
        const detailed = await getKeptResultPage(conversationId, { includeSnapshot: true });
        if (detailed.state !== 'none') {
          const html = detailed.snapshotHtml?.trim() ?? '';
          if (html) {
            useSurfaceExecutionStore.getState().noteKeptResultSnapshot(conversationId, {
              url: kept.url,
              snapshotHtml: detailed.snapshotHtml ?? html,
              snapshotOpen: true,
            });
            openedSnapshot = true;
          }
        }
      } catch {
        // Empty or failed fetch falls through to the URL path while this bar is still mounted.
      } finally {
        if (mountedRef.current) setBusy(null);
      }
      // The Browser tab may have unmounted while the snapshot was in flight.
      // Opening the POST URL from here shows an empty form, so leave the saved page in the store.
      if (openedSnapshot || !mountedRef.current) return;
    }
    await reopenByUrl();
  }, [kept.url, kept.state, reopenMode, conversationId, reopenByUrl]);

  const onTryOriginal = useCallback(async () => {
    closeSnapshot();
    await reopenByUrl();
  }, [closeSnapshot, reopenByUrl]);

  // N-FIX-FIX-BROWSER-SECRETREF-HARDEN：takeover 停靠不经过本条（聊天里的「继续」卡
  // 负责），避免同一扇窗出现两个不同口径的入口。
  const openedLivePage = kept.state === openedState && (kept.state === 'kept' || pageRunning);
  if (turnActive || openedLivePage || kept.state === 'none' || kept.reason === 'takeover') return null;

  const closedHint = kept.state === 'closed' && reopenMode === 'snapshot'
    ? copy.keptClosedSnapshotHint
    : copy.keptClosedHint;
  const showSavedSnapshot = snapshotOpen
    && kept.state === 'closed'
    && reopenMode === 'snapshot'
    && kept.url != null
    && keptSnapshot?.url === kept.url
    && Boolean(snapshotHtml?.trim());

  return (
    <>
    <div
      {...browserStageOverlayMarker}
      data-testid={`browser-kept-result-bar-${kept.state}`}
      className="absolute bottom-3 left-1/2 z-10 flex w-[min(420px,calc(100%-24px))] -translate-x-1/2 flex-col items-center gap-1.5 rounded-lg border border-white/10 bg-zinc-900/90 px-3 py-2.5 text-center shadow-lg"
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-100">
        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-badge-info" />
        {kept.state === 'kept' ? copy.keptTitle : copy.closedTitle}
      </div>
      <div className="max-w-full truncate text-[11px] text-zinc-400" title={kept.url ?? undefined}>
        {kept.title || kept.url}
      </div>
      <div className="max-w-full text-[11px] leading-relaxed text-zinc-500" data-testid="browser-kept-result-hint">
        {kept.state === 'kept' ? copy.keptHint : closedHint}
      </div>
      {kept.state === 'kept' ? (
        <Button
          variant="primary"
          size="sm"
          loading={busy === 'adopt'}
          disabled={busy !== null}
          onClick={() => void onAdopt()}
          data-testid="browser-kept-result-adopt"
        >
          {copy.keptOpen}
        </Button>
      ) : (
        <Button
          variant="primary"
          size="sm"
          loading={busy === 'reopen'}
          disabled={busy !== null || !kept.url}
          onClick={() => void onReopen()}
          data-testid="browser-kept-result-reopen"
        >
          {copy.reopen}
        </Button>
      )}
      {error && (
        <div className="max-w-full text-[11px] leading-relaxed text-badge-danger">{error}</div>
      )}
    </div>
    <Modal
      isOpen={showSavedSnapshot}
      onClose={closeSnapshot}
      title={copy.snapshotTitle}
      size="full"
      portal
    >
      <p className="mb-3 text-sm text-zinc-300" data-testid="browser-kept-result-snapshot-note">
        {copy.snapshotNote}
      </p>
      <iframe
        title={copy.snapshotTitle}
        srcDoc={snapshotHtml ?? ''}
        sandbox=""
        data-testid="browser-kept-result-snapshot-frame"
        className="pointer-events-none h-[480px] w-full border-0 bg-white"
        style={{ pointerEvents: 'none' }}
      />
      <div className="mt-3 flex justify-end">
        <Button
          variant="secondary"
          size="sm"
          loading={busy === 'reopen'}
          disabled={busy !== null}
          onClick={() => void onTryOriginal()}
          data-testid="browser-kept-result-snapshot-try-original"
        >
          {copy.snapshotTryOriginal}
        </Button>
      </div>
    </Modal>
    </>
  );
};
