import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const main = fs.readFileSync(path.join(process.cwd(), 'src-tauri/src/main.rs'), 'utf8');

describe('macOS Dock and AppleEvent quit guard', () => {
  it('installs applicationShouldTerminate on the existing NSApplication delegate', () => {
    expect(main).toContain('install_mac_application_terminate_guard(app);');
    expect(main).toContain('class_addMethod(');
    expect(main).toContain('sel!(applicationShouldTerminate:)');
    expect(main).toContain('c"Q@:@".as_ptr()');
  });

  it('defers AppKit termination and routes the request through the shared guard flow', () => {
    const hook = /unsafe extern "C-unwind" fn mac_application_should_terminate[\s\S]*?\n\}/.exec(
      main
    );
    expect(hook, 'applicationShouldTerminate hook anchor missing').not.toBeNull();
    expect(hook![0]).toContain('NSApplicationTerminateReply::TerminateLater');
    expect(hook![0]).toContain('NSApplicationTerminateReply::TerminateCancel');
    expect(hook![0]).toContain('spawn_quit_guard_flow(');
    expect(hook![0]).toContain('QuitFlowOrigin::MacApplicationTerminate');
    expect(main).toContain('replyToApplicationShouldTerminate(should_terminate)');
    // 取消 terminate 的回复：HideToBackground / 后台继续共用 background_resident::hide_to_background，取消应答在其 StayRunning 分支
    const resident = fs.readFileSync(path.join(process.cwd(), 'src-tauri/src/background_resident.rs'), 'utf8');
    expect(resident.match(/reply_to_mac_application_terminate\(app, false\)/g)).toHaveLength(2);

    // The worker must call the existing pure decision function. This prevents a
    // second Dock/AppleEvent-specific busy/idle policy from drifting from ⌘Q.
    expect(main).toContain('quit_guard::decide_quit(outcome, coordinator.current_skip())');
  });

  it('keeps system shutdown fail-open and performs graceful cleanup on approved quit', () => {
    expect(main).toContain('if coordinator.current_skip().is_some() || coordinator.exit_allowed()');
    expect(main).toContain('if plan.cleanup_server {');
    expect(main).toContain('cleanup_server(&app);');
  });

  // 无头限制：reply_to_mac_application_terminate 需要真实 NSApplication，AppleEvent/Dock 来源的
  // 整条流程无法在无头环境里跑。TauriExit 来源由 src-tauri/src/quit_flow_tests.rs 真跑
  // spawn_quit_guard_flow；这里只钉死两个来源「只在收尾方式上不同」，决策共用同一个 decide_quit。
  it('keeps the two quit origins identical except for how they finish', () => {
    const flow = /fn spawn_quit_guard_flow_with<[^>]+>\([\s\S]*?\n\}\n/.exec(main);
    expect(flow, 'spawn_quit_guard_flow_with anchor missing').not.toBeNull();
    const body = flow![0];

    expect(body.match(/decide_quit\(/g)).toHaveLength(1);

    const exitNow = /QuitDecision::ExitNow => \{([\s\S]*?)\n {12}\}\n {12}quit_guard::QuitDecision::HideToBackground/.exec(body);
    expect(exitNow, 'ExitNow arm anchor missing').not.toBeNull();
    expect(exitNow![1]).toContain('QuitFlowOrigin::TauriExit => app.exit(0),');
    expect(exitNow![1]).toContain('reply_to_mac_application_terminate(&app, true);');

    const hide = /QuitDecision::HideToBackground \{ language \} => \{([\s\S]*?)\n {12}\}\n {12}quit_guard::QuitDecision::Confirm/.exec(body);
    expect(hide, 'HideToBackground arm anchor missing').not.toBeNull();
    // 收尾（最小化、释放槽位、mac 取消 terminate）收在 hide_to_background 里，对话框「后台继续」共用
    expect(hide![1]).toContain('background_resident::hide_to_background(&app, &coordinator, origin, language, hint_poster);');
    expect(hide![1]).not.toContain('app.exit(0)');

    // origin 只在三个「怎么收尾」的位置被读取：ExitNow 的 match、HideToBackground 的 matches!、
    // Confirm 分支把它原样传给对话框。其余地方出现 origin 就说明两个来源开始分叉。
    const originUses = body.split('\n').filter((line) => /\borigin\b/.test(line) && !line.includes('origin: QuitFlowOrigin'));
    expect(originUses.map((line) => line.trim())).toEqual([
      'match origin {',
      'background_resident::hide_to_background(&app, &coordinator, origin, language, hint_poster);',
      'origin,',
    ]);

    // 两个入口都汇入同一个函数，只传不同的 origin。
    expect(main).toMatch(/prevent_exit\(\);[\s\S]*?spawn_quit_guard_flow_with\(\s*app_handle\.clone\(\),\s*coordinator\.inner\(\)\.clone\(\),\s*QuitFlowOrigin::TauriExit,/);
    expect(main).toMatch(/spawn_quit_guard_flow\([^)]*QuitFlowOrigin::MacApplicationTerminate/);
    // 菜单/托盘「退出」(quit_app) 只是 exit(0)，随后落进上面的 ExitRequested 受守卫分支。
    expect(main).toMatch(/"quit_app" => \{\s*handle_quit_app_menu\(app_handle, \|code\| app_handle\.exit\(code\)\);/);
    expect(main).toMatch(/fn handle_quit_app_menu[^{]*\{\s*request_exit\(0\);/);
  });
});
