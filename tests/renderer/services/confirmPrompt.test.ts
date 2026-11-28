// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmPromptHost } from '../../../src/renderer/components/ConfirmPromptHost';
import { requestConfirm } from '../../../src/renderer/services/confirmPrompt';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { languages } from '../../../src/renderer/i18n';

const options = { title: 'First request', message: 'First line\nSecond line', confirmText: 'Continue', variant: 'warning' } as const;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('requestConfirm', () => {
  it('logs a warning and fails closed without a host', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(requestConfirm(options)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WARN [ConfirmPrompt] Confirmation requested without a mounted host'));
  });

  it('settles the superseded request as cancelled and shows the new request', async () => {
    render(createElement(ConfirmPromptHost));
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => { first = requestConfirm(options); });
    const firstDialog = screen.getByRole('dialog', { name: options.title });
    const message = firstDialog.querySelector('p');
    expect(message?.textContent).toBe(options.message);
    expect(message?.classList.contains('whitespace-pre-line')).toBe(true);
    act(() => { second = requestConfirm({ ...options, title: 'Second request' }); });
    await expect(first).resolves.toBe(false);
    expect(screen.queryByRole('dialog', { name: options.title })).toBeNull();

    const dialog = screen.getByRole('dialog', { name: 'Second request' });
    fireEvent.click(within(dialog).getByRole('button', { name: options.confirmText }));
    await expect(second).resolves.toBe(true);
  });

  it.each(['unmount', 'backdrop', 'close'])('cancels through %s', async (action) => {
    const host = render(createElement(ConfirmPromptHost));
    let result!: Promise<boolean>;
    act(() => { result = requestConfirm(options); });
    const dialog = screen.getByRole('dialog', { name: options.title });
    const close = languages[useAppStore.getState().language].common.close;
    if (action === 'unmount') host.unmount();
    else if (action === 'backdrop') fireEvent.click(dialog.previousElementSibling!);
    else fireEvent.click(within(dialog).getByRole('button', { name: close }));
    await expect(result).resolves.toBe(false);
    expect(screen.queryByRole('dialog', { name: options.title })).toBeNull();
  });
});
