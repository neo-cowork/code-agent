use serde::Serialize;
use std::{path::Path, time::Duration};

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

fn notification_id(user_info: &serde_json::Value) -> Option<&str> {
    user_info
        .get(NOTIFICATION_ID_KEY)?
        .as_str()
        .filter(|id| !id.is_empty())
}

fn clicked_payload(id: &str) -> serde_json::Value {
    serde_json::json!({ "id": id })
}

#[cfg(target_os = "macos")]
mod delegate {
    use super::{clicked_payload, notification_id, NOTIFICATION_ID_KEY};
    use block2::DynBlock;
    use objc2::{
        define_class, msg_send, rc::Retained, runtime::ProtocolObject, AnyThread, DefinedClass,
    };
    use objc2_foundation::{NSObject, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNNotification, UNNotificationPresentationOptions, UNNotificationResponse,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use tauri::{AppHandle, Emitter};

    struct DelegateIvars {
        app: AppHandle,
        focus: fn(&AppHandle) -> bool,
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
                let metadata = serde_json::json!({ NOTIFICATION_ID_KEY: value });
                if let Some(id) = notification_id(&metadata) {
                    let ivars = self.ivars();
                    if !(ivars.focus)(&ivars.app) {
                        eprintln!("[native_notification] WARN notification-click focus failed");
                    }
                    if let Err(error) = ivars.app.emit("notification-clicked", clicked_payload(id))
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
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let this = NotificationDelegate::alloc().set_ivars(DelegateIvars { app, focus });
        // SAFETY: NSObject's init has this signature and initializes our superclass.
        let delegate: Retained<NotificationDelegate> = unsafe { msg_send![super(this), init] };
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        if center.delegate().is_none() {
            return Err("delegate missing after setDelegate");
        }
        // setDelegate is weak. Keep this one delegate, including its AppHandle,
        // alive until process exit, independent of the setup stack frame.
        std::mem::forget(delegate);
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
            let user_info = NSDictionary::<NSString, NSString>::from_slices(&[&*key], &[&*value]);
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
            super::clicked_payload("notification-X"),
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
