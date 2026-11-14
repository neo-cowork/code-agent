import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => fs.readFileSync(path.join(process.cwd(), 'src-tauri/src', name), 'utf8');
const main = read('main.rs');
function between(start: string, end: string): string {
  const from = main.indexOf(start);
  const to = main.indexOf(end, from + start.length);
  expect(from, start).toBeGreaterThan(-1);
  expect(to, end).toBeGreaterThan(from);
  return main.slice(from, to);
}

describe('scheduled-only shell residency and explicit complete quit', () => {
  it('wires full_quit below quit_app in the tray and app menu with translated labels', () => {
    const tray = between('fn setup_tray(', 'fn request_main_window_focus(');
    expect(tray).toMatch(/\.text\("quit_app", labels\.quit\)\s*\.text\("full_quit", labels\.full_quit\)/);
    const appMenu = between('fn setup_app_menu(', 'let edit_submenu');
    expect(appMenu).toMatch(/"quit_app"[\s\S]*"full_quit", labels\.full_quit/);
    expect(read('menu_i18n.rs')).toContain('"full_quit" => labels.full_quit');
  });

  it('full_quit MenuEvent calls the shared stop sequence without a dialog or guard request', () => {
    const handler = between('RunEvent::MenuEvent(event) if event.id().as_ref() == "full_quit"', 'RunEvent::MenuEvent(event) if event.id().as_ref() == "quit_app"');
    expect(handler).toContain('execute_quit_exit_plan(');
    expect(handler).toContain('quit_guard::QuitAnswerAction::Quit');
    expect(handler).toContain('QuitFlowOrigin::TauriExit');
    for (const forbidden of ['show_quit_confirm_dialog', 'begin_request', 'query_quit_guard']) {
      expect(handler).not.toContain(forbidden);
    }
    const dialog = between('fn show_quit_confirm_dialog(', 'fn execute_quit_exit_plan(');
    expect(dialog).toContain('execute_quit_exit_plan(app, coordinator, origin, plan)');
    const helper = between('fn execute_quit_exit_plan(', 'static MAC_QUIT_GUARD_APP:');
    expect(helper).toContain('post_quit_intent(');
    expect(helper).toMatch(/set_stop_intent_landed\(\);\s*hide_windows_for_stop_wait\(&app\)/);
    expect(helper.indexOf('post_quit_intent(')).toBeLessThan(helper.indexOf('allow_exit()'));
    expect(helper).toContain('app.exit(0)');
    expect(helper).toContain('cleanup_server(&app)');
    expect(helper).toContain('reply_to_mac_application_terminate(&app, true)');
    expect(helper).not.toContain('show_quit_confirm_dialog');
  });

  it('HideToBackground in spawn_quit_guard_flow keeps the shell alive and cancels macOS terminate', () => {
    const flow = between('fn spawn_quit_guard_flow(', 'fn show_quit_confirm_dialog(');
    const arm = flow.slice(flow.indexOf('quit_guard::QuitDecision::HideToBackground'), flow.indexOf('quit_guard::QuitDecision::Confirm'));
    expect(arm).toContain('background_resident::minimize_and_hint(&app, language)');
    expect(arm).toContain('coordinator.finish()');
    expect(arm).toContain('reply_to_mac_application_terminate(&app, false)');
    for (const forbidden of ['allow_exit', 'app.exit', 'cleanup_server', 'set_background_continue', 'show_quit_confirm_dialog']) {
      expect(arm).not.toContain(forbidden);
    }
    const resident = read('background_resident.rs').split('#[cfg(test)]')[0];
    expect(resident).toContain('app.webview_windows().values()');
    expect(resident).toContain('window.minimize()');
    expect(resident).toContain('crate::real_data_dir()');
    expect(resident).toContain('crate::native_notification::post_unc(');
    expect(resident).not.toMatch(/allow_exit|app\.exit|cleanup_server/);
  });
});
