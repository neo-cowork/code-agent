// 全局 toast 让位机制的中枢契约：发布方是 ToastContainer（components/Toast.tsx），
// 消费方是会话列表（features/chat/useSessionEntryScroll.ts 的钉底钩子）。变量挂在
// 根节点上由 CSS 消费（列表 Footer 高度）；事件与变量同步发出，让消费方在同一帧
// 内按新几何行动（读 scroller.scrollHeight 会触发同步重排，拿到的已是新 Footer 高）。
const TOAST_RESERVE_VAR = '--toast-reserve';
const TOAST_RESERVE_CHANGE_EVENT = 'toast-reserve-change';

/** 把当前 toast 占位（px）发布到根节点，并同步广播给订阅方；0 表示无 toast。 */
export function setToastReserve(reserve: number): void {
  document.documentElement.style.setProperty(TOAST_RESERVE_VAR, `${reserve}px`);
  window.dispatchEvent(new CustomEvent(TOAST_RESERVE_CHANGE_EVENT, { detail: { reserve } }));
}

/** 订阅占位变化（含归零），返回取消订阅函数。 */
export function subscribeToastReserveChange(listener: (reserve: number) => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ reserve: number }>).detail;
    if (detail && typeof detail.reserve === 'number') listener(detail.reserve);
  };
  window.addEventListener(TOAST_RESERVE_CHANGE_EVENT, handler);
  return () => window.removeEventListener(TOAST_RESERVE_CHANGE_EVENT, handler);
}
