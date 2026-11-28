// ============================================================================
// useComposerPopoverMaxHeight —— composer 上弹面板的动态限高。
//
// 背景（FB-3234）：四个 composer popover 一律 `absolute bottom-full` 顶在输入框上沿，
// 限高写死 max-h-[280px]/[240px]，从不看上方实际剩多少空间。矮窗 + 长草稿
// （输入框撑到最大高）时 popover 顶边被推出窗口、压到 TitleBar 底下，
// 第一行 / 分类 tab 点不到。
//
// 算法（四处共用，不许各写一份）：
//   maxHeight = min(原上限, anchorTop - boundaryTop - GAP)
//   anchor   = popover 的父元素——就是它被 `bottom-full` 顶住的那个 composer 包裹层；
//   boundary = 最近的带 data-composer-popover-boundary 的祖先（ChatView 根 /
//              ProjectSpace 页容器），找不到退回 0（视口顶）。
// 限高变小后内容仍在 popover 内部滚动，sticky 头保持 sticky。
//
// 量测时机：useLayoutEffect 首测（不经过一帧旧限高），之后窗口 resize /
// composer 尺寸变化（ResizeObserver）/ 任意层 scroll（捕获）都重算，
// 只要面板开着就一直跟随。
// ============================================================================

import { useLayoutEffect, useState, type RefObject } from 'react';

const COMPOSER_POPOVER_BOUNDARY_ATTR = 'data-composer-popover-boundary';

// popover 底边与 anchor 顶之间已有 mb-1(4px)，这里再留 4px 边界呼吸量，合计 8px。
const COMPOSER_POPOVER_GAP_PX = 8;

export function useComposerPopoverMaxHeight(
  popoverRef: RefObject<HTMLElement | null>,
  capPx: number,
  active = true,
): number {
  const [maxHeight, setMaxHeight] = useState(capPx);

  useLayoutEffect(() => {
    if (!active) return;
    const popoverEl = popoverRef.current;
    const anchor = popoverEl?.parentElement;
    if (!anchor) return;
    const boundary = anchor.closest(`[${COMPOSER_POPOVER_BOUNDARY_ATTR}]`);
    const compute = () => {
      const anchorTop = anchor.getBoundingClientRect().top;
      const boundaryTop = boundary ? boundary.getBoundingClientRect().top : 0;
      setMaxHeight(Math.max(0, Math.min(capPx, Math.floor(anchorTop - boundaryTop - COMPOSER_POPOVER_GAP_PX))));
    };
    compute();
    // jsdom 无 ResizeObserver（测试环境里量测本就靠桩，跳过观察即可，同 useScrollEdgeFade 的处理）
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(compute);
    observer?.observe(anchor);
    if (boundary instanceof HTMLElement) observer?.observe(boundary);
    window.addEventListener('resize', compute);
    // capture 阶段的 scroll 覆盖消息流内任意滚动层——anchor 位置变了限高就得跟着变。
    window.addEventListener('scroll', compute, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [popoverRef, capPx, active]);

  return active ? maxHeight : capPx;
}
