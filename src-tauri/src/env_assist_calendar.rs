//! EventKit calendar data for env-assist (ADR-090, N-MEETING-CALENDAR-REMINDER).
//!
//! Three plain `pub fn`s consumed only by the token-protected loopback bridge, never
//! exposed as Tauri webview commands:
//! - `authorization_status` — passive, `+[EKEventStore authorizationStatusForEntityType:]`, never prompts;
//! - `request_full_access` — the only prompting call, fired after a click token; returns
//!   immediately (the host confirms the answer by polling the passive status);
//! - `list_events` — read-only, events starting in `[from_ms, to_ms)`; the bridge re-checks
//!   `authorization_status() == FULL_ACCESS` right before every call.
//!
//! Reads go through EventKit, never Calendar.app, so the reminder never launches it.

#![allow(dead_code)]

/// EKAuthorizationStatus: 0 notDetermined, 1 restricted, 2 denied, 3 fullAccess (authorized before 14), 4 writeOnly.
pub const FULL_ACCESS: i64 = 3;
/// The answer EventKit handed to our own request's completion: -1 none yet, 0 refused, 1 granted.
static REQUEST_ANSWER: std::sync::atomic::AtomicI8 = std::sync::atomic::AtomicI8::new(-1);

/// What the last in-process `request_full_access` completion said, if it has run.
pub fn last_request_answer() -> Option<bool> {
    match REQUEST_ANSWER.load(std::sync::atomic::Ordering::SeqCst) {
        1 => Some(true),
        0 => Some(false),
        _ => None,
    }
}

/// The status every route trusts. 11-15 real run: after "Allow Full Access" in our own dialog the class method
/// kept answering notDetermined (0) in this process. The completion is EventKit's own answer to this process,
/// so a notDetermined class read after a granted completion counts as full access; nothing else is upgraded.
pub fn effective_status(raw: i64, answer: Option<bool>) -> i64 {
    if raw == 0 && answer == Some(true) { FULL_ACCESS } else { raw }
}

/// Window and count caps for one read; the reminder asks for 2 minutes.
pub const MAX_WINDOW_MS: i64 = 60 * 60 * 1000;
pub const MAX_EVENTS: usize = 20;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CalendarEvent {
    pub id: String,
    pub title: String,
    #[serde(rename = "startMs")]
    pub start_ms: i64,
    #[serde(rename = "endMs")]
    pub end_ms: i64,
}

/// Non-all-day events whose start falls in `[from_ms, to_ms)`, earliest first, capped at `MAX_EVENTS`.
/// EventKit's predicate matches anything overlapping the range, so the start filter is done here.
pub fn keep_upcoming(mut events: Vec<(CalendarEvent, bool)>, from_ms: i64, to_ms: i64) -> Vec<CalendarEvent> {
    events.retain(|(e, all_day)| !*all_day && e.start_ms >= from_ms && e.start_ms < to_ms);
    events.sort_by_key(|(e, _)| e.start_ms);
    events.into_iter().take(MAX_EVENTS).map(|(e, _)| e).collect()
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{msg_send, sel};
    use objc2_foundation::NSString;
    use std::sync::OnceLock;

    #[link(name = "EventKit", kind = "framework")]
    extern "C" {}

    /// EKEntityTypeEvent
    const ENTITY_EVENT: isize = 0;

    fn store_class() -> Result<&'static AnyClass, String> {
        AnyClass::get(c"EKEventStore").ok_or_else(|| "EKEventStore class not found".to_string())
    }

    pub(super) fn authorization_status() -> Result<i64, String> {
        let cls = store_class()?;
        let status: isize = unsafe { msg_send![cls, authorizationStatusForEntityType: ENTITY_EVENT] };
        Ok(status as i64)
    }

    pub(super) fn request_full_access() -> Result<(), String> {
        // The store must outlive the dialog, which can stay up long after this returns.
        // ponytail: one process-lifetime store, leaked on purpose; the bridge thread is its only user.
        static STORE: OnceLock<usize> = OnceLock::new();
        let cls = store_class()?;
        let ptr = *STORE.get_or_init(|| {
            let store: Retained<AnyObject> = unsafe { msg_send![cls, new] };
            Retained::into_raw(store) as usize
        });
        let store = unsafe { &*(ptr as *const AnyObject) };
        let completion = block2::RcBlock::new(|granted: Bool, _error: *mut AnyObject| {
            let granted = granted.as_bool();
            super::REQUEST_ANSWER.store(i8::from(granted), std::sync::atomic::Ordering::SeqCst);
            eprintln!("[env_assist_calendar] request completion granted={granted}");
        });
        let full: bool = unsafe { msg_send![store, respondsToSelector: sel!(requestFullAccessToEventsWithCompletion:)] };
        if full {
            let _: () = unsafe { msg_send![store, requestFullAccessToEventsWithCompletion: &*completion] };
        } else {
            let _: () = unsafe { msg_send![store, requestAccessToEntityType: ENTITY_EVENT, completion: &*completion] };
        }
        Ok(())
    }

    fn ns_string(obj: Option<Retained<NSString>>) -> String {
        obj.map(|s| s.to_string()).unwrap_or_default()
    }

    fn date_ms(date: Option<Retained<AnyObject>>) -> i64 {
        date.map(|d| {
            let secs: f64 = unsafe { msg_send![&*d, timeIntervalSince1970] };
            (secs * 1000.0).round() as i64
        })
        .unwrap_or(i64::MIN)
    }

    pub(super) fn list_events(from_ms: i64, to_ms: i64) -> Result<Vec<(super::CalendarEvent, bool)>, String> {
        let cls = store_class()?;
        let date_cls = AnyClass::get(c"NSDate").ok_or_else(|| "NSDate class not found".to_string())?;
        autoreleasepool(|_| {
            // A fresh store per read so events granted after launch are visible.
            let store: Retained<AnyObject> = unsafe { msg_send![cls, new] };
            let start: Retained<AnyObject> = unsafe { msg_send![date_cls, dateWithTimeIntervalSince1970: from_ms as f64 / 1000.0] };
            let end: Retained<AnyObject> = unsafe { msg_send![date_cls, dateWithTimeIntervalSince1970: to_ms as f64 / 1000.0] };
            let nil: *const AnyObject = std::ptr::null();
            let predicate: Option<Retained<AnyObject>> = unsafe {
                msg_send![&*store, predicateForEventsWithStartDate: &*start, endDate: &*end, calendars: nil]
            };
            let predicate = predicate.ok_or_else(|| "EventKit predicate is nil".to_string())?;
            let events: Option<Retained<AnyObject>> = unsafe { msg_send![&*store, eventsMatchingPredicate: &*predicate] };
            let Some(events) = events else { return Ok(Vec::new()) };
            let count: usize = unsafe { msg_send![&*events, count] };
            let mut out = Vec::with_capacity(count);
            for i in 0..count {
                let ev: Retained<AnyObject> = unsafe { msg_send![&*events, objectAtIndex: i] };
                let all_day: bool = unsafe { msg_send![&*ev, isAllDay] };
                out.push((
                    super::CalendarEvent {
                        id: ns_string(unsafe { msg_send![&*ev, eventIdentifier] }),
                        title: ns_string(unsafe { msg_send![&*ev, title] }),
                        start_ms: date_ms(unsafe { msg_send![&*ev, startDate] }),
                        end_ms: date_ms(unsafe { msg_send![&*ev, endDate] }),
                    },
                    all_day,
                ));
            }
            Ok(out)
        })
    }
}

#[cfg(target_os = "macos")]
pub fn authorization_status() -> Result<i64, String> {
    imp::authorization_status()
}

#[cfg(target_os = "macos")]
pub fn request_full_access() -> Result<(), String> {
    imp::request_full_access()
}

#[cfg(target_os = "macos")]
pub fn list_events(from_ms: i64, to_ms: i64) -> Result<Vec<CalendarEvent>, String> {
    Ok(keep_upcoming(imp::list_events(from_ms, to_ms)?, from_ms, to_ms))
}

#[cfg(not(target_os = "macos"))]
pub fn authorization_status() -> Result<i64, String> {
    Err("env_assist_calendar is only supported on macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn request_full_access() -> Result<(), String> {
    Err("env_assist_calendar is only supported on macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn list_events(_from_ms: i64, _to_ms: i64) -> Result<Vec<CalendarEvent>, String> {
    Err("env_assist_calendar is only supported on macOS".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(id: &str, start_ms: i64) -> CalendarEvent {
        CalendarEvent { id: id.into(), title: id.into(), start_ms, end_ms: start_ms + 1 }
    }

    #[test]
    fn keep_upcoming_drops_all_day_and_out_of_window_and_sorts() {
        let got = keep_upcoming(
            vec![
                (ev("late", 150), false),
                (ev("allday", 120), true),
                (ev("started", 99), false),
                (ev("end_edge", 200), false),
                (ev("early", 100), false),
            ],
            100,
            200,
        );
        assert_eq!(got.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["early", "late"]);
    }

    #[test]
    fn effective_status_trusts_a_granted_completion_only_over_not_determined() {
        assert_eq!(effective_status(0, Some(true)), FULL_ACCESS);
        assert_eq!(effective_status(0, None), 0);
        assert_eq!(effective_status(0, Some(false)), 0);
        // A real refusal / write-only / restriction is never upgraded by an old completion.
        for raw in [1, 2, 4] {
            assert_eq!(effective_status(raw, Some(true)), raw);
        }
    }

    #[test]
    fn keep_upcoming_caps_count() {
        let many = (0..50).map(|i| (ev(&i.to_string(), 100 + i), false)).collect();
        assert_eq!(keep_upcoming(many, 0, 1000).len(), MAX_EVENTS);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn passive_status_reads_without_prompting() {
        let status = authorization_status().expect("authorizationStatusForEntityType should succeed");
        assert!((0..=4).contains(&status), "unexpected EKAuthorizationStatus {status}");
    }

    /// Exercises every EventKit selector the read path sends (objc2 checks encodings in debug builds).
    /// Reading never prompts: unauthorized processes just get an empty list.
    #[cfg(target_os = "macos")]
    #[test]
    fn list_events_selectors_resolve_without_prompting() {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        let events = list_events(now, now + 120_000).expect("EventKit read should succeed");
        assert!(events.len() <= MAX_EVENTS);
    }
}
