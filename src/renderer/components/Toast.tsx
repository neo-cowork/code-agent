import { HumanizedText } from './HumanizedText';
// ============================================================================
// Toast - Global toast notification component
// ============================================================================

import React from 'react';
import { Check, X, Info, AlertTriangle } from 'lucide-react';
import { useToastStore, type ToastType } from '../hooks/useToast';
import { Z_LAYERS } from '../styles/zLayers';
import { setToastReserve } from './toastReserve';

const ICON_MAP: Record<ToastType, React.ReactNode> = {
  success: <Check className="h-3.5 w-3.5" />,
  error: <X className="h-3.5 w-3.5" />,
  info: <Info className="h-3.5 w-3.5" />,
  warning: <AlertTriangle className="h-3.5 w-3.5" />,
};

const COLOR_MAP: Record<ToastType, string> = {
  success: 'border-badge-success/40 text-badge-success',
  error: 'border-red-500/40 text-badge-danger',
  info: 'border-badge-info/40 text-badge-info',
  warning: 'border-badge-warning/40 text-badge-warning',
};

export const ToastContainer: React.FC = () => {
  const { toasts, removeToast } = useToastStore();
  const stackRef = React.useRef<HTMLDivElement | null>(null);
  const lastPublishedRef = React.useRef(-1);

  // 底部居中的全局 toast 会盖住会话列表末条消息的操作行（复制/重试）。与其每个
  // 页面自己躲，不如把占位发布成根节点上的 CSS 变量 --toast-reserve：值取真实
  // 几何「栈顶到视口底的距离」（含 bottom-32 锚定偏移，即可能压到内容的整条带），
  // 消费方（TurnBasedTraceView 的列表 Footer）用它把内容顶到 toast 上缘之上，
  // 无 toast / 卸载时归零，其他页面不受影响。发布走 toastReserve 的共享契约：
  // 写变量的同帧广播事件，贴底跟随中的列表借它在同一帧内钉底（见
  // useSessionEntryScroll 的 useToastReserveBottomKeep）。值没变就不重发。
  const publishReserve = React.useCallback(() => {
    const stack = stackRef.current;
    const reserve = stack
      ? Math.max(0, window.innerHeight - stack.getBoundingClientRect().top)
      : 0;
    if (reserve === lastPublishedRef.current) return;
    lastPublishedRef.current = reserve;
    setToastReserve(reserve);
  }, []);

  // 每次 render 后重测（增删 toast 都会 render）；栈高变化（多条/换行）不一定
  // 伴随 render，用 ResizeObserver 追帧。jsdom 没有这个 API 也没有布局，跳过——
  // 契约由 renderer 测试锁字符串，几何由真浏览器证据证明。
  React.useLayoutEffect(publishReserve);
  React.useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const stack = stackRef.current;
    if (!stack) return;
    const observer = new ResizeObserver(() => publishReserve());
    observer.observe(stack);
    return () => observer.disconnect();
  });
  React.useEffect(() => () => {
    if (lastPublishedRef.current === 0) return;
    lastPublishedRef.current = 0;
    setToastReserve(0);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div ref={stackRef} className="pointer-events-none fixed bottom-32 left-1/2 -translate-x-1/2 flex flex-col gap-2 max-w-sm" style={{ zIndex: Z_LAYERS.toast }}>
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-2 px-3 py-2.5 elevation-l3 popover-enter rounded-2xl ${COLOR_MAP[t.type]}`}
          role="alert"
        >
          <span className="text-sm font-bold shrink-0 mt-0.5">{ICON_MAP[t.type]}</span>
          {/* 高度上限（现象 11）：超长错误原文（如几十条 lineage findings）超出滚动，
              不许一条 toast 占满半个屏幕。 */}
          <span className="text-sm text-zinc-200 break-words max-h-40 overflow-y-auto"><HumanizedText text={t.message} /></span>
          {t.action && (
            <button /* ds-allow:button: toast 内的描边小动作钮（不再提示），Button primitive 的主按钮语义不符 */
              onClick={() => {
                t.action!.onClick();
                removeToast(t.id);
              }}
              className="shrink-0 rounded border border-zinc-600 px-2 py-0.5 text-xs text-zinc-300 hover:border-zinc-400 hover:text-zinc-100"
            >
              <HumanizedText text={t.action.label} />
            </button>
          )}
          <button
            onClick={() => removeToast(t.id)}
            className="ml-auto text-zinc-500 hover:text-zinc-300 shrink-0"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
};
