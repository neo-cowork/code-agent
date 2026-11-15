// 输入框模型名的真源（N-FIX-MODEL-PICKER-SHOWS-WRONG-MODEL）。
// 渲染层原本只认两份本地副本：启动时拉的设置快照（默认模型）+ 自己点选时记下的会话 override。
// host 每轮按实时设置和实时 override 解析模型，任何一边在渲染层之外变了
// （云端下发改了默认、session/switchModel 接口直接改 override），输入框就一直显示旧的。
// 这里把 host 的 model_decision 当真源：每来一次就重拉设置与 override，
// 并在路由/回落把模型换掉时显示真正在用的那个。
import { useEffect, useRef } from 'react';
import type { ModelProvider } from '@shared/contract';
import { useStatusStore, type SessionModelDecision } from '../../stores/statusStore';

export interface DisplayedModel {
  provider: ModelProvider;
  model: string;
  /** 这一轮 host 把模型换掉了（路由/回落）：原来选的是哪个 */
  switchedFrom: { provider: string; model: string; reason: string } | null;
}

/**
 * selected = 会话 override 或默认（均已按 host 重拉）。decision 只在它确实是针对当前选择做出的
 * （requested 与 selected 一致）时才参与：用户在那之后又改了选择，就以新选择为准。
 */
export function resolveDisplayedModel(
  sessionId: string | null,
  selected: { provider: ModelProvider; model: string },
  decision: SessionModelDecision | null,
): DisplayedModel {
  if (
    decision?.sessionId !== sessionId
    || decision.requestedProvider !== selected.provider
    || decision.requestedModel !== selected.model
    || (decision.resolvedProvider === decision.requestedProvider && decision.resolvedModel === decision.requestedModel)
  ) {
    return { ...selected, switchedFrom: null };
  }
  return {
    provider: decision.resolvedProvider as ModelProvider,
    model: decision.resolvedModel,
    switchedFrom: { provider: decision.requestedProvider, model: decision.requestedModel, reason: decision.reason },
  };
}

/** 当前会话来了新的 model_decision、或窗口重新获得焦点时，回调重拉 host 状态。 */
export function useResyncModelFromHost(sessionId: string | null, resync: () => void): SessionModelDecision | null {
  const decision = useStatusStore((s) => s.lastModelDecision);
  const resyncRef = useRef(resync);
  resyncRef.current = resync;

  useEffect(() => {
    if (sessionId && decision?.sessionId === sessionId) resyncRef.current();
  }, [decision, sessionId]);

  useEffect(() => {
    // 外部（HTTP 接口 / 手机端）改了会话模型，用户切回窗口时就能看到。
    const onFocus = () => resyncRef.current();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  return decision;
}
