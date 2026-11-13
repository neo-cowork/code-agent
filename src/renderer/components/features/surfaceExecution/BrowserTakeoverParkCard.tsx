import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Hand } from 'lucide-react';
import { RENDERER_POLLING } from '@shared/constants';
import { workbenchTabsEn, workbenchTabsZh } from '../../../i18n/workbenchTabs';
import { useI18n } from '../../../hooks/useI18n';
import { Button } from '../../primitives';
import { adoptKeptResultPage, getKeptResultPage, type KeptResultPage } from '../../../services/userBrowserLink';

// N-FIX-FIX-BROWSER-SECRETREF-HARDEN（FB-578）：secretRef 接管停靠的聊天卡。
// run 在接管等待中结束时窗口停靠（不关窗、登录态保留），聊天里用一句大白话告诉
// 用户「浏览器交给你了，登录完点继续」。「继续」只发送一条用户消息开启下一轮——
// 绝不 resume 已完结的会话；窗被闲置回收/关闭后翻成 closed：如实说登录没保留，
// 不留死按钮。keep_result_page 的停靠不经过本卡（工作台终态条负责）。

interface BrowserTakeoverParkCardProps {
  conversationId: string | null | undefined;
  workspace?: string | null;
  messageLanguage?: 'zh' | 'en';
  /** 「继续」开启下一轮：发送一条用户消息（宿主接线到会话发送口）。 */
  onContinue: (message: string) => void | boolean | Promise<void | boolean>;
}

export const BrowserTakeoverParkCard: React.FC<BrowserTakeoverParkCardProps> = ({
  conversationId,
  workspace,
  messageLanguage,
  onContinue,
}) => {
  const { t, language } = useI18n();
  const copy = t.workbenchTabs.agentWindow.takeoverPark;
  const continueMessage = (messageLanguage ?? language) === 'en'
    ? workbenchTabsEn.workbenchTabs.agentWindow.takeoverPark.continueMessage
    : workbenchTabsZh.workbenchTabs.agentWindow.takeoverPark.continueMessage;
  const [park, setPark] = useState<KeptResultPage>({ state: 'none', url: null, title: null, reason: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const conversationRef = useRef(conversationId);
  conversationRef.current = conversationId;

  const [pendingClaim, setPendingClaim] = useState(false);
  const [parkConversation, setParkConversation] = useState(conversationId);

  useEffect(() => {
    let cancelled = false;
    mountedRef.current = true;
    setBusy(false);
    setPendingClaim(false);
    setError(null);
    const refresh = async () => {
      const next = await getKeptResultPage(conversationId);
      if (!cancelled) {
        setParkConversation(conversationId);
        setPark(next);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), RENDERER_POLLING.KEPT_BROWSER_STATE);
    return () => {
      cancelled = true;
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [conversationId]);

  const onContinueClick = useCallback(async () => {
    if (busy || pendingClaim) return;
    setBusy(true);
    setError(null);
    try {
      // A window may have closed since the last poll. Never start a stale Continue.
      const current = await getKeptResultPage(conversationId);
      if (!mountedRef.current || conversationRef.current !== conversationId) return;
      setPark(current);
      if (current.reason !== 'takeover' || current.state !== 'kept') return;
      const sent = await onContinue(continueMessage);
      if (mountedRef.current && conversationRef.current === conversationId) {
        if (sent === false) setError(copy.continueFailed);
        else setPendingClaim(true);
      }
    } catch {
      if (mountedRef.current && conversationRef.current === conversationId) setError(copy.continueFailed);
    } finally {
      if (mountedRef.current && conversationRef.current === conversationId) setBusy(false);
    }
  }, [busy, pendingClaim, conversationId, onContinue, continueMessage, copy.continueFailed]);

  const onOpen = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await adoptKeptResultPage({ conversationId, workspace });
    } catch {
      const current = await getKeptResultPage(conversationId);
      if (mountedRef.current && conversationRef.current === conversationId) {
        setError(copy.openFailed);
        setPark(current);
      }
    } finally {
      if (mountedRef.current && conversationRef.current === conversationId) setBusy(false);
    }
  }, [conversationId, workspace, copy.openFailed]);

  if (parkConversation !== conversationId || park.reason !== 'takeover') return null;
  const alive = park.state === 'kept';

  return (
    <div
      data-testid={`browser-takeover-park-card-${park.state}`}
      className="chat-col-pad mt-2"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col items-start gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-100">
          <Hand className="h-3.5 w-3.5 shrink-0 text-badge-info" />
          {alive ? copy.parkedTitle : copy.closedTitle}
        </div>
        <div className="text-[11px] leading-relaxed text-zinc-400">
          {alive ? copy.parkedHint : copy.closedHint}
        </div>
        {alive && (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || pendingClaim}
              onClick={onOpen}
              data-testid="browser-takeover-park-open"
            >
              {copy.openAction}
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={busy || pendingClaim}
              onClick={onContinueClick}
              data-testid="browser-takeover-park-continue"
            >
              {copy.continueAction}
            </Button>
          </div>
        )}
        {error && (
          <div className="max-w-full text-[11px] leading-relaxed text-badge-danger">{error}</div>
        )}
      </div>
    </div>
  );
};
