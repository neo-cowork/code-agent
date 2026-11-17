//! 退出看门狗（N-FIX-TRAY-FULLQUIT-SHELL-SPIN-RESIDUAL-FIX）。
//!
//! 现场（FB-1549）：托盘「完全退出」后壳进程以 99% CPU 活了 12 分钟，SIGTERM 无效。
//! 事件循环/主线程卡死时，`app.exit(0)` 之后没有任何东西能把进程带走。
//! 这里在每个「退出提交点」起一条独立线程：超过「当前生效的收尸预算 + 宽限」仍活着，
//! 就记一行带原因的日志并强退进程。预算不是固定 5s：「停止并退出」意图落地后 daemon
//! 合法排空最多 `STOP_INTENT_WAIT`（65s），所以预算按 `stop_intent_landed` 取。

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager};

use crate::quit_guard::QuitCoordinator;
use crate::resident_host::STOP_INTENT_WAIT;

/// 收尸预算之外的宽限。
pub(crate) const EXIT_WATCHDOG_GRACE: Duration = Duration::from_secs(5);
const WATCHDOG_POLL: Duration = Duration::from_millis(20);
const FORCED_EXIT_CODE: i32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ExitReason {
    FullQuit,
    Signal,
    MacTerminatePending,
    ExitRequested,
}

impl ExitReason {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ExitReason::FullQuit => "full_quit",
            ExitReason::Signal => "signal",
            ExitReason::MacTerminatePending => "mac_terminate_pending",
            ExitReason::ExitRequested => "exit_requested",
        }
    }
}

/// 当前生效的 cleanup 预算（与 `AppState::cleanup` 的两条通道一一对应）+ 宽限。
pub(crate) fn exit_deadline(stop_intent_landed: bool) -> Duration {
    let budget = if stop_intent_landed {
        STOP_INTENT_WAIT
    } else {
        crate::GRACEFUL_SHUTDOWN_TIMEOUT
    };
    budget + EXIT_WATCHDOG_GRACE
}

type ExitFn = Arc<dyn Fn(i32) + Send + Sync>;
type ReplyFn = Arc<dyn Fn(bool) + Send + Sync>;

/// 挂在 `QuitCoordinator` 上；生产默认 = `process::exit` + 真实时钟 + 真实 AppKit 回复，
/// 测试经 cfg(test) 的 setter 注入。
pub struct ExitWatchdog {
    armed: AtomicBool,
    cancelled: AtomicBool,
    exit_fn: Mutex<ExitFn>,
    /// 时钟倍率：测试把 70s 压成几十毫秒；生产恒为 1。
    time_scale: Mutex<u32>,
    reply_override: Mutex<Option<ReplyFn>>,
    fired_reason: Mutex<Option<String>>,
}

impl Default for ExitWatchdog {
    fn default() -> Self {
        Self {
            armed: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            exit_fn: Mutex::new(Arc::new(|code| std::process::exit(code))),
            time_scale: Mutex::new(1),
            reply_override: Mutex::new(None),
            fired_reason: Mutex::new(None),
        }
    }
}

impl ExitWatchdog {
    pub(crate) fn reply_override(&self) -> Option<ReplyFn> {
        self.reply_override.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    #[cfg(test)]
    pub(crate) fn inject(&self, exit_fn: ExitFn, time_scale: u32, reply: Option<ReplyFn>) {
        *self.exit_fn.lock().unwrap() = exit_fn;
        *self.time_scale.lock().unwrap() = time_scale;
        *self.reply_override.lock().unwrap() = reply;
    }

    /// 测试里模拟「进程已正常结束」：真进程退出时线程随之消失。
    #[cfg(test)]
    pub(crate) fn simulate_process_gone(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    #[cfg(test)]
    pub(crate) fn fired_reason(&self) -> Option<String> {
        self.fired_reason.lock().unwrap().clone()
    }
}

/// 在退出提交点武装看门狗（幂等：先到的原因生效）。绝不用于后台驻留 / 取消路径。
pub(crate) fn arm<R: tauri::Runtime>(
    app: &AppHandle<R>,
    coordinator: &Arc<QuitCoordinator>,
    reason: ExitReason,
) {
    let dog = &coordinator.watchdog;
    if dog.armed.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let coordinator = coordinator.clone();
    let scale = (*dog.time_scale.lock().unwrap_or_else(|e| e.into_inner())).max(1);
    let spawned = thread::Builder::new()
        .name("exit-watchdog".into())
        .spawn(move || {
            let started = Instant::now();
            loop {
                let dog = &coordinator.watchdog;
                if dog.cancelled.load(Ordering::SeqCst) {
                    return;
                }
                // 每轮重算：意图可能在武装之后才落地。
                let deadline = exit_deadline(coordinator.stop_intent_landed());
                if started.elapsed() * scale >= deadline {
                    let pending = coordinator.terminate_reply_pending();
                    let message = format!(
                        "exit watchdog fired: reason={} terminate_reply_pending={pending} deadline_s={} stop_intent_landed={}",
                        reason.as_str(),
                        deadline.as_secs(),
                        coordinator.stop_intent_landed(),
                    );
                    *dog.fired_reason.lock().unwrap_or_else(|e| e.into_inner()) =
                        Some(reason.as_str().to_string());
                    crate::log_shell_line(&app, "error", "desktop-shell-exit-watchdog-fired", &message);
                    let exit_fn = dog.exit_fn.lock().unwrap_or_else(|e| e.into_inner()).clone();
                    exit_fn(FORCED_EXIT_CODE);
                    return;
                }
                thread::sleep(WATCHDOG_POLL);
            }
        });
    if let Err(error) = spawned {
        eprintln!("exit watchdog: failed to spawn thread: {error}");
    }
}

/// 退出提交点的统一前置：若 AppKit 的 terminate 请求还悬着先回复 true（并留痕），再武装看门狗。
pub(crate) fn commit_exit<R: tauri::Runtime>(
    app: &AppHandle<R>,
    coordinator: &Arc<QuitCoordinator>,
    reason: ExitReason,
) {
    if coordinator.take_terminate_reply_pending() {
        crate::log_shell_line(
            app,
            "warn",
            "desktop-shell-terminate-reply-flushed",
            &format!("pending macOS terminate request replied true before exit: reason={}", reason.as_str()),
        );
        #[cfg(target_os = "macos")]
        crate::reply_to_mac_application_terminate(app, true);
    }
    arm(app, coordinator, reason);
}

/// 生产入口的便捷版：从 managed state 取协调器。
pub(crate) fn commit_exit_from_state<R: tauri::Runtime>(app: &AppHandle<R>, reason: ExitReason) {
    if let Some(coordinator) = app.try_state::<Arc<QuitCoordinator>>() {
        commit_exit(app, coordinator.inner(), reason);
    }
}
