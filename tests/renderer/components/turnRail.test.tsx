// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const locale = vi.hoisted(() => ({ language: 'zh' }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: locale.language === 'en' ? en : zh, language: locale.language }) };
});

import { TurnRail } from '../../../src/renderer/components/features/chat/TurnRail';

/** 容器查询断点（与 TurnRail 内部常量一致；这里写死是为了让测试钉住用户可感知的 640px） */
const TURN_RAIL_NARROW_BELOW_PX = 640;
import { buildTurnRailItems } from '../../../src/renderer/utils/turnRailItems';
import type { TurnRailItem } from '../../../src/renderer/utils/turnRailItems';

function items(count: number): TurnRailItem[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return {
      queuedMessages: [],
      turnId: `turn-${n}`,
      turnNumber: n,
      prompt: n === 6 ? '' : `第${n}句`,
      response: n % 2 === 1 ? `结论${n}` : '',
    };
  });
}

afterEach(() => { cleanup(); locale.language = 'zh'; });

describe('TurnRail', () => {
  it.each(['zh', 'en'])('shows added message rows, totals and preview in %s and jumps to the exact node', (language) => {
    locale.language = language;
    const railItems = buildTurnRailItems(Array.from({ length: 8 }, (_, index) => ({
      turnId: `turn-${index + 1}`, turnNumber: index + 1, status: 'completed' as const, startTime: 1,
      nodes: Array.from({ length: index === 0 ? 4 : 1 }, (_, n) => ({
        id: `user-${index}-${n}`, type: 'user' as const, content: `Message ${index}-${n}`, timestamp: n,
      })),
    })));
    const onJumpToNode = vi.fn();
    render(<TurnRail items={railItems} activeTurnId="turn-8" onJump={vi.fn()} onJumpToNode={onJumpToNode} />);
    fireEvent.mouseEnter(screen.getByRole('button', { name: language === 'en' ? 'Back to turn 1' : '回到第 1 轮' }));
    expect(screen.getByRole('tooltip').textContent).toContain(language === 'en' ? 'Includes 3 added messages' : '含 3 条追加消息');
    fireEvent.click(screen.getByRole('button', { name: language === 'en' ? 'Expand list' : '展开清单' }));
    expect(screen.getByText(language === 'en' ? 'All 8 turns · 11 messages' : '全部 8 轮 · 共 11 条消息')).toBeTruthy();
    const children = screen.getAllByRole('button', { name: /^(Added|追加) · Message/ });
    expect(children.map((child) => child.textContent)).toEqual([1, 2, 3].map((n) => `${language === 'en' ? 'Added' : '追加'} · Message 0-${n}`));
    fireEvent.click(children[1]);
    expect(onJumpToNode).toHaveBeenCalledWith('turn-1', 'user-0-2');
  });

  it('preserves the English header byte-for-byte without added messages', () => {
    locale.language = 'en';
    render(<TurnRail items={items(8)} activeTurnId="turn-1" onJump={vi.fn()} onJumpToNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand list' }));
    expect(screen.getByText('All 8 turns').textContent).toBe('All 8 turns');
  });

  it('不足 8 轮不渲染（短会话不需要导航）', () => {
    const view = render(<TurnRail items={items(7)} activeTurnId="turn-3" onJumpToNode={vi.fn()} onJump={vi.fn()} />);
    expect(view.container.querySelector('[data-testid="turn-rail"]')).toBeNull();
  });

  it('每轮一格，读屏文案「回到第 N 轮」，当前轮标 aria-current', () => {
    render(<TurnRail items={items(8)} activeTurnId="turn-3" onJumpToNode={vi.fn()} onJump={vi.fn()} />);
    const ticks = screen.getAllByRole('button', { name: /^回到第 \d+ 轮$/ });
    expect(ticks).toHaveLength(8);
    expect(screen.getByRole('button', { name: '回到第 3 轮' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: '回到第 4 轮' }).getAttribute('aria-current')).toBeNull();
  });

  it('点某一格调 onJump(那一轮的 turnId)', () => {
    const onJump = vi.fn();
    render(<TurnRail items={items(8)} activeTurnId="turn-3" onJumpToNode={vi.fn()} onJump={onJump} />);
    fireEvent.click(screen.getByRole('button', { name: '回到第 5 轮' }));
    expect(onJump).toHaveBeenCalledWith('turn-5');
  });

  it('悬停一格出预览气泡：用户那句 + 本轮结论；没结论只出用户那句；没文字显示「第 N 轮」', () => {
    render(<TurnRail items={items(8)} activeTurnId="turn-3" onJumpToNode={vi.fn()} onJump={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByRole('button', { name: '回到第 5 轮' }));
    expect(screen.getByRole('tooltip').textContent).toContain('第5句');
    expect(screen.getByRole('tooltip').textContent).toContain('结论5');
    fireEvent.mouseEnter(screen.getByRole('button', { name: '回到第 4 轮' }));
    expect(screen.getByRole('tooltip').textContent).toContain('第4句');
    expect(screen.getByRole('tooltip').textContent).not.toContain('结论');
    fireEvent.mouseEnter(screen.getByRole('button', { name: '回到第 6 轮' }));
    expect(screen.getByRole('tooltip').textContent).toContain('第 6 轮');
    fireEvent.mouseLeave(screen.getByRole('button', { name: '回到第 6 轮' }));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('展开清单：标题「全部 N 轮」，每轮一行「第 N 轮 · 用户那句」，点行跳转，再点收起', () => {
    const onJump = vi.fn();
    render(<TurnRail items={items(9)} activeTurnId="turn-3" onJumpToNode={vi.fn()} onJump={onJump} />);
    fireEvent.click(screen.getByRole('button', { name: '展开清单' }));
    expect(screen.getByText('全部 9 轮')).toBeTruthy();
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(9);
    expect(rows[1].textContent).toContain('第 2 轮');
    expect(rows[1].textContent).toContain('第2句');
    expect(rows[2].getAttribute('aria-current')).toBe('true');
    fireEvent.click(rows[1].querySelector('button')!);
    expect(onJump).toHaveBeenCalledWith('turn-2');
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('窄屏用容器查询切换：刻度条只在宽容器显示，小按钮「第 N 轮」（当前轮）只在窄容器显示，点开为同一份清单', () => {
    const view = render(<TurnRail items={items(8)} activeTurnId="turn-3" onJumpToNode={vi.fn()} onJump={vi.fn()} />);
    const ticks = view.container.querySelector('[data-testid="turn-rail-ticks"]')!;
    const narrow = view.container.querySelector('[data-testid="turn-rail-narrow"]')!;
    expect(ticks.className).toContain(`@max-[${TURN_RAIL_NARROW_BELOW_PX}px]:hidden`);
    expect(narrow.className).toContain(`@min-[${TURN_RAIL_NARROW_BELOW_PX}px]:hidden`);
    fireEvent.click(screen.getByRole('button', { name: '第 3 轮' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(8);
  });

  it('刻度按可用高度收缩：每格 flex-shrink 且有最小高度，条内不再固定 10px 撑出滚动', () => {
    const view = render(<TurnRail items={items(45)} activeTurnId="turn-3" onJumpToNode={vi.fn()} onJump={vi.fn()} />);
    const tick = screen.getByRole('button', { name: '回到第 30 轮' });
    expect(tick.style.flex).toBe('0 1 10px');
    expect(tick.style.minHeight).toBe('3px');
    expect(tick.style.height).toBe('');
    const scroller = view.container.querySelector('[data-testid="turn-rail-ticks"] > div')!;
    expect(scroller.className).toContain('flex-col');
  });
});
