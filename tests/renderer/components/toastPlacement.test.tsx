// @vitest-environment jsdom
// jsdom 没有布局：这里的用例锁「契约」（占位变量发布/清除、Footer 消费、贴底列表
// 随占位增长同帧钉底、锚定与点击穿透 class），真实几何（盒子不相交、elementFromPoint、
// 真滚动）由 web 构建的 Playwright 证据页证明（N-FIX-TOAST-COVERS-LAST-MESSAGE-ACTIONS ②）。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastContainer } from '../../../src/renderer/components/Toast';
import { setToastReserve } from '../../../src/renderer/components/toastReserve';
import { SaaSConnectorFeedback } from '../../../src/renderer/components/features/settings/sections/SaaSConnectorFeedback';
import { useToastStore } from '../../../src/renderer/hooks/useToast';
import { Z_LAYERS } from '../../../src/renderer/styles/zLayers';

vi.mock('react-virtuoso', async () => {
  const ReactModule = await import('react');
  return {
    Virtuoso: ReactModule.forwardRef(function MockVirtuoso(props: Record<string, any>, ref) {
      ReactModule.useImperativeHandle(ref, () => ({ scrollToIndex: vi.fn() }));
      const scrollerRef = ReactModule.useRef<HTMLDivElement | null>(null);
      ReactModule.useEffect(() => {
        const el = scrollerRef.current;
        if (!el || typeof props.scrollerRef !== 'function') return;
        // jsdom 没有布局：喂出可判读的贴底几何（内容 600 / 视口 100 / 贴底 scrollTop 500）。
        Object.defineProperty(el, 'scrollHeight', { value: 600, configurable: true });
        Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true });
        Object.defineProperty(el, 'scrollTop', { value: 0, writable: true, configurable: true });
        props.scrollerRef(el);
      }, []);
      const items = props.data.map((turn: any, index: number) => ReactModule.createElement(
        ReactModule.Fragment,
        { key: turn.turnId },
        props.itemContent(props.firstItemIndex + index, turn),
      ));
      // Footer 是被测契约的一半（消费 --toast-reserve），mock 里必须真渲染出来。
      return ReactModule.createElement(
        'div',
        { 'data-testid': 'virtuoso-scroller', ref: (el: HTMLDivElement | null) => { scrollerRef.current = el; } },
        ...items,
        props.components?.Footer ? ReactModule.createElement(props.components.Footer) : null,
      );
    }),
  };
});

vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const state = { currentSessionId: 'session-1', sessions: [], messages: [], runningSessionIds: new Set<string>() };
  const useSessionStore = (selector?: (value: typeof state) => unknown) => (
    selector ? selector(state) : state
  );
  useSessionStore.getState = () => state;
  return { useSessionStore };
});

vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    createForkFromReply: vi.fn(),
    sendPrompt: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/components/PermissionDialog/PermissionCard', () => ({
  PermissionCard: () => null,
}));

import { TurnBasedTraceView } from '../../../src/renderer/components/features/chat/TurnBasedTraceView';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';

const RESERVE = '--toast-reserve';

function expectBottomCenter(element: HTMLElement) {
  expect(element.classList.contains('fixed')).toBe(true);
  expect(element.classList.contains('bottom-32')).toBe(true);
  expect(element.classList.contains('left-1/2')).toBe(true);
  expect(element.classList.contains('-translate-x-1/2')).toBe(true);
  expect(element.classList.contains('max-w-sm')).toBe(true);
  expect([...element.classList].filter((name) => /^(top|right)-/.test(name))).toEqual([]);
  expect(element.style.zIndex).toBe(String(Z_LAYERS.toast));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useToastStore.setState({ toasts: [] });
  document.documentElement.style.removeProperty(RESERVE);
});

describe('toast placement keeps page-header actions clear', () => {
  it('anchors the global stack below headers and lets clicks pass through gaps', () => {
    const undo = vi.fn();
    render(<ToastContainer />);
    act(() => {
      useToastStore.getState().addToast('success', 'Expert deleted', 0, { label: 'Undo', onClick: undo });
      useToastStore.getState().addToast('error', 'Could not save changes', 0);
    });

    const cards = screen.getAllByRole('alert');
    const container = cards[0].parentElement!;
    expectBottomCenter(container);
    expect(container.classList.contains('pointer-events-none')).toBe(true);
    expect(cards.map((card) => card.textContent)).toEqual(['Expert deletedUndo', 'Could not save changes']);
    for (const card of cards) {
      expect(card.parentElement).toBe(container);
      expect(card.classList.contains('pointer-events-auto')).toBe(true);
    }

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByText('Expert deleted')).toBeNull();
    expect(screen.getByText('Could not save changes')).toBeTruthy();
  });

  it.each(['info', 'success'] as const)('anchors connector %s feedback in the same position', (kind) => {
    render(<SaaSConnectorFeedback receipt={{ kind, text: 'Connection updated' }} error={null} />);
    expectBottomCenter(screen.getByTestId('saas-connector-toast'));
  });
});

describe('toast reserve contract (toast yields to the chat list)', () => {
  it('publishes --toast-reserve from real geometry while a toast shows and clears it after removal', () => {
    vi.stubGlobal('innerHeight', 768);
    render(<ToastContainer />);
    expect(document.documentElement.style.getPropertyValue(RESERVE)).toBe('0px');

    act(() => {
      useToastStore.getState().addToast('warning', 'Upload slowed down', 0);
    });
    // jsdom 无布局：栈顶/视口高都量不出真值，按实现同源的方式喂确定性几何
    // （栈顶 600、视口底 768 → 占位 168px）。
    const container = screen.getByRole('alert').parentElement!;
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ top: 600 } as DOMRect);
    act(() => {
      useToastStore.getState().addToast('error', 'Could not save changes', 0);
    });
    expect(document.documentElement.style.getPropertyValue(RESERVE)).toBe('168px');

    act(() => {
      for (const t of useToastStore.getState().toasts) useToastStore.getState().removeToast(t.id);
    });
    expect(document.documentElement.style.getPropertyValue(RESERVE)).toBe('0px');

    // 卸载也要归零：页面切走不留残余占位
    act(() => {
      useToastStore.getState().addToast('info', 'Still here', 0);
    });
    expect(document.documentElement.style.getPropertyValue(RESERVE)).not.toBe('0px');
    cleanup();
    expect(document.documentElement.style.getPropertyValue(RESERVE)).toBe('0px');
  });

  it('the chat list Footer consumes the reserve on top of its breathing space', () => {
    const projection = projectTurns([
      { id: 'u1', role: 'user', content: '帮我总结一下', timestamp: 1_000 },
      { id: 'a1', role: 'assistant', content: '这是总结内容。', timestamp: 2_000 },
    ], 'session-1', false);
    render(<TurnBasedTraceView projection={projection} />);

    const scroller = screen.getByTestId('virtuoso-scroller');
    const footer = scroller.lastElementChild as HTMLElement;
    expect(footer.getAttribute('aria-hidden')).toBe('true');
    expect(footer.getAttribute('style')).toContain('calc(1.5rem + var(--toast-reserve, 0px))');
    // 变量发布后 Footer 不需要 React 参与：同一 DOM 节点的高度表达式由 CSS 解析
    const other = scroller.querySelector('[data-trace-turn-id]');
    expect(other).not.toBeNull();
  });

  it('re-pins the list to the bottom in the same frame when the reserve grows while it is at bottom', () => {
    const projection = projectTurns([
      { id: 'u1', role: 'user', content: '写一篇长文', timestamp: 1_000 },
      { id: 'a1', role: 'assistant', content: '（长回复，超出视口，列表贴底时操作行紧贴 composer 上缘）', timestamp: 2_000 },
    ], 'session-1', false);
    render(<TurnBasedTraceView projection={projection} />);
    const scroller = screen.getByTestId('virtuoso-scroller') as HTMLElement;

    // 贴底：内容 600 / 视口 100 / scrollTop 500。toast 出现（占位 0 → 200）必须
    // 同帧把长出的让位带滚出视口，末条消息的操作行才会升到 toast 上缘之上。
    scroller.scrollTop = 500;
    act(() => { setToastReserve(200); });
    expect(scroller.scrollTop).toBe(600);

    // 再叠一条 toast（占位继续增长）：仍贴底 → 继续钉住。
    act(() => { setToastReserve(320); });
    expect(scroller.scrollTop).toBe(600);

    // 用户上滚阅读（离底 380 > 增量+容差）：占位变化不许拖拽视口。
    scroller.scrollTop = 120;
    act(() => { setToastReserve(400); });
    expect(scroller.scrollTop).toBe(120);

    // toast 消失（回落）：由浏览器把 scrollTop 钳回新最大值，这里不滚动。
    act(() => { setToastReserve(0); });
    expect(scroller.scrollTop).toBe(120);
  });
});
