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

#[cfg(target_os = "macos")]
pub fn post_unc(title: &str, body: &str) -> Result<(), String> {
    use block2::RcBlock;
    use objc2::rc::autoreleasepool;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
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
pub fn post_unc(_title: &str, _body: &str) -> Result<(), String> {
    Err("UNUserNotificationCenter is only available on macOS".to_string())
}

#[tauri::command]
pub async fn post_system_notification(title: String, body: String) -> PostSystemNotificationResult {
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
            let outcome = tokio::task::spawn_blocking(move || post_unc(&title, &body)).await;
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
