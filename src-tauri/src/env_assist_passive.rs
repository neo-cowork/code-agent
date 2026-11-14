//! Passive (read-only) macOS TCC permission probes for env-assist.
//!
//! Plain `pub fn`s — intentionally never exposed as Tauri webview commands or
//! registered in `tauri::generate_handler!`. Consumed by the token-protected
//! loopback bridge in N-ENV-ASSIST-S2-PROBES-REST1-REST1-HOST-BRIDGE.

#![allow(dead_code)]

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::c_void;

    #[allow(non_upper_case_globals)]
    pub(super) const kIOHIDRequestTypeListenEvent: u32 = 1;
    #[allow(non_upper_case_globals)]
    pub(super) const typeApplicationBundleID: u32 = u32::from_be_bytes(*b"bund");
    #[allow(non_upper_case_globals)]
    pub(super) const typeWildCard: u32 = u32::from_be_bytes(*b"****");

    // AEDataModel.h applies `#pragma pack(push, 2)`, making AEDesc 12 bytes (align 2) on 64-bit macOS.
    #[repr(C, packed(2))]
    pub(super) struct AEDesc {
        pub(super) descriptor_type: u32,
        pub(super) data_handle: *mut c_void,
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        pub(super) fn AXIsProcessTrusted() -> bool;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        pub(super) fn CGPreflightScreenCaptureAccess() -> bool;
    }

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        pub(super) fn IOHIDCheckAccess(request_type: u32) -> u32;
    }

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        pub(super) fn AECreateDesc(
            type_code: u32,
            data_ptr: *const c_void,
            data_size: isize,
            result: *mut AEDesc,
        ) -> i16;
        pub(super) fn AEDisposeDesc(the_ae_desc: *mut AEDesc) -> i16;
        pub(super) fn AEDeterminePermissionToAutomateTarget(
            target: *const AEDesc,
            the_ae_event_class: u32,
            the_ae_event_id: u32,
            ask_user_if_needed: bool,
        ) -> i32;
    }
}

#[cfg(target_os = "macos")]
pub fn check_accessibility() -> Result<bool, String> {
    Ok(unsafe { imp::AXIsProcessTrusted() })
}

#[cfg(not(target_os = "macos"))]
pub fn check_accessibility() -> Result<bool, String> {
    Err("env_assist_passive is only supported on macOS".to_string())
}

#[cfg(target_os = "macos")]
pub fn check_screen_capture() -> Result<bool, String> {
    Ok(unsafe { imp::CGPreflightScreenCaptureAccess() })
}

#[cfg(not(target_os = "macos"))]
pub fn check_screen_capture() -> Result<bool, String> {
    Err("env_assist_passive is only supported on macOS".to_string())
}

#[cfg(target_os = "macos")]
pub fn check_input_monitoring() -> Result<i32, String> {
    let code = unsafe { imp::IOHIDCheckAccess(imp::kIOHIDRequestTypeListenEvent) } as i32;
    match code {
        0..=2 => Ok(code),
        other => Err(format!("unexpected IOHIDCheckAccess code: {other}")),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn check_input_monitoring() -> Result<i32, String> {
    Err("env_assist_passive is only supported on macOS".to_string())
}

#[cfg(target_os = "macos")]
pub fn check_automation(target_bundle_id: &str) -> Result<i32, String> {
    let trimmed = target_bundle_id.trim();
    if trimmed.is_empty() {
        return Err("target_bundle_id must not be empty".to_string());
    }

    let mut target = imp::AEDesc {
        descriptor_type: 0,
        data_handle: std::ptr::null_mut(),
    };
    let create_err = unsafe {
        imp::AECreateDesc(
            imp::typeApplicationBundleID,
            trimmed.as_bytes().as_ptr().cast(),
            trimmed.len() as isize,
            &mut target,
        )
    };
    if create_err != 0 {
        return Err(format!("AECreateDesc failed with OSErr {create_err}"));
    }

    let status = unsafe {
        imp::AEDeterminePermissionToAutomateTarget(
            &target,
            imp::typeWildCard,
            imp::typeWildCard,
            false,
        )
    };
    let _ = unsafe { imp::AEDisposeDesc(&mut target) };
    Ok(status)
}

#[cfg(not(target_os = "macos"))]
pub fn check_automation(target_bundle_id: &str) -> Result<i32, String> {
    let _ = target_bundle_id;
    Err("env_assist_passive is only supported on macOS".to_string())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn ae_desc_matches_carbon_packed_layout() {
        assert_eq!(std::mem::size_of::<imp::AEDesc>(), 12);
        assert_eq!(std::mem::align_of::<imp::AEDesc>(), 2);
    }

    #[test]
    fn passive_probes_read_without_prompting() {
        let _ax: bool = check_accessibility().expect("AXIsProcessTrusted should succeed");
        let _sc: bool =
            check_screen_capture().expect("CGPreflightScreenCaptureAccess should succeed");
        let hid = check_input_monitoring().expect("IOHIDCheckAccess should succeed");
        assert!(matches!(hid, 0..=2), "unexpected IOHIDCheckAccess code: {hid}");
        let ae = check_automation("com.agentneo.nonexistent.bundle.probe")
            .expect("AEDeterminePermissionToAutomateTarget(false) should succeed");
        assert_eq!(ae, -600);
        assert!(check_automation("   ").is_err());
    }
}
