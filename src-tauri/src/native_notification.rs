use serde::Serialize;
use std::{path::Path, time::Duration};

#[derive(Debug, PartialEq, Eq)]
pub struct NotifyOnlyArgs {
    title: String,
    body: String,
    id: String,
    session_id: String,
}

/// Arguments exclude argv[0]. Consume flag/value pairs, including values starting with --.
pub fn parse_notify_only_args(args: &[String]) -> Option<NotifyOnlyArgs> {
    if args.first()?.as_str() != "--notify-only" || args.len() != 9 {
        return None;
    }
    let (mut title, mut body, mut id, mut session_id) = (None, None, None, None);
    for pair in args[1..].chunks_exact(2) {
        let slot = match pair[0].as_str() {
            "--title" => &mut title,
            "--body" => &mut body,
            "--id" => &mut id,
            "--session" => &mut session_id,
            _ => return None,
        };
        if slot.is_some() || pair[1].is_empty() {
            return None;
        }
        *slot = Some(pair[1].clone());
    }
    Some(NotifyOnlyArgs {
        title: title?,
        body: body?,
        id: id?,
        session_id: session_id?,
    })
}

/// A failed lookup leaves the host's missing-executable warning path available.
pub fn shell_executable_path() -> std::path::PathBuf {
    std::env::current_exe().unwrap_or_else(|error| {
        eprintln!("[native_notification] notify-only-executable-lookup-failed: {error}");
        std::path::PathBuf::new()
    })
}

/// Run before Builder/single-instance. Never initialize an application or a window here.
pub fn dispatch_notify_only() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("--notify-only") {
        return;
    }
    let Some(args) = parse_notify_only_args(&args) else {
        eprintln!("[native_notification] notify-only-invalid-args");
        std::process::exit(2);
    };
    let bundled = std::env::current_exe()
        .map(|exe| exe_is_in_app_bundle(&exe))
        .unwrap_or(false);
    if decide_backend(bundled, cfg!(target_os = "macos")) != NotificationBackend::Unc {
        eprintln!("[native_notification] notify-only-backend-unavailable");
        std::process::exit(3);
    }
    #[cfg(target_os = "macos")]
    let result = objc2::exception::catch(std::panic::AssertUnwindSafe(|| {
        post_unc_with_session(
            &args.title,
            &args.body,
            Some(&args.id),
            Some(&args.session_id),
        )
    }))
    .unwrap_or_else(|_| Err("notify-only-objective-c-exception".to_string()));
    #[cfg(not(target_os = "macos"))]
    let result = {
        let _ = args;
        Err::<(), _>("notify-only-platform-unsupported".to_string())
    };
    match result {
        Ok(()) => std::process::exit(0),
        Err(reason) => {
            eprintln!("[native_notification] notify-only-post-failed: {reason}");
            std::process::exit(4);
        }
    }
}

/// Completion of `addNotificationRequest` is local and fast.
const UNC_CALLBACK_TIMEOUT: Duration = Duration::from_secs(2);
/// The first authorization request shows a system prompt that only calls back after the
/// user answers, so it needs a human-scale wait. Already-decided states return at once.
const UNC_AUTHORIZATION_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationBackend {
    Unc,
    Legacy,
}

/// Select the only backend that is safe for this process and executable shape.
pub fn decide_backend(in_app_bundle: bool, is_macos: bool) -> NotificationBackend {
    if is_macos && in_app_bundle {
        NotificationBackend::Unc
    } else {
        NotificationBackend::Legacy
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PostSystemNotificationResult {
    pub backend: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

fn legacy_result(reason: impl Into<String>) -> PostSystemNotificationResult {
    PostSystemNotificationResult {
        backend: "legacy-needed".to_string(),
        ok: false,
        reason: Some(reason.into()),
    }
}

fn unc_result(ok: bool, reason: Option<String>) -> PostSystemNotificationResult {
    PostSystemNotificationResult {
        backend: "unc".to_string(),
        ok,
        reason,
    }
}

fn exe_is_in_app_bundle(exe: &Path) -> bool {
    exe.to_string_lossy().contains(".app/Contents/MacOS/")
}

/// Private metadata key; the value is the renderer's NotificationShowEvent.id.
const NOTIFICATION_ID_KEY: &str = "neoNotificationId";
const SESSION_ID_KEY: &str = "neoSessionId";

fn notification_id(user_info: &serde_json::Value) -> Option<&str> {
    user_info
        .get(NOTIFICATION_ID_KEY)?
        .as_str()
        .filter(|id| !id.is_empty())
}

fn clicked_payload(id: &str, session_id: Option<&str>) -> serde_json::Value {
    let mut payload = serde_json::json!({ "id": id });
    if let Some(session_id) = session_id.filter(|id| !id.is_empty()) {
        payload["sessionId"] = serde_json::json!(session_id);
    }
    payload
}

#[derive(Default)]
struct ClickDelivery {
    ready: bool,
    pending: Vec<serde_json::Value>,
}

impl ClickDelivery {
    fn receive(&mut self, payload: serde_json::Value) -> Option<serde_json::Value> {
        if self.ready {
            return Some(payload);
        }
        self.pending.push(payload);
        None
    }

    fn renderer_ready(&mut self) -> Vec<serde_json::Value> {
        self.ready = true;
        std::mem::take(&mut self.pending)
    }

    /// The event transport may be unavailable. The timer and event compete under
    /// the same mutex, so only the first release drains the queue (and may warn).
    fn renderer_ready_timeout(
        &mut self,
        elapsed: Duration,
    ) -> Option<(&'static str, Vec<serde_json::Value>)> {
        if self.ready || elapsed < crate::RENDERER_READY_TIMEOUT {
            return None;
        }
        Some(("notification-click-ready-timeout", self.renderer_ready()))
    }
}

#[cfg(target_os = "macos")]
mod delegate {
    use super::{
        clicked_payload, notification_id, ClickDelivery, NOTIFICATION_ID_KEY, SESSION_ID_KEY,
    };
    use block2::DynBlock;
    use objc2::{
        define_class, msg_send, rc::Retained, runtime::ProtocolObject, AnyThread, DefinedClass,
    };
    use objc2_foundation::{NSObject, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNNotification, UNNotificationPresentationOptions, UNNotificationResponse,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use std::sync::{Arc, Mutex};
    use tauri::{AppHandle, Emitter, Listener};

    struct DelegateIvars {
        app: AppHandle,
        focus: fn(&AppHandle) -> bool,
        clicks: Arc<Mutex<ClickDelivery>>,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements. The ivars are immutable
        // and thread-safe; UNC may invoke its delegate on a background queue.
        #[unsafe(super = NSObject)]
        #[ivars = DelegateIvars]
        struct NotificationDelegate;

        unsafe impl NSObjectProtocol for NotificationDelegate {}

        unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive_response(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion: &DynBlock<dyn Fn()>,
            ) {
                let user_info = response.notification().request().content().userInfo();
                let key = NSString::from_str(NOTIFICATION_ID_KEY);
                // userInfo is untyped: never send NSString messages to a wrong-type value.
                let value = user_info
                    .objectForKey(&key)
                    .and_then(|value| value.downcast_ref::<NSString>().map(|id| id.to_string()));
                let session_id = user_info
                    .objectForKey(&NSString::from_str(SESSION_ID_KEY))
                    .and_then(|value| value.downcast_ref::<NSString>().map(|id| id.to_string()));
                let metadata = serde_json::json!({ NOTIFICATION_ID_KEY: value });
                if let Some(id) = notification_id(&metadata) {
                    let ivars = self.ivars();
                    if !(ivars.focus)(&ivars.app) {
                        eprintln!("[native_notification] WARN notification-click focus failed");
                    }
                    let payload = ivars
                        .clicks
                        .lock()
                        .expect("notification click mutex poisoned")
                        .receive(clicked_payload(id, session_id.as_deref()));
                    if let Some(Err(error)) =
                        payload.map(|payload| ivars.app.emit("notification-clicked", payload))
                    {
                        eprintln!(
                            "[native_notification] WARN notification-click emit failed: {error}"
                        );
                    }
                }
                // Also acknowledge old notifications without an id; exactly one call.
                completion.call(());
            }

            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                completion.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List,));
            }
        }
    );

    pub(super) fn install(
        app: AppHandle,
        focus: fn(&AppHandle) -> bool,
    ) -> Result<(), &'static str> {
        let installed_at = std::time::Instant::now();
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let clicks = Arc::new(Mutex::new(ClickDelivery::default()));
        let ready_clicks = clicks.clone();
        let ready_app = app.clone();
        // Reuse the existing renderer-ready signal; the renderer sends it only after
        // its click listener is registered. UNC can deliver a cold-launch response first.
        app.listen("renderer-ready", move |_| {
            let pending = ready_clicks
                .lock()
                .expect("notification click mutex poisoned")
                .renderer_ready();
            for payload in pending {
                if let Err(error) = ready_app.emit("notification-clicked", payload) {
                    eprintln!(
                        "[native_notification] WARN queued notification-click emit failed: {error}"
                    );
                }
            }
        });
        let timeout_app = app.clone();
        let timeout_clicks = clicks.clone();
        let this = NotificationDelegate::alloc().set_ivars(DelegateIvars { app, focus, clicks });
        // SAFETY: NSObject's init has this signature and initializes our superclass.
        let delegate: Retained<NotificationDelegate> = unsafe { msg_send![super(this), init] };
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        if center.delegate().is_none() {
            return Err("delegate missing after setDelegate");
        }
        // setDelegate is weak. Keep this one delegate, including its AppHandle,
        // alive until process exit, independent of the setup stack frame.
        std::mem::forget(delegate);
        // Reuse the shell's window-ready budget. A timer drains even a lone click;
        // waiting for the next click would leave the original one stuck forever.
        std::thread::spawn(move || {
            std::thread::sleep(
                crate::RENDERER_READY_TIMEOUT.saturating_sub(installed_at.elapsed()),
            );
            let release = timeout_clicks
                .lock()
                .expect("notification click mutex poisoned")
                .renderer_ready_timeout(installed_at.elapsed());
            if let Some((reason, pending)) = release {
                eprintln!(
                    "[native_notification] WARN {reason}: released {} queued click(s)",
                    pending.len()
                );
                for payload in pending {
                    if let Err(error) = timeout_app.emit("notification-clicked", payload) {
                        eprintln!(
                            "[native_notification] WARN timed-out notification-click emit failed: {error}"
                        );
                    }
                }
            }
        });
        Ok(())
    }
}

/// Called once during setup; never touch UNC in an unbundled executable.
pub fn install_notification_delegate(app: tauri::AppHandle, focus: fn(&tauri::AppHandle) -> bool) {
    #[cfg(target_os = "macos")]
    {
        static INSTALL: std::sync::Once = std::sync::Once::new();
        let in_app_bundle = match std::env::current_exe() {
            Ok(exe) => exe_is_in_app_bundle(&exe),
            Err(error) => {
                eprintln!(
                    "[native_notification] WARN delegate install executable lookup failed: {error}"
                );
                return;
            }
        };
        if decide_backend(in_app_bundle, true) != NotificationBackend::Unc {
            return;
        }
        INSTALL.call_once(|| {
            // The bundle guard is mandatory even with exception handling: UNC raises
            // an ObjC exception when called from a plain cargo/test executable.
            let result = objc2::exception::catch(std::panic::AssertUnwindSafe(|| {
                delegate::install(app, focus)
            }));
            match result {
                Ok(Ok(())) => {}
                Ok(Err(reason)) => {
                    eprintln!("[native_notification] WARN delegate install failed: {reason}")
                }
                Err(_) => eprintln!(
                    "[native_notification] WARN delegate install failed: Objective-C exception"
                ),
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, focus);
}

#[cfg(target_os = "macos")]
pub fn post_unc(title: &str, body: &str, id: Option<&str>) -> Result<(), String> {
    // Guard the shared entry point so shell hints and IPC callers are equally safe.
    let in_app_bundle = std::env::current_exe()
        .map(|exe| exe_is_in_app_bundle(&exe))
        .unwrap_or(false);
    if decide_backend(in_app_bundle, true) != NotificationBackend::Unc {
        return Err("UNUserNotificationCenter is reserved for macOS app bundles".to_string());
    }
    objc2::exception::catch(std::panic::AssertUnwindSafe(|| {
        post_unc_with_session(title, body, id, None)
    }))
    .unwrap_or_else(|_| Err("notification-objective-c-exception".to_string()))
}

#[cfg(target_os = "macos")]
fn post_unc_with_session(
    title: &str,
    body: &str,
    id: Option<&str>,
    session_id: Option<&str>,
) -> Result<(), String> {
    use block2::RcBlock;
    use objc2::rc::autoreleasepool;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSDictionary, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest,
        UNUserNotificationCenter,
    };
    use std::sync::mpsc;

    autoreleasepool(|_| {
        let center = UNUserNotificationCenter::currentNotificationCenter();

        let (authorization_sender, authorization_receiver) = mpsc::channel();
        let authorization_completion: RcBlock<dyn Fn(Bool, *mut NSError)> =
            RcBlock::new(move |granted: Bool, error: *mut NSError| {
                let granted = granted.as_bool();
                let result = if !error.is_null() && !granted {
                    Err("UNUserNotificationCenter authorization request failed".to_string())
                } else {
                    Ok(granted)
                };
                let _ = authorization_sender.send(result);
            });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert,
            &authorization_completion,
        );

        let authorized = authorization_receiver
            .recv_timeout(UNC_AUTHORIZATION_TIMEOUT)
            .map_err(|_| "UNUserNotificationCenter authorization timed out".to_string())??;
        if !authorized {
            return Err("UNUserNotificationCenter authorization denied".to_string());
        }

        let content = UNMutableNotificationContent::new();
        let title = NSString::from_str(title);
        let body = NSString::from_str(body);
        content.setTitle(&title);
        content.setBody(&body);
        if let Some(id) = id {
            let key = NSString::from_str(NOTIFICATION_ID_KEY);
            let value = NSString::from_str(id);
            let session_key = NSString::from_str(SESSION_ID_KEY);
            let session_value = session_id.map(NSString::from_str);
            let mut keys = vec![&*key];
            let mut values = vec![&*value];
            if let Some(ref session_value) = session_value {
                keys.push(&*session_key);
                values.push(&**session_value);
            }
            let user_info = NSDictionary::<NSString, NSString>::from_slices(&keys, &values);
            // SAFETY: Erase only the dictionary's generic parameters. Both objects
            // are NSStrings, so userInfo contains property-list-compatible metadata.
            let user_info =
                unsafe { objc2::rc::Retained::cast_unchecked::<NSDictionary>(user_info) };
            unsafe { content.setUserInfo(&user_info) };
        }

        let identifier = NSString::from_str(&format!(
            "agent-neo-notification-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &identifier,
            &content,
            None,
        );

        let (sender, receiver) = mpsc::channel();
        let completion: RcBlock<dyn Fn(*mut NSError)> = RcBlock::new(move |error: *mut NSError| {
            let result = if error.is_null() {
                Ok(())
            } else {
                Err("UNUserNotificationCenter rejected notification request".to_string())
            };
            let _ = sender.send(result);
        });
        center.addNotificationRequest_withCompletionHandler(&request, Some(&completion));
        receiver
            .recv_timeout(UNC_CALLBACK_TIMEOUT)
            .map_err(|_| "UNUserNotificationCenter notification request timed out".to_string())?
    })
}

#[cfg(not(target_os = "macos"))]
pub fn post_unc(_title: &str, _body: &str, _id: Option<&str>) -> Result<(), String> {
    Err("UNUserNotificationCenter is only available on macOS".to_string())
}

#[tauri::command]
pub async fn post_system_notification(
    title: String,
    body: String,
    id: Option<String>,
) -> PostSystemNotificationResult {
    let in_app_bundle = std::env::current_exe()
        .map(|exe| exe_is_in_app_bundle(&exe))
        .unwrap_or(false);
    match decide_backend(in_app_bundle, cfg!(target_os = "macos")) {
        NotificationBackend::Legacy => legacy_result(if cfg!(target_os = "macos") {
            "UNUserNotificationCenter is reserved for macOS app bundles"
        } else {
            "UNUserNotificationCenter is only available on macOS"
        }),
        NotificationBackend::Unc => {
            let outcome =
                tokio::task::spawn_blocking(move || post_unc(&title, &body, id.as_deref())).await;
            match outcome {
                Ok(Ok(())) => unc_result(true, None),
                Ok(Err(reason)) => unc_result(false, Some(reason)),
                Err(error) => {
                    unc_result(false, Some(format!("notification worker failed: {error}")))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        decide_backend, NotificationBackend, PostSystemNotificationResult,
        UNC_AUTHORIZATION_TIMEOUT, UNC_CALLBACK_TIMEOUT,
    };

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    #[test]
    fn parse_notify_only_args_valid() {
        let parsed = super::parse_notify_only_args(&args(&[
            "--notify-only",
            "--title",
            "Title",
            "--body",
            "Body",
            "--id",
            "n1",
            "--session",
            "s1",
        ]))
        .unwrap();
        assert_eq!(
            parsed,
            super::NotifyOnlyArgs {
                title: "Title".into(),
                body: "Body".into(),
                id: "n1".into(),
                session_id: "s1".into()
            }
        );
    }

    #[test]
    fn parse_notify_only_args_missing_fields() {
        let valid = args(&[
            "--notify-only",
            "--title",
            "Title",
            "--body",
            "Body",
            "--id",
            "n1",
            "--session",
            "s1",
        ]);
        for end in 1..valid.len() {
            assert!(super::parse_notify_only_args(&valid[..end]).is_none());
        }
        for field in [1, 3, 5, 7] {
            let mut missing = valid.clone();
            missing.drain(field..field + 2);
            assert!(super::parse_notify_only_args(&missing).is_none());
        }
    }

    #[test]
    fn parse_notify_only_args_no_flag() {
        assert!(super::parse_notify_only_args(&[]).is_none());
        assert!(super::parse_notify_only_args(&args(&["--title", "Title"])).is_none());
    }

    #[test]
    fn parse_notify_only_args_values_starting_with_flags() {
        let parsed = super::parse_notify_only_args(&args(&[
            "--notify-only",
            "--title",
            "--body",
            "--body",
            "--notify-only",
            "--id",
            "--id",
            "--session",
            "--session",
        ]))
        .unwrap();
        assert_eq!(parsed.title, "--body");
        assert_eq!(parsed.body, "--notify-only");
        assert_eq!(parsed.id, "--id");
        assert_eq!(parsed.session_id, "--session");
    }

    #[test]
    fn parse_notify_only_args_rejects_duplicate_unknown_empty_and_extra() {
        for tail in [["--title", "x"], ["--unknown", "x"], ["--session", ""]] {
            let mut invalid = args(&[
                "--notify-only",
                "--title",
                "Title",
                "--body",
                "Body",
                "--id",
                "n1",
            ]);
            invalid.extend(args(&tail));
            assert!(super::parse_notify_only_args(&invalid).is_none());
        }
        let extra = args(&[
            "--notify-only",
            "--title",
            "t",
            "--body",
            "b",
            "--id",
            "n",
            "--session",
            "s",
            "extra",
        ]);
        assert!(super::parse_notify_only_args(&extra).is_none());
    }

    #[test]
    fn cold_click_is_queued_until_renderer_ready_then_delivered_once() {
        let mut delivery = super::ClickDelivery::default();
        let payload = super::clicked_payload("n1", Some("s1"));
        assert_eq!(
            payload,
            serde_json::json!({ "id": "n1", "sessionId": "s1" })
        );
        assert_eq!(delivery.receive(payload.clone()), None);
        assert_eq!(delivery.renderer_ready(), vec![payload.clone()]);
        assert!(delivery.renderer_ready().is_empty());
        assert_eq!(delivery.receive(payload.clone()), Some(payload));
    }

    #[test]
    fn cold_click_ready_timeout_drains_once_and_delivers_later_clicks_immediately() {
        let mut delivery = super::ClickDelivery::default();
        let first = super::clicked_payload("first", Some("session-first"));
        let second = super::clicked_payload("second", None);
        assert_eq!(delivery.receive(first.clone()), None);
        assert_eq!(delivery.receive(second.clone()), None);
        assert_eq!(
            delivery.renderer_ready_timeout(
                crate::RENDERER_READY_TIMEOUT - std::time::Duration::from_nanos(1)
            ),
            None
        );
        assert_eq!(
            delivery.renderer_ready_timeout(crate::RENDERER_READY_TIMEOUT),
            Some((
                "notification-click-ready-timeout",
                vec![first.clone(), second]
            ))
        );
        // Neither a later timer check nor a late ready event replays the clicks.
        assert_eq!(
            delivery.renderer_ready_timeout(crate::RENDERER_READY_TIMEOUT),
            None
        );
        assert!(delivery.renderer_ready().is_empty());
        assert_eq!(delivery.receive(first.clone()), Some(first));
    }

    #[test]
    fn cold_click_ready_event_preempts_timeout_without_warning() {
        let mut delivery = super::ClickDelivery::default();
        let payload = super::clicked_payload("event-first", Some("session-event"));
        assert_eq!(delivery.receive(payload.clone()), None);
        assert_eq!(delivery.renderer_ready(), vec![payload.clone()]);
        // None means no timeout reason, so the production timer emits no warning.
        assert_eq!(
            delivery.renderer_ready_timeout(crate::RENDERER_READY_TIMEOUT),
            None
        );
        assert!(delivery.renderer_ready().is_empty());
        assert_eq!(delivery.receive(payload.clone()), Some(payload));
    }

    #[test]
    fn notification_id_present() {
        let metadata = serde_json::json!({ super::NOTIFICATION_ID_KEY: "notification-X" });
        assert_eq!(super::notification_id(&metadata), Some("notification-X"));
    }

    #[test]
    fn notification_id_absent() {
        assert_eq!(super::notification_id(&serde_json::json!({})), None);
    }

    #[test]
    fn notification_id_wrong_type() {
        for value in [
            serde_json::json!(42),
            serde_json::json!(true),
            serde_json::json!([]),
            serde_json::Value::Null,
        ] {
            assert_eq!(
                super::notification_id(&serde_json::json!({ super::NOTIFICATION_ID_KEY: value })),
                None
            );
        }
    }

    #[test]
    fn notification_id_empty_string() {
        assert_eq!(
            super::notification_id(&serde_json::json!({ super::NOTIFICATION_ID_KEY: "" })),
            None
        );
    }

    #[test]
    fn notification_clicked_payload_shape() {
        assert_eq!(
            super::clicked_payload("notification-X", None),
            serde_json::json!({ "id": "notification-X" })
        );
    }

    #[test]
    fn authorization_wait_outlasts_a_human_answering_the_prompt() {
        assert!(UNC_AUTHORIZATION_TIMEOUT.as_secs() >= 60);
        assert!(UNC_AUTHORIZATION_TIMEOUT > UNC_CALLBACK_TIMEOUT);
    }

    #[test]
    fn backend_decision_table() {
        assert_eq!(decide_backend(true, true), NotificationBackend::Unc);
        assert_eq!(decide_backend(false, true), NotificationBackend::Legacy);
        assert_eq!(decide_backend(true, false), NotificationBackend::Legacy);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn unbundled_post_unc_rejects_with_bundle_reason() {
        assert_eq!(
            super::post_unc("Agent Neo", "body", None),
            Err("UNUserNotificationCenter is reserved for macOS app bundles".to_string())
        );
    }

    #[test]
    fn result_serializes_to_the_renderer_contract() {
        let result = PostSystemNotificationResult {
            backend: "unc".to_string(),
            ok: true,
            reason: None,
        };
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({ "backend": "unc", "ok": true })
        );
        let fallback = PostSystemNotificationResult {
            backend: "legacy-needed".to_string(),
            ok: false,
            reason: Some("not an app bundle".to_string()),
        };
        assert_eq!(
            serde_json::to_value(fallback).unwrap(),
            serde_json::json!({ "backend": "legacy-needed", "ok": false, "reason": "not an app bundle" })
        );
    }
}
