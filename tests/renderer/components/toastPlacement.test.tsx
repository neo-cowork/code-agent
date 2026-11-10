// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastContainer } from '../../../src/renderer/components/Toast';
import { SaaSConnectorFeedback } from '../../../src/renderer/components/features/settings/sections/SaaSConnectorFeedback';
import { useToastStore } from '../../../src/renderer/hooks/useToast';
import { Z_LAYERS } from '../../../src/renderer/styles/zLayers';

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
  useToastStore.setState({ toasts: [] });
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
