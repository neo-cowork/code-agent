// ============================================================================
// useOfflinePendingSend — Surface A 离线发送挂起、对账与恢复自动重放
// ============================================================================
// 覆盖无气泡回滚路径（新会话预检离线、ProjectComposer 建会话离线等）：
// - 纯文本离线失败 → 保留输入框回滚文本 + sessionStorage 记 { composerKey, text, clientMessageId, at }
// - 带附件离线失败 → 不自动重放，出独立「网络断开，带附件未发送」提示
// - 连接恢复（eventStreamRevision 推进，或刷新后挂载即达）→ 先按 clientMessageId 对账历史消息；
//   已在历史中则静默清记录和草稿；否则沿正常提交路径复用原 clientMessageId 发送一次
// - 重放失败不再自动重武装，改出「连接恢复后仍未发出去，点发送再试」提示
// - 编辑文本 / 点「不自动发送」/ 丢弃草稿 → 清挂起记录
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { composerDraftStorageKey, removeComposerDraft } from './composerDraftStore';
import {
  clearComposerOfflineFailureRevision,
  clearOfflinePendingSend,
  getComposerOfflineFailureRevision,
  noteComposerOfflineFailureRevision,
  readOfflinePendingSend,
  writeOfflinePendingSend,
  type OfflinePendingSendRecord,
} from './offlinePendingSendStore';
import { useServerConnectionStore } from '../../../../stores/serverConnectionStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { createLogger } from '../../../../utils/logger';
import {
  finishOfflineAutoReplayAttempt,
  getOfflineAutoReplaySurface,
  markOfflineAutoReplayAttempt,
  OFFLINE_AUTO_REPLAY_MAX_AGE_MS,
} from '../../../../utils/offlineSend';

const logger = createLogger('OfflineSendReplay');

export type OfflinePendingSendStatus =
  | 'idle'
  | 'waiting'
  | 'sending'
  | 'replay_failed'
  | 'attachments_not_sent';

export interface OfflineSendFailurePayload {
  text: string;
  clientMessageId: string;
  hasAttachments: boolean;
}

interface UseOfflinePendingSendParams {
  sessionId: string | null;
  sessionless: boolean;
  scopeProjectId?: string | null;
  value: string;
  setValue: (next: string) => void;
  disabled?: boolean;
  isProcessing?: boolean;
  replayRef: React.RefObject<
    ((event?: React.FormEvent, opts?: { steer?: boolean; content?: string; clientMessageId?: string }) => Promise<boolean | void> | unknown) | null
  >;
  onDiscardDraft: () => void;
}

export interface OfflinePendingSendController {
  status: OfflinePendingSendStatus;
  suppressGenericDraftNotice: boolean;
  recordOfflineFailure: (info: OfflineSendFailurePayload) => void;
  cancelAutoSend: () => void;
  discardWithDraft: () => void;
}

export function useOfflinePendingSend(params: UseOfflinePendingSendParams): OfflinePendingSendController {
  const {
    sessionId,
    sessionless,
    scopeProjectId = null,
    value,
    setValue,
    disabled = false,
    isProcessing = false,
    replayRef,
    onDiscardDraft,
  } = params;

  const composerKey = composerDraftStorageKey(sessionId, sessionless, scopeProjectId);
  const eventStreamRevision = useServerConnectionStore((state) => state.eventStreamRevision);
  const serverStatus = useServerConnectionStore((state) => state.status);
  const sessionMessages = useSessionStore((state) => state.messages);
  const isHydratingSession = useSessionStore((state) => state.isHydratingSession);
  const isLoadingSession = useSessionStore((state) => state.isLoading);

  const [pendingRecord, setPendingRecord] = useState<OfflinePendingSendRecord | null>(() => readOfflinePendingSend(composerKey));
  const [status, setStatus] = useState<OfflinePendingSendStatus>(() => (pendingRecord ? 'waiting' : 'idle'));

  const valueRef = useRef(value);
  valueRef.current = value;
  const composerKeyRef = useRef(composerKey);
  composerKeyRef.current = composerKey;
  const replayingIdRef = useRef<string | null>(null);
  // 刷新重挂或刚回滚时把文本填进输入框的那一拍不算用户编辑。
  const hydratedTextRef = useRef<string | null>(null);
  const prevValueRef = useRef(value);

  // composerKey 切换（含首次挂载）时同步 sessionStorage 里的待发记录；输入框为空则填回原文。
  useEffect(() => {
    const existing = readOfflinePendingSend(composerKey);
    setPendingRecord(existing);
    setStatus(existing ? 'waiting' : 'idle');
    replayingIdRef.current = null;
    if (existing && !valueRef.current.trim()) {
      hydratedTextRef.current = existing.text;
      setValue(existing.text);
    }
  }, [composerKey, setValue]);

  // 等待期间用户修改了输入框文本 → 视为改主意，取消自动发送；失败提示同理在编辑后收起。
  useEffect(() => {
    const previous = prevValueRef.current;
    prevValueRef.current = value;
    if (hydratedTextRef.current !== null && value === hydratedTextRef.current) {
      hydratedTextRef.current = null;
      return;
    }
    if (previous === value) return;
    if (status === 'sending') return;

    if (pendingRecord && value !== pendingRecord.text) {
      clearOfflinePendingSend(pendingRecord.composerKey);
      clearComposerOfflineFailureRevision(pendingRecord.composerKey);
      setPendingRecord(null);
      setStatus('idle');
      return;
    }
    if ((status === 'replay_failed' || status === 'attachments_not_sent') && value !== previous) {
      setStatus('idle');
    }
  }, [pendingRecord, status, value]);

  const recordOfflineFailure = useCallback((info: OfflineSendFailurePayload) => {
    const activeKey = composerKeyRef.current;
    // 正在自动重放时再次失败 → 不重新挂起，切到「恢复后仍未发出去」独立提示。
    if (
      replayingIdRef.current === info.clientMessageId
      || getOfflineAutoReplaySurface(info.clientMessageId) === 'composer'
    ) {
      clearOfflinePendingSend(activeKey);
      clearComposerOfflineFailureRevision(activeKey ?? '');
      setPendingRecord(null);
      hydratedTextRef.current = info.text;
      setStatus('replay_failed');
      return;
    }
    if (info.hasAttachments) {
      clearOfflinePendingSend(activeKey);
      setPendingRecord(null);
      hydratedTextRef.current = info.text;
      setStatus('attachments_not_sent');
      return;
    }
    if (!activeKey || !info.text.trim()) return;
    const record: OfflinePendingSendRecord = {
      composerKey: activeKey,
      text: info.text,
      clientMessageId: info.clientMessageId,
      at: Date.now(),
    };
    writeOfflinePendingSend(record);
    noteComposerOfflineFailureRevision(activeKey, useServerConnectionStore.getState().eventStreamRevision);
    hydratedTextRef.current = info.text;
    setPendingRecord(record);
    setStatus('waiting');
  }, []);

  const cancelAutoSend = useCallback(() => {
    const activeKey = pendingRecord?.composerKey ?? composerKeyRef.current;
    clearOfflinePendingSend(activeKey);
    if (activeKey) clearComposerOfflineFailureRevision(activeKey);
    if (pendingRecord && !valueRef.current.trim()) {
      hydratedTextRef.current = pendingRecord.text;
      setValue(pendingRecord.text);
    }
    setPendingRecord(null);
    setStatus('idle');
  }, [pendingRecord, setValue]);

  const discardWithDraft = useCallback(() => {
    const activeKey = pendingRecord?.composerKey ?? composerKeyRef.current;
    clearOfflinePendingSend(activeKey);
    if (activeKey) clearComposerOfflineFailureRevision(activeKey);
    setPendingRecord(null);
    setStatus('idle');
    onDiscardDraft();
  }, [onDiscardDraft, pendingRecord]);

  // 恢复自动重放（Surface A）：先对账历史，再沿正常提交路径按原 clientMessageId 发一次。
  useEffect(() => {
    if (!pendingRecord || status !== 'waiting') return;
    if (replayingIdRef.current === pendingRecord.clientMessageId) return;
    if (disabled || isProcessing) return;
    if (!sessionless && (isHydratingSession || isLoadingSession)) return;

    // 1. 先按 clientMessageId 对账已恢复的会话历史（Codex PR #49105 规则）：
    //    若已落库且非失败气泡，绝不重发，清记录、清草稿、清输入框。
    if (!sessionless && Array.isArray(sessionMessages)) {
      const alreadyInHistory = sessionMessages.some(
        (message) => message.id === pendingRecord.clientMessageId && message.metadata?.sendFailed !== true,
      );
      if (alreadyInHistory) {
        logger.info('Surface A replay skipped: clientMessageId already in restored history', {
          composerKey: pendingRecord.composerKey,
          clientMessageId: pendingRecord.clientMessageId,
        });
        clearOfflinePendingSend(pendingRecord.composerKey);
        clearComposerOfflineFailureRevision(pendingRecord.composerKey);
        removeComposerDraft(pendingRecord.composerKey);
        setPendingRecord(null);
        setStatus('idle');
        if (valueRef.current === pendingRecord.text) {
          setValue('');
        }
        return;
      }
    }

    // 2. 可达判定：非浏览器明确 offline；同页未刷新须等 eventStreamRevision 推进（SSE 重连本身即证明可达，
    //    不与 /api/health 2s 轮询竞态）；刷新后新堆无记录，挂载且 status === 'ok' 且事件流已连上即触发。
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (eventStreamRevision < 1) return;

    const recordedRevision = getComposerOfflineFailureRevision(pendingRecord.composerKey);
    if (recordedRevision !== undefined) {
      if (eventStreamRevision <= recordedRevision) return;
    } else if (serverStatus !== 'ok') {
      return;
    }

    // 3. 同页未刷新场景下同样复核 TTL（与 Surface B 同口径）：超期不再静默执行旧指令。
    if (Date.now() - pendingRecord.at > OFFLINE_AUTO_REPLAY_MAX_AGE_MS) {
      clearOfflinePendingSend(pendingRecord.composerKey);
      clearComposerOfflineFailureRevision(pendingRecord.composerKey);
      setPendingRecord(null);
      hydratedTextRef.current = pendingRecord.text;
      if (!valueRef.current.trim()) setValue(pendingRecord.text);
      setStatus('replay_failed');
      return;
    }

    const record = pendingRecord;
    replayingIdRef.current = record.clientMessageId;
    setStatus('sending');
    markOfflineAutoReplayAttempt(record.clientMessageId, 'composer');
    logger.info('Surface A replaying offline pending send', {
      composerKey: record.composerKey,
      clientMessageId: record.clientMessageId,
      eventStreamRevision,
    });

    void (async () => {
      try {
        const result = await replayRef.current?.(undefined, {
          content: record.text,
          clientMessageId: record.clientMessageId,
        });
        clearOfflinePendingSend(record.composerKey);
        clearComposerOfflineFailureRevision(record.composerKey);
        setPendingRecord(null);
        if (result === true) {
          setStatus('idle');
        } else {
          hydratedTextRef.current = record.text;
          if (!valueRef.current.trim()) setValue(record.text);
          setStatus('replay_failed');
        }
      } catch {
        clearOfflinePendingSend(record.composerKey);
        clearComposerOfflineFailureRevision(record.composerKey);
        setPendingRecord(null);
        hydratedTextRef.current = record.text;
        if (!valueRef.current.trim()) setValue(record.text);
        setStatus('replay_failed');
      } finally {
        finishOfflineAutoReplayAttempt(record.clientMessageId);
        if (replayingIdRef.current === record.clientMessageId) {
          replayingIdRef.current = null;
        }
      }
    })();
  }, [
    disabled,
    eventStreamRevision,
    isHydratingSession,
    isLoadingSession,
    isProcessing,
    pendingRecord,
    replayRef,
    serverStatus,
    sessionMessages,
    sessionless,
    setValue,
    status,
  ]);

  return {
    status,
    suppressGenericDraftNotice: pendingRecord !== null || status !== 'idle',
    recordOfflineFailure,
    cancelAutoSend,
    discardWithDraft,
  };
}
