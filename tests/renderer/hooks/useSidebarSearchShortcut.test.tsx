// @vitest-environment jsdom
import React, { useCallback, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultKeybindingsSettings } from '../../../src/shared/keybindings';
import { useSidebarSearchShortcut } from '../../../src/renderer/components/features/sidebar/useSidebarSearchShortcut';
import { SidebarSearchDialog } from '../../../src/renderer/components/features/sidebar/SidebarSearchDialog';

vi.mock('../../../src/renderer/hooks/useKeybindingsSettings', () => ({
  useKeybindingsSettings: () => ({ keybindings: createDefaultKeybindingsSettings('darwin'), platform: 'darwin' }),
}));

function CollapsedSidebar() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('previous query');
  const openSearchDialog = useCallback(() => { setQuery(''); setOpen(true); }, []);
  const shortcut = useSidebarSearchShortcut(openSearchDialog);
  return <div aria-hidden="true" style={{ width: 0, overflow: 'hidden' }}>
    <span>{shortcut}</span>
    <SidebarSearchDialog
      isOpen={open} query={query} onQueryChange={setQuery} onClose={() => setOpen(false)}
      sessions={[]} currentSessionId={null} messageSearchHitsBySessionId={{}}
      messageSearchLoading={false} effectiveSearchScope="all" setSearchScope={() => {}}
      canSearchCurrentProject={false} onSelectSession={() => {}}
    />
  </div>;
}

afterEach(cleanup);

describe('sidebar search shortcut listener', () => {
  it('opens a focused, empty dialog outside the collapsed sidebar and resets it on reopen', async () => {
    const { container, unmount } = render(<CollapsedSidebar />);
    fireEvent(window, new CustomEvent('app:openSessionSearch'));
    const dialog = screen.getByRole('dialog', { name: '搜索会话' });
    expect(container.contains(dialog)).toBe(false);
    const input = screen.getByRole('textbox', { name: '搜索会话标题与消息内容' }) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: '周报' } });
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent(window, new CustomEvent('app:openSessionSearch'));
    const reopened = screen.getByRole('textbox', { name: '搜索会话标题与消息内容' }) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(reopened));
    expect(reopened.value).toBe('');
    unmount();
    fireEvent(window, new CustomEvent('app:openSessionSearch'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
