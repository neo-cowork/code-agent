import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const main = fs.readFileSync(path.join(process.cwd(), 'src-tauri/src/main.rs'), 'utf8');
const i18n = fs.readFileSync(path.join(process.cwd(), 'src-tauri/src/menu_i18n.rs'), 'utf8');
const arm = /RunEvent::MenuEvent\(event\) if event.id\(\).as_ref\(\) == "reload_window" => \{([\s\S]*?)\n {8}\}/.exec(main)?.[1];

describe('macOS Reload menu contract', () => {
  it('puts Reload with Cmd+R before a separator and fullscreen in View', () => {
    const view = main.slice(main.indexOf('let view_submenu ='), main.indexOf('let window_menu ='));
    expect(view).toContain('MenuItem::with_id(handle, "reload_window", labels.reload, true, Some("Cmd+R"))');
    expect(view.indexOf('"reload_window"')).toBeLessThan(view.indexOf('PredefinedMenuItem::separator'));
    expect(view.indexOf('PredefinedMenuItem::separator')).toBeLessThan(view.indexOf('PredefinedMenuItem::fullscreen'));
  });

  it('recovers the service then reloads main on a worker thread', () => {
    expect(arm).toBeDefined();
    expect(arm).toContain('let app = app_handle.clone()');
    expect(arm).toContain('thread::spawn(move ||');
    expect(arm).toContain('recover_web_server(&app)?');
    expect(arm).toContain('app.get_webview_window("main").ok_or(');
    expect(arm).toContain('window.reload().map_err(|error| error.to_string())?');
    expect(arm!.indexOf('thread::spawn')).toBeLessThan(arm!.indexOf('recover_web_server'));
    expect(arm!.indexOf('recover_web_server')).toBeLessThan(arm!.indexOf('window.reload()'));
  });

  it('shares the guarded self-heal with window recreation', () => {
    const recovery = main.slice(main.indexOf('fn recover_web_server('), main.indexOf('fn recreate_main_window('));
    expect(recovery).toContain('if !is_server_running()');
    expect(recovery).toContain('webserver_supervise::acquire_restart_guard()');
    expect(recovery).toContain('resident_host::decide_startup_io(');
    expect(recovery).toContain('resident_host::process_identity_matches(');
    expect(recovery).toContain('let child = start_web_server(app)?');
    expect(recovery).toContain('webserver_supervise::reset_history()');
    const recreate = main.slice(main.indexOf('fn recreate_main_window('), main.indexOf('fn show_startup_failure('));
    expect(recreate).toContain('recover_web_server(app)?');
  });

  it('records exactly one reload result including failures and guard-held reason', () => {
    expect(arm?.match(/write_shell_event\(/g)).toHaveLength(1);
    expect(arm).toContain('"desktop-shell-reload-window"');
    for (const outcome of ['reloaded', 'restarted-server', 'skipped-guard-held', 'failed']) {
      expect(arm).toContain(`"outcome": "${outcome}"`);
    }
    expect(arm).toContain('"reason": webserver_supervise::SKIP_GUARD_HELD');
    expect(arm).toContain('"error": error');
    expect(arm!.indexOf('window.reload()')).toBeLessThan(arm!.indexOf('match recovery'));
  });

  it('maps the reload id so language changes update the native menu', () => {
    expect(i18n).toContain('"reload_window" => labels.reload');
    expect(i18n).toContain('reload: "Reload"');
    expect(i18n).toContain('reload: "重新载入"');
  });
});
