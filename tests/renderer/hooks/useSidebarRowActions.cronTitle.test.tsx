// @vitest-environment jsdom
import React, { useRef, useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSidebarRowActions } from '../../../src/renderer/components/features/sidebar/useSidebarRowActions';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { languages } from '../../../src/renderer/i18n';
import { getDisplaySessionTitle, splitCronSessionTitleParts } from '../../../src/renderer/utils/sessionPresentation';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

afterEach(() => { cleanup(); useAppStore.setState({ language: 'zh' }); });

it.each(['zh', 'en'] as const)('rename dialog round trip retains a recognized cron title in %s', (language) => {
  useAppStore.setState({ language });
  const renameSession = vi.fn();
  const { result } = renderHook(() => {
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const actions = useSidebarRowActions({
      showToast: vi.fn(), canOpenSessionReplay: false,
      setReplayDialog: vi.fn(), setVoiceAuditDialog: vi.fn(), setContextMenu: vi.fn(),
      renamingId, renameValue, setRenamingId, setRenameValue,
      renameInputRef: useRef<HTMLInputElement>(null), renameSession, t: languages[language],
    });
    return { ...actions, renameValue };
  });
  const session = { id: 'cron', title: '[Schedule] 周报' } as SessionWithMeta;
  act(() => result.current.handleDoubleClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.MouseEvent, session));
  expect(result.current.renameValue).toBe(language === 'zh' ? '[定时] 周报' : '[Schedule] 周报');
  act(() => result.current.handleRenameSubmit());
  const saved = renameSession.mock.calls[0][1] as string;
  expect(splitCronSessionTitleParts(saved)?.name).toBe('周报');
  expect(getDisplaySessionTitle(saved, 'zh')).toBe('[定时] 周报');
  expect(getDisplaySessionTitle(saved, 'en')).toBe('[Schedule] 周报');
});
