// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const webMode = vi.hoisted(() => ({ value: false }));
const invoke = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke, on: vi.fn(() => () => {}), invokeDomain: vi.fn() },
}));
vi.mock('../../../src/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/utils/platform')>()),
  isWebMode: () => webMode.value,
}));
vi.mock('../../../src/renderer/components/features/settings/sections/CompanionSection', () => ({
  CompanionSection: () => null,
}));

import { ChannelsSettings } from '../../../src/renderer/components/features/settings/tabs/ChannelsSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const channelTypes = [
  { type: 'http-api', name: 'HTTP API' },
  { type: 'feishu', name: '飞书' },
  { type: 'telegram', name: 'Telegram' },
];

const BANNED_PATTERN = /\breply notifications?\b|\btyping\b|\bstreaming\b|\btrace\b|\braw\b|\bpayloads?\b|\bCORS\b|HTTPS_PROXY|脱敏|\bredact(?:ed|ion)?\b/i;

beforeEach(() => {
  webMode.value = false;
  invoke.mockImplementation(async (channel: string) =>
    String(channel).toLowerCase().includes('types') ? channelTypes : []);
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
  invoke.mockReset();
});

describe.each([
  ['zh', zh],
  ['en', en],
] as const)('ChannelsSettings plain-language copy (%s)', (language, locale) => {
  const c = locale.settings.channels;

  it('renders low-distraction notes and Add-channel form surfaces without banned developer jargon while keeping mode values intact', async () => {
    useAppStore.setState({ language });
    render(<ChannelsSettings />);

    await screen.findByText(c.lowDistraction.title);
    expect(screen.getByText(c.lowDistraction.description)).toBeTruthy();
    expect(screen.getByText(c.lowDistraction.body)).toBeTruthy();

    // Open Add-channel modal (default type: http-api)
    const addButtons = screen.getAllByRole('button', { name: new RegExp(c.modal.addTitle) });
    fireEvent.click(addButtons[0]!);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeTruthy();

    // HTTP API surface: CORS label
    const corsCheckbox = screen.getByRole('checkbox', { name: c.modal.enableCors });
    expect((corsCheckbox as HTMLInputElement).checked).toBe(true);
    const httpDialogText = dialog.textContent ?? '';

    // Privacy modes select: check values and labels/descriptions
    const selects = screen.getAllByRole('combobox');
    const typeSelect = selects[0] as HTMLSelectElement;
    const privacySelect = selects[1] as HTMLSelectElement;
    const optionValues = Array.from(privacySelect.options).map((opt) => opt.value);
    expect(optionValues).toEqual(['local-redact', 'allow-raw', 'off']);

    const privacyDescriptions: string[] = [];
    for (const mode of c.privacyModes) {
      fireEvent.change(privacySelect, { target: { value: mode.value } });
      expect(screen.getByText(mode.description)).toBeTruthy();
      privacyDescriptions.push(mode.label, mode.description);
    }

    // Feishu surface
    fireEvent.change(privacySelect, { target: { value: 'local-redact' } });
    fireEvent.change(typeSelect, { target: { value: 'feishu' } });
    const feishuDialogText = dialog.textContent ?? '';
    expect(feishuDialogText).toContain(c.modal.privacyModeLabel);

    // Telegram surface: proxy placeholder
    fireEvent.change(typeSelect, { target: { value: 'telegram' } });
    const proxyInput = screen.getByPlaceholderText(c.modal.proxyUrlPlaceholder);
    expect(proxyInput).toBeTruthy();
    const telegramDialogText = dialog.textContent ?? '';

    if (process.env.DUMP_CHANNEL_MODAL_TEXT === '1') {
      console.log(`=== DOM_DUMP_${language}_HTTP_API ===\n${httpDialogText}`);
      console.log(`=== DOM_DUMP_${language}_FEISHU ===\n${feishuDialogText}`);
      console.log(`=== DOM_DUMP_${language}_TELEGRAM ===\n${telegramDialogText}\nproxyUrlPlaceholder=${(proxyInput as HTMLInputElement).placeholder}`);
    }

    const checkedSurfaces = [
      c.lowDistraction.description,
      c.lowDistraction.body,
      ...privacyDescriptions,
      c.modal.enableCors,
      c.modal.proxyUrlPlaceholder,
      httpDialogText,
      feishuDialogText,
      telegramDialogText,
    ];

    for (const text of checkedSurfaces) {
      expect(text).not.toMatch(BANNED_PATTERN);
    }
  });
});
