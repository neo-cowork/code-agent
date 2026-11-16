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
