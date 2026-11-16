//! Background-resident quit (scheduled-only, or the dialog's "keep running in background") keeps the desktop shell resident and explains the real exit once.

use std::{fs, path::Path};
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime};

use crate::quit_dialog_i18n::{background_hint, QuitDialogLanguage};
use crate::quit_guard::{self, QuitAnswerAction, QuitCoordinator};
use crate::QuitFlowOrigin;

const HINT_MARKER: &str = "background-hint-shown";

fn post_hint_once(
    data_dir: &Path,
    post: impl FnOnce() -> Result<(), String>,
) -> Result<bool, String> {
    let marker = data_dir.join(HINT_MARKER);
    if marker.try_exists().map_err(|error| error.to_string())? {
        return Ok(false);
    }
    fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    post()?;
    fs::write(marker, b"shown\n").map_err(|error| error.to_string())?;
    Ok(true)
}

pub(crate) fn minimize_and_hint<R: Runtime>(
    app: &AppHandle<R>,
    language: QuitDialogLanguage,
    poster: impl FnOnce(QuitDialogLanguage) -> Result<(), String>,
) {
    // Match CloseRequested: minimize rather than exit, keeping the tray and host alive.
    for window in app.webview_windows().values() {
        if let Err(error) = window.minimize() {
            eprintln!("background-resident: window minimize failed: {error}");
        }
    }
    eprintln!("background-resident: scheduled-only quit; shell stays alive");
    let Some(data_dir) = crate::real_data_dir() else {
        eprintln!("background-resident: hint skipped; data directory unavailable");
        return;
    };
    match post_hint_once(&data_dir, || poster(language)) {
        Ok(true) => eprintln!("background-resident: first-time hint posted"),
        Ok(false) => eprintln!("background-resident: hint already shown"),
        Err(error) => eprintln!("background-resident: hint not recorded: {error}"),
    }
}

/// The one hide-to-background ending: minimize, release the dialog slot, and on macOS
/// cancel the pending `applicationShouldTerminate`. Never exits the shell or touches the host.
pub(crate) fn hide_to_background<R: Runtime>(
    app: &AppHandle<R>,
    coordinator: &Arc<QuitCoordinator>,
    origin: QuitFlowOrigin,
    language: QuitDialogLanguage,
    poster: impl FnOnce(QuitDialogLanguage) -> Result<(), String>,
) {
    minimize_and_hint(app, language, poster);
    coordinator.finish();
    #[cfg(target_os = "macos")]
    if matches!(origin, QuitFlowOrigin::MacApplicationTerminate) {
        crate::reply_to_mac_application_terminate(app, false);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = origin;
}

/// Quit-dialog answer handling (extracted from the dialog callback so tests can drive it).
pub(crate) fn handle_quit_dialog_answer<R: Runtime>(
    app: &AppHandle<R>,
    coordinator: &Arc<QuitCoordinator>,
    origin: QuitFlowOrigin,
    action: QuitAnswerAction,
    language: QuitDialogLanguage,
    poster: impl FnOnce(QuitDialogLanguage) -> Result<(), String>,
) {
    match action {
        QuitAnswerAction::BackgroundContinue => {
            hide_to_background(app, coordinator, origin, language, poster);
        }
        QuitAnswerAction::StayRunning => {
            // Cancel: clean up nothing, the app keeps running.
            coordinator.finish();
            #[cfg(target_os = "macos")]
            if matches!(origin, QuitFlowOrigin::MacApplicationTerminate) {
                crate::reply_to_mac_application_terminate(app, false);
            }
        }
        QuitAnswerAction::Quit => crate::execute_quit_exit_plan(
            app.clone(),
            coordinator.clone(),
            origin,
            quit_guard::quit_exit_plan(QuitAnswerAction::Quit),
        ),
    }
}

pub(crate) fn post_native_hint(language: QuitDialogLanguage) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        crate::native_notification::post_unc("Agent Neo", background_hint(language), None)
    }
    #[cfg(not(target_os = "macos"))]
    {
        eprintln!(
            "background-resident: native hint unsupported: {}",
            background_hint(language)
        );
        Err("native hint skipped on this platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "neo-background-hint-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn absent_marker_posts_then_writes_and_existing_marker_skips() {
        let dir = temp_dir();
        let marker = dir.join(HINT_MARKER);
        assert_eq!(
            post_hint_once(&dir, || {
                assert!(!marker.exists(), "marker must not precede successful post");
                Ok(())
            }),
            Ok(true)
        );
        assert_eq!(fs::read(&marker).unwrap(), b"shown\n");
        assert_eq!(
            post_hint_once(&dir, || panic!("must only post once")),
            Ok(false)
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_post_leaves_no_marker_and_next_attempt_can_post() {
        let dir = temp_dir();
        assert_eq!(
            post_hint_once(&dir, || Err("post failed".into())),
            Err("post failed".into())
        );
        assert!(!dir.join(HINT_MARKER).exists());
        assert_eq!(post_hint_once(&dir, || Ok(())), Ok(true));
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn unbundled_hint_returns_error_without_recording_marker() {
        let expected = crate::native_notification::post_unc("Agent Neo", "probe", None)
            .expect_err("unbundled post_unc must fail closed");
        assert!(expected.ends_with("is reserved for macOS app bundles"));
        let dir = temp_dir();
        for _ in 0..2 {
            assert_eq!(
                post_hint_once(&dir, || post_native_hint(QuitDialogLanguage::En)),
                Err(expected.clone())
            );
            assert!(!dir.join(HINT_MARKER).exists());
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unreadable_marker_path_does_not_post_or_mark_success() {
        let dir = temp_dir();
        fs::write(&dir, b"not a directory").unwrap();
        assert!(post_hint_once(&dir, || panic!("cannot check marker")).is_err());
        fs::remove_file(dir).unwrap();
    }
}
