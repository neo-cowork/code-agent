// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftingStopButton } from '../../../src/renderer/components/features/chat/ChatInput/DraftingStopButton';
import { en } from '../../../src/renderer/i18n/en';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: en }),
}));

afterEach(cleanup);

const states = [false, true];
const matrix = states.flatMap(isProcessing =>
  states.flatMap(hasContent =>
    states.flatMap(hasStoppableBackgroundWork =>
      states.map(isStopping => ({ isProcessing, hasContent, hasStoppableBackgroundWork, isStopping })),
    ),
  ),
);

describe('DraftingStopButton', () => {
  it.each(matrix)('renders for the expected state (%j)', (props) => {
    render(<DraftingStopButton {...props} />);
    const button = screen.queryByTestId('composer-stop-while-drafting');
    if (props.hasContent && (props.isProcessing || props.hasStoppableBackgroundWork)) {
      const label = props.isStopping ? en.chatInput.stoppingAria : en.chatInput.stopAria;
      expect(button).toBe(screen.getByRole('button', { name: label }));
      expect(button?.getAttribute('title')).toBe(label);
      expect(button?.querySelector('.animate-spin') !== null).toBe(props.isStopping);
    } else {
      expect(button).toBeNull();
    }
  });

  it.each(states)('only invokes stop on click (isStopping=%s)', (isStopping) => {
    const onStop = vi.fn();
    const onClick = vi.fn();
    const onSubmit = vi.fn(event => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <DraftingStopButton isProcessing hasContent isStopping={isStopping} onStop={onStop} />
        <button type="submit" onClick={onClick}>Send</button>
      </form>,
    );

    fireEvent.click(screen.getByTestId('composer-stop-while-drafting'));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
