//! Headless proof that the quit-guard flow keeps the shell resident for a
//! scheduled-only quit. Drives the real `spawn_quit_guard_flow` on Tauri's mock
//! runtime against a loopback `/api/quit-guard` that replays the body captured
//! from the real webServer (one enabled schedule, no running task).

use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use crate::{quit_guard::QuitCoordinator, spawn_quit_guard_flow, QuitFlowOrigin};

const REAL_SERVER_BODY: &str = include_str!("quit_flow_fixtures/quit-guard-scheduled-only.json");
const TEST_TOKEN: &str = "00000000-0000-4000-8000-000000000001";

/// The flow reads process-global env (port, data dir); keep these tests serial.
static ENV_LOCK: Mutex<()> = Mutex::new(());

fn spawn_guard_server(body: &'static str) -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().expect("addr").port();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            seen.lock()
                .expect("requests mutex")
                .push(String::from_utf8_lossy(&buf[..n]).into_owned());
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    (port, requests)
}

/// Makes sure the server root the shell resolves has a `.dev-token`, removing it
/// afterwards only if this test created it.
struct TokenGuard(Option<PathBuf>);

impl TokenGuard {
    fn ensure(root: PathBuf) -> (Self, String) {
        let path = root.join(".dev-token");
        if let Ok(existing) = fs::read_to_string(&path) {
            return (Self(None), existing.trim().to_string());
        }
        fs::write(&path, TEST_TOKEN).expect("write .dev-token");
        (Self(Some(path)), TEST_TOKEN.to_string())
    }
}

impl Drop for TokenGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path);
        }
    }
}

/// 进入放有 dist/web/webServer.cjs 桩的临时目录作 cwd，Drop 时还原 cwd 并删除目录。
struct CwdGuard {
    previous: PathBuf,
    dir: PathBuf,
}

impl CwdGuard {
    fn enter_with_server_stub() -> (Self, PathBuf) {
        let dir = std::env::temp_dir().join(format!("neo-quit-flow-cwd-{}", std::process::id()));
        fs::create_dir_all(dir.join("dist/web")).expect("stub dir");
        fs::write(dir.join("dist/web/webServer.cjs"), "").expect("stub script");
        let previous = std::env::current_dir().expect("cwd");
        std::env::set_current_dir(&dir).expect("enter stub cwd");
        (Self { previous, dir: dir.clone() }, dir)
    }
}

impl Drop for CwdGuard {
    fn drop(&mut self) {
        let _ = std::env::set_current_dir(&self.previous);
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn scheduled_only_tauri_exit_stays_resident_without_dialog() {
    let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (port, requests) = spawn_guard_server(REAL_SERVER_BODY.trim());
    let data_dir = std::env::temp_dir().join(format!("neo-quit-flow-{}", std::process::id()));
    fs::create_dir_all(&data_dir).expect("data dir");
    std::env::set_var("CODE_AGENT_WEB_PORT", port.to_string());
    std::env::set_var("CODE_AGENT_DATA_DIR", &data_dir);

    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    // 与壳一样先解析 webServer 根目录，再读该根目录下的 .dev-token
    // dist/web 是 gitignored 构建产物，CI 的 cargo test 不会有：在临时 cwd 里放一个桩，
    // 让 candidate_roots 的 cwd 候选一定能解析（本机若已有真产物则取先到的候选）。
    let (_cwd_guard, _script_dir) = CwdGuard::enter_with_server_stub();
    let (_script, root) = crate::resolve_server_script(&handle)
        .expect("server root resolves via the stub in the temp cwd");
    let (_token_guard, token) = TokenGuard::ensure(root);

    let coordinator = Arc::new(QuitCoordinator::new());
    // ExitRequested 分支：先占弹框位，再把请求交给 worker
    assert!(coordinator.begin_request(), "first quit request takes the slot");
    spawn_quit_guard_flow(handle, coordinator.clone(), QuitFlowOrigin::TauriExit);

    // HideToBackground 分支以 coordinator.finish() 收尾；Confirm 分支会卡在弹框
    // （mock 应用没有 dialog 插件，worker 直接 panic），ExitNow 分支则先 allow_exit。
    // 槽位复位 = 流程走完。
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut finished = false;
    while Instant::now() < deadline && !finished {
        finished = coordinator.begin_request();
        thread::sleep(Duration::from_millis(25));
    }
    assert!(finished, "flow must finish by releasing the dialog slot");

    assert!(
        !coordinator.exit_allowed(),
        "scheduled-only quit must not grant an exit (HideToBackground, not ExitNow)"
    );
    assert!(!coordinator.background_continue(), "no detach is armed either");
    assert!(!coordinator.stop_intent_landed(), "nothing was stopped");

    let recorded = requests.lock().expect("requests mutex");
    let raw = recorded.first().expect("quit-guard was queried");
    assert!(raw.starts_with("GET /api/quit-guard HTTP/1.1"), "{raw}");
    assert!(
        raw.to_ascii_lowercase()
            .contains(&format!("authorization: bearer {token}").to_ascii_lowercase()),
        "bearer token from .dev-token is sent: {raw}"
    );
    assert_eq!(recorded.len(), 1, "exactly one query, no stop-intent POST");
    let _ = fs::remove_dir_all(data_dir);
}

// ---- Cmd+Q / macOS-terminate entry proofs (N-…-FU1-FU1) ----

use crate::quit_dialog_i18n::{background_hint, QuitDialogLanguage};
use tauri::Manager;

const EN_SERVER_BODY: &str = include_str!("quit_flow_fixtures/quit-guard-scheduled-only-en.json");

type Posted = Arc<Mutex<Vec<QuitDialogLanguage>>>;

struct Scenario {
    _app: tauri::App<tauri::test::MockRuntime>,
    handle: tauri::AppHandle<tauri::test::MockRuntime>,
    coordinator: Arc<QuitCoordinator>,
    requests: Arc<Mutex<Vec<String>>>,
    data_dir: PathBuf,
    posted: Posted,
    _cwd: CwdGuard,
    _token: TokenGuard,
}

impl Scenario {
    fn new(body: &'static str, tag: &str) -> Self {
        let (port, requests) = spawn_guard_server(body.trim());
        let data_dir = std::env::temp_dir().join(format!("neo-quit-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data_dir);
        fs::create_dir_all(&data_dir).expect("data dir");
        std::env::set_var("CODE_AGENT_WEB_PORT", port.to_string());
        std::env::set_var("CODE_AGENT_DATA_DIR", &data_dir);
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let (cwd, _) = CwdGuard::enter_with_server_stub();
        let (_script, root) = crate::resolve_server_script(&handle).expect("server root");
        let (token, _) = TokenGuard::ensure(root);
        let coordinator = Arc::new(QuitCoordinator::new());
        // 退出看门狗默认 process::exit：任何经生产入口走到退出提交点的场景都不能
        // 把整个测试二进制杀掉，先换成空实现（看门狗专项用例再覆盖成记录型）。
        coordinator.watchdog.inject(Arc::new(|_| {}), 1, None);
        app.manage(coordinator.clone());
        Self {
            _app: app,
            handle,
            coordinator,
            requests,
            data_dir,
            posted: Arc::new(Mutex::new(Vec::new())),
            _cwd: cwd,
            _token: token,
        }
    }

    fn poster(&self) -> impl FnOnce(QuitDialogLanguage) -> Result<(), String> + Send + 'static {
        let posted = self.posted.clone();
        move |language| {
            posted.lock().expect("posted").push(language);
            Ok(())
        }
    }

    /// 与 ⌘Q 一致：quit_app 菜单消费体 → exit(0) → 运行时重入 ExitRequested 处理体。
    fn press_cmd_q(&self) {
        let handle = self.handle.clone();
        let poster = self.poster();
        crate::handle_quit_app_menu(&self.handle, move |code| {
            crate::handle_exit_requested(&handle, Some(code), || {}, poster);
        });
    }

    fn wait_flow_done(&self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut finished = false;
        while Instant::now() < deadline && !finished {
            finished = self.coordinator.begin_request();
            thread::sleep(Duration::from_millis(25));
        }
        assert!(finished, "flow must finish by releasing the dialog slot");
        // 轮询探针自己占了槽位，归还以便下一次按键
        self.coordinator.finish();
    }

    fn assert_resident_no_dialog(&self) {
        assert!(!self.coordinator.exit_allowed(), "no exit granted");
        assert!(!self.coordinator.background_continue(), "no detach armed");
        assert!(!self.coordinator.stop_intent_landed(), "nothing stopped");
        let recorded = self.requests.lock().expect("requests");
        assert_eq!(recorded.len(), 1, "exactly one GET quit-guard, no stop-intent POST");
        assert!(recorded[0].starts_with("GET /api/quit-guard HTTP/1.1"), "{}", recorded[0]);
    }
}

impl Drop for Scenario {
    fn drop(&mut self) {
        self.coordinator.watchdog.simulate_process_gone();
        let _ = fs::remove_dir_all(&self.data_dir);
    }
}

#[test]
fn cmd_q_menu_entry_scheduled_only_stays_resident_without_dialog() {
    let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let s = Scenario::new(REAL_SERVER_BODY, "cmdq");
    s.press_cmd_q();
    s.wait_flow_done();
    s.assert_resident_no_dialog();
    eprintln!(
        "coordinator: exit_allowed={} background_continue={} stop_intent_landed={} slot_released=true",
        s.coordinator.exit_allowed(),
        s.coordinator.background_continue(),
        s.coordinator.stop_intent_landed()
    );
}

#[cfg(target_os = "macos")]
#[test]
fn mac_terminate_origin_scheduled_only_stays_resident_without_dialog() {
    let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let s = Scenario::new(REAL_SERVER_BODY, "macterm");
    assert!(s.coordinator.begin_request(), "terminate hook takes the slot");
    crate::spawn_quit_guard_flow_with(
        s.handle.clone(),
        s.coordinator.clone(),
        QuitFlowOrigin::MacApplicationTerminate,
        s.poster(),
    );
    s.wait_flow_done();
    s.assert_resident_no_dialog();
    eprintln!(
        "coordinator: exit_allowed={} background_continue={} stop_intent_landed={} slot_released=true",
        s.coordinator.exit_allowed(),
        s.coordinator.background_continue(),
        s.coordinator.stop_intent_landed()
    );
}

fn first_then_second_hint(body: &'static str, tag: &str, language: QuitDialogLanguage, needle: &str) {
    let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let s = Scenario::new(body, tag);
    let marker = s.data_dir.join("background-hint-shown");
    assert!(!marker.exists(), "no marker before first entry");

    s.press_cmd_q();
    s.wait_flow_done();
    {
        let posted = s.posted.lock().expect("posted");
        assert_eq!(posted.len(), 1, "first entry posts exactly one hint");
        assert_eq!(posted[0], language);
        let text = background_hint(posted[0]);
        assert!(text.contains(needle), "{text}");
    }
    assert!(marker.exists(), "marker written after the first hint");

    s.requests.lock().expect("requests").clear();
    s.press_cmd_q();
    s.wait_flow_done();
    assert_eq!(s.posted.lock().expect("posted").len(), 1, "second entry posts nothing");
}

#[test]
fn first_hint_names_quit_completely_once_zh() {
    first_then_second_hint(REAL_SERVER_BODY, "hintzh", QuitDialogLanguage::Zh, "完全退出");
}

#[test]
fn first_hint_names_quit_completely_once_en() {
    first_then_second_hint(EN_SERVER_BODY, "hinten", QuitDialogLanguage::En, "Quit Completely");
}

// ---- Cmd+Q on real-webServer fixtures: maintenance-only / user schedule / disabled ----
// Bodies in quit_flow_fixtures/quit-guard-{maintenance-only,user-schedule-enabled,
// user-schedule-disabled}.json were captured from a real webServer (fresh data dir).

const MAINTENANCE_ONLY_BODY: &str = include_str!("quit_flow_fixtures/quit-guard-maintenance-only.json");
const USER_SCHEDULE_ENABLED_BODY: &str =
    include_str!("quit_flow_fixtures/quit-guard-user-schedule-enabled.json");
const USER_SCHEDULE_DISABLED_BODY: &str =
    include_str!("quit_flow_fixtures/quit-guard-user-schedule-disabled.json");

impl Scenario {
    /// ⌘Q 同上，但数 ExitRequested 处理体里 prevent_exit 被调用的次数。
    fn press_cmd_q_counting_prevent(&self) -> usize {
        let prevented = Arc::new(Mutex::new(0usize));
        let handle = self.handle.clone();
        let poster = self.poster();
        let counter = prevented.clone();
        crate::handle_quit_app_menu(&self.handle, move |code| {
            crate::handle_exit_requested(
                &handle,
                Some(code),
                move || *counter.lock().expect("prevent counter") += 1,
                poster,
            );
        });
        let count = *prevented.lock().expect("prevent counter");
        count
    }

    /// ExitNow 分支的 app.exit(0) 在真运行时会再次触发 ExitRequested；这里手动重入，
    /// 返回这次重入里 prevent_exit 被调用的次数（0 = 退出放行）。
    fn re_enter_exit_requested(&self) -> usize {
        let prevented = Arc::new(Mutex::new(0usize));
        let counter = prevented.clone();
        crate::handle_exit_requested(
            &self.handle,
            Some(0),
            move || *counter.lock().expect("prevent counter") += 1,
            self.poster(),
        );
        let count = *prevented.lock().expect("prevent counter");
        count
    }

    fn with_shell_state(self) -> Self {
        use tauri::Manager;
        self._app.manage(crate::AppState::default());
        self
    }

    fn shutting_down(&self) -> bool {
        use tauri::Manager;
        self.handle
            .state::<crate::AppState>()
            .shutting_down
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    fn assert_real_quit_no_dialog(&self) {
        // exit_allowed() 是消费型读取：ExitNow 授予的放行由下面的重入消费并断言，这里不先读。
        assert!(!self.coordinator.background_continue(), "no detach armed");
        assert!(!self.coordinator.stop_intent_landed(), "nothing stopped");
        {
            let recorded = self.requests.lock().expect("requests");
            assert_eq!(recorded.len(), 1, "one GET quit-guard, no dialog, no stop-intent POST");
            assert!(recorded[0].starts_with("GET /api/quit-guard HTTP/1.1"), "{}", recorded[0]);
        }
        assert!(self.posted.lock().expect("posted").is_empty(), "no background hint");
        assert!(!self.data_dir.join("background-hint-shown").exists(), "no hint marker");
        assert!(!self.shutting_down(), "cleanup has not run before the exit re-entry");
        assert_eq!(self.re_enter_exit_requested(), 0, "re-entered ExitRequested is not prevented");
        assert!(self.shutting_down(), "exit proceeds through cleanup_server (shell + tray + host go)");
    }
}

fn real_quit_scenario(body: &'static str, tag: &str) {
    let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let s = Scenario::new(body, tag).with_shell_state();
    assert_eq!(s.press_cmd_q_counting_prevent(), 1, "first ExitRequested is held while the guard queries");
    s.wait_flow_done();
    s.assert_real_quit_no_dialog();
    eprintln!(
        "[{tag}] background_continue={} shutting_down={} hints={}",
        s.coordinator.background_continue(),
        s.shutting_down(),
        s.posted.lock().expect("posted").len()
    );
}

#[test]
fn cmd_q_maintenance_only_really_quits_without_dialog_or_tray() {
    real_quit_scenario(MAINTENANCE_ONLY_BODY, "maintenanceonly");
}

#[test]
fn cmd_q_user_schedule_enabled_minimizes_and_hints_once() {
    let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let s = Scenario::new(USER_SCHEDULE_ENABLED_BODY, "userenabled").with_shell_state();
    let window = tauri::WebviewWindowBuilder::new(&s._app, "main", tauri::WebviewUrl::default())
        .build()
        .expect("mock window");
    let marker = s.data_dir.join("background-hint-shown");

    assert_eq!(s.press_cmd_q_counting_prevent(), 1, "exit is prevented");
    s.wait_flow_done();
    s.assert_resident_no_dialog();
    // mock 运行时的 minimize() 是空操作、is_minimized() 恒 false，最小化本身只能真机看；
    // 这里证明走到了 minimize_and_hint（提示已发）且窗口没被销毁。
    assert!(s.handle.get_webview_window("main").is_some(), "window kept, not closed");
    drop(window);
    assert!(!s.shutting_down(), "no cleanup: shell, tray and host stay alive");
    assert_eq!(s.posted.lock().expect("posted").len(), 1, "first-time hint posted once");
    assert!(marker.exists(), "background-hint-shown marker written");

    s.requests.lock().expect("requests").clear();
    assert_eq!(s.press_cmd_q_counting_prevent(), 1, "second Cmd+Q is prevented too");
    s.wait_flow_done();
    s.assert_resident_no_dialog();
    assert!(!s.shutting_down());
    assert_eq!(s.posted.lock().expect("posted").len(), 1, "second Cmd+Q must not hint again");
}

#[test]
fn cmd_q_user_schedule_disabled_really_quits_without_dialog_or_tray() {
    real_quit_scenario(USER_SCHEDULE_DISABLED_BODY, "userdisabled");
}

// ---- Dialog answer 「后台继续」: same resident shape as scheduled-only HideToBackground ----
// show_quit_confirm_dialog 的回调只做「解析标签 → handle_quit_dialog_answer」；对话框插件在
// mock 运行时不存在，所以这里直接驱动生产的应答处理体。

type EndState = (bool, bool, bool, bool);

impl Scenario {
    /// (exit_allowed, background_continue, stop_intent_landed, slot_released)
    /// exit_allowed 是消费型读取，只在断言末尾调用一次。
    fn end_state(&self) -> EndState {
        let released = self.coordinator.begin_request();
        if released {
            self.coordinator.finish();
        }
        (
            self.coordinator.exit_allowed(),
            self.coordinator.background_continue(),
            self.coordinator.stop_intent_landed(),
            released,
        )
    }

    fn answer(&self, origin: QuitFlowOrigin, action: crate::quit_guard::QuitAnswerAction) {
        assert!(self.coordinator.begin_request(), "dialog holds the slot while open");
        crate::background_resident::handle_quit_dialog_answer(
            &self.handle,
            &self.coordinator,
            origin,
            action,
            QuitDialogLanguage::Zh,
            self.poster(),
        );
    }
}

#[test]
fn dialog_background_continue_keeps_shell_resident_and_never_exits() {
    let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let s = Scenario::new(REAL_SERVER_BODY, "dlgbg");
    let _window = tauri::WebviewWindowBuilder::new(&s._app, "main", tauri::WebviewUrl::default())
        .build()
        .expect("mock window");

    s.answer(QuitFlowOrigin::TauriExit, crate::quit_guard::QuitAnswerAction::BackgroundContinue);

    assert!(s.handle.get_webview_window("main").is_some(), "window kept, not closed");
    assert!(
        s.requests.lock().expect("requests").is_empty(),
        "no quit-intent / detach POST: nothing is stopped or handed over"
    );
    assert_eq!(s.posted.lock().expect("posted").len(), 1, "first-time hint names the tray exit");
    let state = s.end_state();
    eprintln!(
        "dialog 后台继续: exit_allowed={} background_continue={} stop_intent_landed={} slot_released={}",
        state.0, state.1, state.2, state.3
    );
    assert_eq!(state, (false, false, false, true));
}

#[test]
fn both_background_resident_paths_end_in_the_same_coordinator_state() {
    let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // path A: scheduled-only quit → QuitDecision::HideToBackground
    let a = Scenario::new(REAL_SERVER_BODY, "tableA");
    a.press_cmd_q();
    a.wait_flow_done();
    let scheduled_only = a.end_state();
    let a_hints = a.posted.lock().expect("posted").len();
    drop(a);

    // path B: dialog answer 后台继续 (every origin this platform has)
    let mut rows: Vec<(&str, EndState, usize)> = vec![("scheduled-only (HideToBackground)", scheduled_only, a_hints)];
    let mut origins = vec![("dialog 后台继续 / TauriExit", QuitFlowOrigin::TauriExit)];
    #[cfg(target_os = "macos")]
    origins.push(("dialog 后台继续 / MacApplicationTerminate", QuitFlowOrigin::MacApplicationTerminate));
    for (name, origin) in origins {
        let b = Scenario::new(REAL_SERVER_BODY, "tableB");
        b.answer(origin, crate::quit_guard::QuitAnswerAction::BackgroundContinue);
        let hints = b.posted.lock().expect("posted").len();
        rows.push((name, b.end_state(), hints));
    }
    for (name, state, hints) in &rows {
        eprintln!("| {name} | {state:?} | hints={hints} |");
    }
    assert!(
        rows.iter().all(|(_, state, hints)| *state == rows[0].1 && *hints == rows[0].2),
        "all background-resident paths must share one end state: {rows:?}"
    );
    assert_eq!(rows[0].1, (false, false, false, true));
}

// ---- 退出看门狗 + 待回复 terminate 请求（N-FIX-TRAY-FULLQUIT-SHELL-SPIN-RESIDUAL-FIX）----
// 全部经生产入口：execute_quit_exit_plan（full_quit 处理体）、handle_exit_requested、
// run_signal_exit（ctrlc handler 的函数体）、spawn_quit_guard_flow_with。
// 「主线程卡死」= mock 运行时没有事件循环：app.exit(0) 之后永远没有 RunEvent::Exit，
// 与现场「窗口/webServer 已没、进程不走」同形。时钟倍率 20：5s 宽限 = 250ms 真实时间。

mod watchdog {
    use super::*;
    use crate::exit_watchdog::{exit_deadline, EXIT_WATCHDOG_GRACE};
    use crate::quit_guard::{quit_exit_plan, QuitAnswerAction};

    const SCALE: u32 = 20;

    struct Probe {
        exits: Arc<Mutex<Vec<i32>>>,
        replies: Arc<Mutex<Vec<bool>>>,
    }

    fn closed_port() -> u16 {
        TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    fn scenario(body: &'static str, tag: &str) -> (Scenario, Probe) {
        let s = Scenario::new(body, tag).with_shell_state();
        let exits = Arc::new(Mutex::new(Vec::new()));
        let replies = Arc::new(Mutex::new(Vec::new()));
        let (e, r) = (exits.clone(), replies.clone());
        s.coordinator.watchdog.inject(
            Arc::new(move |code| e.lock().unwrap().push(code)),
            SCALE,
            Some(Arc::new(move |v| r.lock().unwrap().push(v))),
        );
        (s, Probe { exits, replies })
    }

    fn wait_fired(s: &Scenario, within: Duration) -> Option<(String, Duration)> {
        let start = Instant::now();
        while start.elapsed() < within {
            if let Some(fired) = s.coordinator.watchdog.fired_reason() {
                return Some(fired);
            }
            thread::sleep(Duration::from_millis(5));
        }
        None
    }

    /// mock 运行时的 `request_exit` 是 unimplemented!()：生产代码走到 `app.exit(0)` 即 panic。
    /// 到达这一步本身就是「退出已提交、事件循环不再回应」的现场，捕获后继续断言。
    fn until_app_exit(f: impl FnOnce()) {
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
        let err = outcome.expect_err("production path must reach app.exit(0) (unimplemented in the mock)");
        let text = err
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| err.downcast_ref::<String>().cloned())
            .unwrap_or_default();
        assert!(text.contains("not implemented"), "unexpected panic: {text}");
    }

    fn full_quit(s: &Scenario) {
        until_app_exit(|| {
            crate::execute_quit_exit_plan(
                s.handle.clone(),
                s.coordinator.clone(),
                QuitFlowOrigin::TauriExit,
                quit_exit_plan(QuitAnswerAction::Quit),
            )
        });
    }

    /// 让「停止并退出」意图 POST 失败（连接被拒）→ stop_intent_landed 不置位 → 3s 旧通道。
    fn break_intent_post() {
        std::env::set_var("CODE_AGENT_WEB_PORT", closed_port().to_string());
    }

    #[test]
    fn deadline_reuses_cleanup_budgets_plus_grace() {
        assert_eq!(exit_deadline(false), crate::GRACEFUL_SHUTDOWN_TIMEOUT + EXIT_WATCHDOG_GRACE);
        assert_eq!(exit_deadline(true), crate::resident_host::STOP_INTENT_WAIT + EXIT_WATCHDOG_GRACE);
        assert_eq!(EXIT_WATCHDOG_GRACE, Duration::from_secs(5));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_full_quit_replies_pending_terminate_request_exactly_once() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (s, probe) = scenario(REAL_SERVER_BODY, "wd-a");
        break_intent_post();
        // mac_application_should_terminate 返回 TerminateLater 时的现场
        s.coordinator.mark_terminate_reply_pending();
        assert!(s.coordinator.begin_request(), "the ⌘Q dialog is still open");
        full_quit(&s);
        assert_eq!(*probe.replies.lock().unwrap(), vec![true], "reply true exactly once");
        assert!(!s.coordinator.terminate_reply_pending());
        // 随后重入的 ExitRequested（app.exit(0) 的回声）不得二次回复
        assert_eq!(s.re_enter_exit_requested(), 0);
        assert_eq!(*probe.replies.lock().unwrap(), vec![true], "still exactly once");
        s.coordinator.watchdog.simulate_process_gone();
        eprintln!("[wd-a] replies={:?}", probe.replies.lock().unwrap());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a2_exit_requested_allowed_branch_replies_pending_request() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (s, probe) = scenario(REAL_SERVER_BODY, "wd-a2");
        s.coordinator.mark_terminate_reply_pending();
        s.coordinator.allow_exit();
        assert_eq!(s.re_enter_exit_requested(), 0);
        assert_eq!(*probe.replies.lock().unwrap(), vec![true]);
        s.coordinator.watchdog.simulate_process_gone();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a3_mac_terminate_exit_now_replies_once_and_arms_watchdog() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (s, probe) = scenario(MAINTENANCE_ONLY_BODY, "wd-a3");
        s.coordinator.mark_terminate_reply_pending();
        assert!(s.coordinator.begin_request());
        crate::spawn_quit_guard_flow_with(
            s.handle.clone(),
            s.coordinator.clone(),
            QuitFlowOrigin::MacApplicationTerminate,
            s.poster(),
        );
        let (reason, _) = wait_fired(&s, Duration::from_secs(5)).expect("stuck terminate approval is ended");
        assert_eq!(reason, "mac_terminate_pending");
        assert_eq!(*probe.replies.lock().unwrap(), vec![true], "approval replies exactly once");
        assert_eq!(*probe.exits.lock().unwrap(), vec![1]);
    }

    #[test]
    fn b_stuck_main_thread_full_quit_is_ended_by_watchdog_within_grace() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (s, probe) = scenario(REAL_SERVER_BODY, "wd-b");
        break_intent_post();
        full_quit(&s);
        assert!(!s.coordinator.stop_intent_landed(), "old 3s channel in force");
        let (reason, virtual_elapsed) = wait_fired(&s, Duration::from_secs(5)).expect("watchdog must fire");
        assert_eq!(reason, "full_quit");
        assert_eq!(*probe.exits.lock().unwrap(), vec![1], "force-exit called once");
        assert!(virtual_elapsed >= exit_deadline(false), "not before budget+grace: {virtual_elapsed:?}");
        assert!(
            virtual_elapsed < exit_deadline(false) + Duration::from_secs(5),
            "fired within the grace window: {virtual_elapsed:?}"
        );
        eprintln!("[wd-b] reason={reason} virtual_elapsed={virtual_elapsed:?}");
    }

    #[test]
    fn c_stuck_main_thread_signal_exit_is_ended_with_signal_reason() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (s, probe) = scenario(REAL_SERVER_BODY, "wd-c");
        until_app_exit(|| crate::run_signal_exit(&s.handle, &s.coordinator));
        let (reason, virtual_elapsed) = wait_fired(&s, Duration::from_secs(5)).expect("watchdog must fire");
        assert_eq!(reason, "signal");
        assert_eq!(*probe.exits.lock().unwrap(), vec![1]);
        assert!(virtual_elapsed < exit_deadline(false) + Duration::from_secs(5), "{virtual_elapsed:?}");
        eprintln!("[wd-c] reason={reason} virtual_elapsed={virtual_elapsed:?}");
    }

    #[test]
    fn d_normal_exit_finishing_in_time_is_not_killed() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (s, probe) = scenario(REAL_SERVER_BODY, "wd-d");
        break_intent_post();
        full_quit(&s);
        // 3s（虚拟）后收尸正常结束；deadline 是 8s，此刻不能开火
        thread::sleep(Duration::from_millis(150));
        assert!(s.coordinator.watchdog.fired_reason().is_none(), "no fire before the deadline");
        // 进程正常退出 = 线程随进程消失
        s.coordinator.watchdog.simulate_process_gone();
        thread::sleep(Duration::from_millis(700));
        assert!(s.coordinator.watchdog.fired_reason().is_none(), "no fire after a normal exit");
        assert!(probe.exits.lock().unwrap().is_empty(), "force-exit never called");
    }

    #[test]
    fn e_stop_intent_drain_is_not_killed_at_five_seconds() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (s, probe) = scenario(REAL_SERVER_BODY, "wd-e");
        full_quit(&s); // 回环服务器确认意图 → stop_intent_landed
        assert!(s.coordinator.stop_intent_landed(), "intent landed");
        // 真实 1.2s = 虚拟 24s：已远超 5s 与 3s+5s，但仍在 65s+5s 内
        thread::sleep(Duration::from_millis(1200));
        assert!(s.coordinator.watchdog.fired_reason().is_none(), "drain must not be killed early");
        assert!(probe.exits.lock().unwrap().is_empty());
        let (reason, virtual_elapsed) = wait_fired(&s, Duration::from_secs(8)).expect("fires once 70s are exhausted");
        assert_eq!(reason, "full_quit");
        assert!(virtual_elapsed >= exit_deadline(true), "{virtual_elapsed:?}");
        eprintln!("[wd-e] fired only at virtual {virtual_elapsed:?} (>= 70s)");
    }
}
