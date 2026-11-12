import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Hand } from 'lucide-react';
import { useI18n } from '../../../hooks/useI18n';
import { Button } from '../../primitives';
import { getKeptResultPage, type KeptResultPage } from '../../../services/userBrowserLink';

// N-FIX-FIX-BROWSER-SECRETREF-HARDEN（FB-578）：secretRef 接管停靠的聊天卡。
// run 在接管等待中结束时窗口停靠（不关窗、登录态保留），聊天里用一句大白话告诉
// 用户「浏览器交给你了，登录完点继续」。「继续」只发送一条用户消息开启下一轮——
// 绝不 resume 已完结的会话；窗被闲置回收/关闭后翻成 closed：如实说登录没保留，
// 不留死按钮。keep_result_page 的停靠不经过本卡（工作台终态条负责）。

/** 停靠可见期间的低频轮询：闲置回收发生时把「等你登录」翻成「已关闭」。 */
const PARK_STATE_POLL_MS = 30_000;

type ParkCopy = ReturnType<typeof useI18n>['t']['workbenchTabs']['agentWindow']['takeoverPark'];

function formatTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (
    vars[key] !== undefined ? vars[key] : match
  ));
}

export interface BrowserTakeoverParkCardProps {
  conversationId: string | null | undefined;
  /** 「继续」开启下一轮：发送一条用户消息（宿主接线到会话发送口）。 */
  onContinue: (message: string) => void;
}

export const BrowserTakeoverParkCard: React.FC<BrowserTakeoverParkCardProps> = ({
  conversationId,
  onContinue,
}) => {
  const { t } = useI18n();
  const copy: ParkCopy = t.workbenchTabs.agentWindow.takeoverPark;
  const [park, setPark] = useState<KeptResultPage>({ state: 'none', url: null, title: null, reason: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    const next = await getKeptResultPage(conversationId);
    if (mountedRef.current) setPark(next);
  }, [conversationId]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), PARK_STATE_POLL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const onContinueClick = useCallback(() => {
    setBusy(true);
    setError(null);
    try {
      onContinue(copy.continueMessage);
    } catch (caught) {
      setError(formatTemplate(copy.continueFailed, {
        error: caught instanceof Error ? caught.message : String(caught),
      }));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [onContinue, copy.continueMessage, copy.continueFailed]);

  if (park.reason !== 'takeover') return null;
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
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            disabled={busy}
            onClick={onContinueClick}
            data-testid="browser-takeover-park-continue"
          >
            {copy.continueAction}
          </Button>
        )}
        {error && (
          <div className="max-w-full text-[11px] leading-relaxed text-badge-danger">{error}</div>
        )}
      </div>
    </div>
  );
};
