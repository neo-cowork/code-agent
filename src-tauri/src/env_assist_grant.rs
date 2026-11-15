//! Prompting (grant) macOS TCC permission functions for env-assist.
//!
//! Plain `pub fn`s — intentionally never exposed as Tauri webview commands or
//! registered in `tauri::generate_handler!`, so the webview can never invoke a
//! dialog-raising API. Consumed exclusively by the token-protected loopback bridge
//! in N-ENV-ASSIST-S2-PROBES-REST1-REST1-HOST-BRIDGE.

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

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub(super) static kCFBooleanTrue: *const c_void;
        pub(super) static kCFTypeDictionaryKeyCallBacks: u8;
        pub(super) static kCFTypeDictionaryValueCallBacks: u8;
        pub(super) fn CFDictionaryCreate(
            allocator: *const c_void,
            keys: *const *const c_void,
            values: *const *const c_void,
            num_values: isize,
            key_call_backs: *const c_void,
            value_call_backs: *const c_void,
        ) -> *const c_void;
        pub(super) fn CFRelease(cf: *const c_void);
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        pub(super) static kAXTrustedCheckOptionPrompt: *const c_void;
        pub(super) fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        pub(super) fn CGRequestScreenCaptureAccess() -> bool;
    }

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        pub(super) fn IOHIDRequestAccess(request_type: u32) -> bool;
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
pub fn request_accessibility() -> Result<bool, String> {
    let key = unsafe { imp::kAXTrustedCheckOptionPrompt };
    let val = unsafe { imp::kCFBooleanTrue };
    if key.is_null() || val.is_null() {
        return Err("Accessibility prompt CF constants resolved to null".to_string());
    }
    let keys = [key];
    let values = [val];
    let options = unsafe {
        imp::CFDictionaryCreate(
            std::ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            1,
            std::ptr::addr_of!(imp::kCFTypeDictionaryKeyCallBacks).cast(),
            std::ptr::addr_of!(imp::kCFTypeDictionaryValueCallBacks).cast(),
        )
    };
    if options.is_null() {
        return Err("CFDictionaryCreate returned null for accessibility prompt options".to_string());
    }
    let trusted = unsafe { imp::AXIsProcessTrustedWithOptions(options) };
    unsafe { imp::CFRelease(options) };
    Ok(trusted)
}

#[cfg(not(target_os = "macos"))]
pub fn request_accessibility() -> Result<bool, String> {
    Err("env_assist_grant is only supported on macOS".to_string())
}

#[cfg(target_os = "macos")]
pub fn request_screen_capture() -> Result<bool, String> {
    Ok(unsafe { imp::CGRequestScreenCaptureAccess() })
}

#[cfg(not(target_os = "macos"))]
pub fn request_screen_capture() -> Result<bool, String> {
    Err("env_assist_grant is only supported on macOS".to_string())
}

#[cfg(target_os = "macos")]
pub fn request_input_monitoring() -> Result<bool, String> {
    Ok(unsafe { imp::IOHIDRequestAccess(imp::kIOHIDRequestTypeListenEvent) })
}

#[cfg(not(target_os = "macos"))]
pub fn request_input_monitoring() -> Result<bool, String> {
    Err("env_assist_grant is only supported on macOS".to_string())
}

/// Requests Apple Events Automation consent for `target_bundle_id`.
/// Callers must invoke this off the main thread because `ask_user_if_needed = true`
/// blocks while macOS waits for user consent.
#[cfg(target_os = "macos")]
pub fn request_automation(target_bundle_id: &str) -> Result<i32, String> {
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
            true,
        )
    };
    let _ = unsafe { imp::AEDisposeDesc(&mut target) };
    Ok(status)
}

#[cfg(not(target_os = "macos"))]
pub fn request_automation(target_bundle_id: &str) -> Result<i32, String> {
    let _ = target_bundle_id;
    Err("env_assist_grant is only supported on macOS".to_string())
}
