import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const main = fs.readFileSync(path.join(process.cwd(), 'src-tauri/src/main.rs'), 'utf8');
const hook = fs.readFileSync(path.join(process.cwd(), 'src/renderer/hooks/useKeyboardShortcuts.ts'), 'utf8');

describe('macOS Settings menu contract', () => {
  it('puts Settings with Cmd+, between About and Services in the app submenu', () => {
    const submenu = main.slice(main.indexOf('let app_submenu ='), main.indexOf('let edit_submenu ='));
    expect(submenu).toContain('MenuItem::with_id(handle, "open_settings", "设置…", true, Some("Cmd+,"))');
    expect(submenu.indexOf('PredefinedMenuItem::about')).toBeLessThan(submenu.indexOf('"open_settings"'));
    expect(submenu.indexOf('"open_settings"')).toBeLessThan(submenu.indexOf('PredefinedMenuItem::services'));
  });
  it('focuses the main window and emits the same event consumed by the settings action', () => {
    const branch = /RunEvent::MenuEvent\(event\) if event.id\(\).as_ref\(\) == "open_settings" => \{([\s\S]*?)\n {8}\}/.exec(main);
    expect(branch).not.toBeNull();
    expect(branch![1]).toContain('request_main_window_focus(app_handle)');
    expect(branch![1]).toContain('app_handle.emit("menu:open-settings", ())');
    expect(hook).toMatch(/listenTauriEvent\('menu:open-settings', \(\) => \{\s*if \(!cancelled\) void runAction\('settings.open'\)/);
  });
});
