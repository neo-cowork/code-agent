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
            crate::log_shell_line(app, "warn", "background-window-minimize-failed", &format!("background-resident: window minimize failed: {error}"));
        }
    }
    crate::log_shell_line(app, "info", "background-resident", "background-resident: scheduled-only quit; shell stays alive");
    let Some(data_dir) = crate::real_data_dir() else {
        crate::log_shell_line(app, "warn", "background-hint-skipped", "background-resident: hint skipped; data directory unavailable");
        return;
    };
    match post_hint_once(&data_dir, || poster(language)) {
        Ok(true) => crate::log_shell_line(app, "info", "background-hint-posted", "background-resident: first-time hint posted"),
        Ok(false) => crate::log_shell_line(app, "info", "background-hint-shown", "background-resident: hint already shown"),
        Err(error) => {
            #[cfg(not(target_os = "macos"))]
            if error.starts_with("background-resident: native hint unsupported: ") {
                crate::log_shell_line(app, "warn", "background-native-hint-unsupported", &error);
            }
            crate::log_shell_line(app, "warn", "background-hint-not-recorded", &format!("background-resident: hint not recorded: {error}"));
        },
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
        // The caller owns the app handle and persists this diagnostic through the sink.
        Err(format!("background-resident: native hint unsupported: {}", background_hint(language)))
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

    // A subprocess isolates HOME and the app-data resolver from other Rust tests.
    #[test]
    fn background_resident_disk_logging_and_rotation() {
        const CHILD: &str = "NEO_BACKGROUND_LOG_TEST_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let dir = temp_dir();
            fs::create_dir_all(&dir).unwrap();
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "background_resident::tests::background_resident_disk_logging_and_rotation", "--nocapture"])
                .env(CHILD, "1")
                .env("HOME", &dir)
                .env("USERPROFILE", &dir)
                .env("XDG_DATA_HOME", dir.join("data"))
                .env("CODE_AGENT_DATA_DIR", dir.join("hint-data"))
                .status().unwrap();
            fs::remove_dir_all(dir).unwrap();
            assert!(status.success(), "isolated background-resident disk test failed");
            return;
        }
        let home = std::path::PathBuf::from(std::env::var_os("HOME").unwrap());
        let app = tauri::test::mock_app();
        let path = crate::shell_events_path(app.handle()).unwrap();
        assert!(path.starts_with(&home), "must never write outside redirected HOME");
        minimize_and_hint(app.handle(), QuitDialogLanguage::En, |_| Ok(()));
        minimize_and_hint(app.handle(), QuitDialogLanguage::En, |_| panic!("already posted"));
        fs::remove_file(crate::real_data_dir().unwrap().join(HINT_MARKER)).unwrap();
        minimize_and_hint(app.handle(), QuitDialogLanguage::En, |_| Err("injected post failure".into()));
        let raw = fs::read_to_string(&path).unwrap();
        let lines: Vec<serde_json::Value> = raw.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        for message in [
            "background-resident: scheduled-only quit; shell stays alive",
            "background-resident: first-time hint posted",
            "background-resident: hint already shown",
            "background-resident: hint not recorded: injected post failure",
        ] {
            let line = lines.iter().find(|line| line["message"] == message).expect(message);
            assert_eq!(line["schemaVersion"], 1);
            assert_eq!(line["source"], "tauri-shell");
            assert_eq!(line["pid"], std::process::id());
            assert!(line["generatedAt"].as_str().unwrap().parse::<u128>().unwrap() > 0);
            println!("disk readback: {line}");
        }
        // Fill the actual production path to the cap, then cross it via the production entry.
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(crate::SHELL_EVENTS_MAX_BYTES).unwrap();
        drop(file);
        minimize_and_hint(app.handle(), QuitDialogLanguage::En, |_| Ok(()));
        let rotated = path.with_file_name(format!("{}.1", crate::SHELL_EVENTS_FILE));
        assert!(rotated.exists(), "rotation must preserve the previous generation");
        assert_eq!(fs::metadata(&rotated).unwrap().len(), crate::SHELL_EVENTS_MAX_BYTES);
        assert!(fs::metadata(&path).unwrap().len() < 4096, "live log must be small after rotation");
        assert!(fs::read_to_string(&path).unwrap().contains("scheduled-only quit; shell stays alive"));
        // Another rotation replaces the sole generation, rather than accumulating files.
        fs::OpenOptions::new().write(true).open(&path).unwrap().set_len(crate::SHELL_EVENTS_MAX_BYTES).unwrap();
        minimize_and_hint(app.handle(), QuitDialogLanguage::En, |_| Ok(()));
        assert!(!path.with_file_name(format!("{}.2", crate::SHELL_EVENTS_FILE)).exists());
        let slot_path = |slot: u8| {
            let mut context = tauri::test::mock_context(tauri::test::noop_assets());
            context.config_mut().identifier = format!("com.codeagent.dev{slot}");
            let app = tauri::test::mock_builder().build(context).unwrap();
            let path = crate::shell_events_path(app.handle()).unwrap();
            crate::log_shell_line(app.handle(), "info", "slot-probe", &format!("slot {slot}"));
            path
        };
        let dev2 = slot_path(2);
        let dev3 = slot_path(3);
        assert_ne!(dev2, dev3);
        assert!(dev2.starts_with(&home) && dev3.starts_with(&home));
        assert!(dev2.to_string_lossy().contains("com.codeagent.dev2"));
        assert!(dev3.to_string_lossy().contains("com.codeagent.dev3"));
        assert!(!fs::read_to_string(dev2).unwrap().contains("slot 3"));
        assert!(!fs::read_to_string(dev3).unwrap().contains("slot 2"));
        println!("background_resident rotation: .1 exists, live <4096 bytes; dev2/dev3 paths and contents isolated");
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
