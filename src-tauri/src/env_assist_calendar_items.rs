//! EventKit calendar items for the chat calendar tool (ADR-090 perm_calendars, N-CALENDAR-ONE-PERMISSION-EVENTKIT).
//!
//! Same rules as `env_assist_calendar` (the meeting reminder's reads): consumed only by the token-protected
//! loopback bridge, never prompts, never launches Calendar.app. The bridge re-checks full access natively
//! before every call here, reads and writes alike.
//!
//! Recurring events share one `eventIdentifier` across all occurrences, so an occurrence is addressed by
//! `(event_id, occurrence_ms)`: the start time of that occurrence. Writes use `EKSpanThisEvent`.

#![allow(dead_code)]

/// Window and count caps for one chat read.
pub const MAX_ITEMS_WINDOW_MS: i64 = 400 * 24 * 60 * 60 * 1000;
pub const MAX_ITEMS: usize = 200;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CalendarInfo {
    pub id: String,
    pub title: String,
    pub writable: bool,
    /// `defaultCalendarForNewEvents`: where a create without a calendar is written.
    #[serde(rename = "isDefault")]
    pub is_default: bool,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CalendarItem {
    pub id: String,
    #[serde(rename = "calendarId")]
    pub calendar_id: String,
    pub calendar: String,
    pub title: String,
    #[serde(rename = "startMs")]
    pub start_ms: i64,
    #[serde(rename = "endMs")]
    pub end_ms: i64,
    #[serde(rename = "allDay")]
    pub all_day: bool,
    pub recurring: bool,
    pub location: String,
    pub notes: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct EventFields {
    pub title: Option<String>,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub location: Option<String>,
    /// Only for re-creating a deleted event from its snapshot (undo); the chat tool never sends it.
    pub notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum WriteOp {
    Create { calendar_id: Option<String>, fields: EventFields },
    Update { event_id: String, occurrence_ms: Option<i64>, fields: EventFields },
    Delete { event_id: String, occurrence_ms: Option<i64> },
}

#[derive(Debug, Clone, PartialEq)]
pub enum WriteOutcome {
    Saved(CalendarItem),
    Deleted { title: String },
}

/// Overlapping `[from_ms, to_ms]`, earliest first, capped at `limit` (≤ MAX_ITEMS).
pub fn sort_and_cap(mut items: Vec<CalendarItem>, limit: usize) -> Vec<CalendarItem> {
    items.sort_by_key(|e| e.start_ms);
    items.truncate(limit.min(MAX_ITEMS));
    items
}

/// Which candidate is the addressed occurrence: same id, and (when given) the same start.
/// Without an occurrence the first match wins (non-recurring events have exactly one).
pub fn pick_occurrence(candidates: &[(String, i64)], event_id: &str, occurrence_ms: Option<i64>) -> Option<usize> {
    candidates
        .iter()
        .position(|(id, start)| id == event_id && occurrence_ms.is_none_or(|occ| *start == occ))
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{CalendarInfo, CalendarItem, EventFields, WriteOp, WriteOutcome};
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::msg_send;
    use objc2_foundation::NSString;

    /// EKEntityTypeEvent / EKSpanThisEvent
    const ENTITY_EVENT: isize = 0;
    const SPAN_THIS_EVENT: isize = 0;

    fn class(name: &std::ffi::CStr) -> Result<&'static AnyClass, String> {
        AnyClass::get(name).ok_or_else(|| format!("{} class not found", name.to_string_lossy()))
    }

    /// A fresh store per call so grants and edits made elsewhere are visible.
    fn store() -> Result<Retained<AnyObject>, String> {
        let cls = class(c"EKEventStore")?;
        Ok(unsafe { msg_send![cls, new] })
    }

    fn text(obj: Option<Retained<NSString>>) -> String {
        obj.map(|s| s.to_string()).unwrap_or_default()
    }

    fn date(ms: i64) -> Result<Retained<AnyObject>, String> {
        let cls = class(c"NSDate")?;
        Ok(unsafe { msg_send![cls, dateWithTimeIntervalSince1970: ms as f64 / 1000.0] })
    }

    fn date_ms(d: Option<Retained<AnyObject>>) -> i64 {
        d.map(|d| {
            let secs: f64 = unsafe { msg_send![&*d, timeIntervalSince1970] };
            (secs * 1000.0).round() as i64
        })
        .unwrap_or(i64::MIN)
    }

    fn item(ev: &AnyObject) -> CalendarItem {
        let cal: Option<Retained<AnyObject>> = unsafe { msg_send![ev, calendar] };
        let url: Option<Retained<AnyObject>> = unsafe { msg_send![ev, URL] };
        let recurring: bool = unsafe { msg_send![ev, hasRecurrenceRules] };
        CalendarItem {
            id: text(unsafe { msg_send![ev, eventIdentifier] }),
            calendar_id: cal.as_ref().map(|c| text(unsafe { msg_send![&**c, calendarIdentifier] })).unwrap_or_default(),
            calendar: cal.as_ref().map(|c| text(unsafe { msg_send![&**c, title] })).unwrap_or_default(),
            title: text(unsafe { msg_send![ev, title] }),
            start_ms: date_ms(unsafe { msg_send![ev, startDate] }),
            end_ms: date_ms(unsafe { msg_send![ev, endDate] }),
            all_day: unsafe { msg_send![ev, isAllDay] },
            recurring,
            location: text(unsafe { msg_send![ev, location] }),
            notes: text(unsafe { msg_send![ev, notes] }),
            url: url.map(|u| text(unsafe { msg_send![&*u, absoluteString] })).unwrap_or_default(),
        }
    }

    fn array_items(array: Option<Retained<AnyObject>>) -> Vec<Retained<AnyObject>> {
        let Some(array) = array else { return Vec::new() };
        let count: usize = unsafe { msg_send![&*array, count] };
        (0..count).map(|i| unsafe { msg_send![&*array, objectAtIndex: i] }).collect()
    }

    fn calendar_by_id(store: &AnyObject, id: &str) -> Option<Retained<AnyObject>> {
        let id = NSString::from_str(id);
        unsafe { msg_send![store, calendarWithIdentifier: &*id] }
    }

    fn events_in(store: &AnyObject, from_ms: i64, to_ms: i64, calendars: Option<&AnyObject>) -> Result<Vec<Retained<AnyObject>>, String> {
        let (start, end) = (date(from_ms)?, date(to_ms)?);
        let cals: *const AnyObject = calendars.map_or(std::ptr::null(), |c| c as *const AnyObject);
        let predicate: Option<Retained<AnyObject>> = unsafe {
            msg_send![store, predicateForEventsWithStartDate: &*start, endDate: &*end, calendars: cals]
        };
        let predicate = predicate.ok_or_else(|| "EventKit predicate is nil".to_string())?;
        Ok(array_items(unsafe { msg_send![store, eventsMatchingPredicate: &*predicate] }))
    }

    pub(super) fn list_calendars() -> Result<Vec<CalendarInfo>, String> {
        autoreleasepool(|_| {
            let store = store()?;
            let cals = array_items(unsafe { msg_send![&*store, calendarsForEntityType: ENTITY_EVENT] });
            // Where a create without a calendar lands (shown on the approval card instead of "none").
            let default: Option<Retained<AnyObject>> = unsafe { msg_send![&*store, defaultCalendarForNewEvents] };
            let default_id = default.map(|d| text(unsafe { msg_send![&*d, calendarIdentifier] }));
            Ok(cals
                .iter()
                .map(|c| {
                    let id = text(unsafe { msg_send![&**c, calendarIdentifier] });
                    CalendarInfo {
                        is_default: default_id.as_deref() == Some(id.as_str()),
                        title: text(unsafe { msg_send![&**c, title] }),
                        writable: unsafe { msg_send![&**c, allowsContentModifications] },
                        id,
                    }
                })
                .collect())
        })
    }

    pub(super) fn list_items(from_ms: i64, to_ms: i64, calendar_id: Option<&str>) -> Result<Vec<CalendarItem>, String> {
        autoreleasepool(|_| {
            let store = store()?;
            let filter = match calendar_id {
                Some(id) => {
                    let cal = calendar_by_id(&store, id).ok_or_else(|| "calendar_not_found".to_string())?;
                    let array_cls = class(c"NSArray")?;
                    let array: Retained<AnyObject> = unsafe { msg_send![array_cls, arrayWithObject: &*cal] };
                    Some(array)
                }
                None => None,
            };
            Ok(events_in(&store, from_ms, to_ms, filter.as_deref())?.iter().map(|e| item(e)).collect())
        })
    }

    /// The addressed occurrence, or the master event when no occurrence time is given.
    fn find_event(store: &AnyObject, event_id: &str, occurrence_ms: Option<i64>) -> Result<Retained<AnyObject>, String> {
        let Some(occ) = occurrence_ms else {
            let id = NSString::from_str(event_id);
            let ev: Option<Retained<AnyObject>> = unsafe { msg_send![store, eventWithIdentifier: &*id] };
            return ev.ok_or_else(|| "event_not_found".to_string());
        };
        let events = events_in(store, occ - 1_000, occ + 1_000, None)?;
        let keyed: Vec<(String, i64)> = events
            .iter()
            .map(|e| (text(unsafe { msg_send![&**e, eventIdentifier] }), date_ms(unsafe { msg_send![&**e, startDate] })))
            .collect();
        super::pick_occurrence(&keyed, event_id, Some(occ))
            .map(|i| events[i].clone())
            .ok_or_else(|| "event_not_found".to_string())
    }

    fn apply(ev: &AnyObject, fields: &EventFields) -> Result<(), String> {
        if let Some(title) = &fields.title {
            let title = NSString::from_str(title);
            let _: () = unsafe { msg_send![ev, setTitle: &*title] };
        }
        if let Some(ms) = fields.start_ms {
            let d = date(ms)?;
            let _: () = unsafe { msg_send![ev, setStartDate: &*d] };
        }
        if let Some(ms) = fields.end_ms {
            let d = date(ms)?;
            let _: () = unsafe { msg_send![ev, setEndDate: &*d] };
        }
        if let Some(location) = &fields.location {
            let location = NSString::from_str(location);
            let _: () = unsafe { msg_send![ev, setLocation: &*location] };
        }
        if let Some(notes) = &fields.notes {
            let notes = NSString::from_str(notes);
            let _: () = unsafe { msg_send![ev, setNotes: &*notes] };
        }
        Ok(())
    }

    fn error_text(err: *mut AnyObject) -> String {
        if err.is_null() {
            return "unknown EventKit error".to_string();
        }
        text(unsafe { msg_send![&*err, localizedDescription] })
    }

    pub(super) fn get_item(event_id: &str, occurrence_ms: Option<i64>) -> Result<CalendarItem, String> {
        autoreleasepool(|_| {
            let store = store()?;
            let ev = find_event(&store, event_id, occurrence_ms)?;
            Ok(item(&ev))
        })
    }

    pub(super) fn write(op: WriteOp) -> Result<WriteOutcome, String> {
        autoreleasepool(|_| {
            let store = store()?;
            let mut err: *mut AnyObject = std::ptr::null_mut();
            match op {
                WriteOp::Create { calendar_id, fields } => {
                    let cal: Option<Retained<AnyObject>> = match calendar_id.as_deref() {
                        Some(id) => Some(calendar_by_id(&store, id).ok_or_else(|| "calendar_not_found".to_string())?),
                        None => unsafe { msg_send![&*store, defaultCalendarForNewEvents] },
                    };
                    let cal = cal.ok_or_else(|| "no_writable_calendar".to_string())?;
                    let cls = class(c"EKEvent")?;
                    let ev: Retained<AnyObject> = unsafe { msg_send![cls, eventWithEventStore: &*store] };
                    let _: () = unsafe { msg_send![&*ev, setCalendar: &*cal] };
                    apply(&ev, &fields)?;
                    let ok: bool = unsafe {
                        msg_send![&*store, saveEvent: &*ev, span: SPAN_THIS_EVENT, commit: true, error: &mut err as *mut *mut AnyObject]
                    };
                    if !ok { return Err(error_text(err)); }
                    Ok(WriteOutcome::Saved(item(&ev)))
                }
                WriteOp::Update { event_id, occurrence_ms, fields } => {
                    let ev = find_event(&store, &event_id, occurrence_ms)?;
                    apply(&ev, &fields)?;
                    let ok: bool = unsafe {
                        msg_send![&*store, saveEvent: &*ev, span: SPAN_THIS_EVENT, commit: true, error: &mut err as *mut *mut AnyObject]
                    };
                    if !ok { return Err(error_text(err)); }
                    Ok(WriteOutcome::Saved(item(&ev)))
                }
                WriteOp::Delete { event_id, occurrence_ms } => {
                    let ev = find_event(&store, &event_id, occurrence_ms)?;
                    let title = text(unsafe { msg_send![&*ev, title] });
                    let ok: bool = unsafe {
                        msg_send![&*store, removeEvent: &*ev, span: SPAN_THIS_EVENT, commit: true, error: &mut err as *mut *mut AnyObject]
                    };
                    if !ok { return Err(error_text(err)); }
                    Ok(WriteOutcome::Deleted { title })
                }
            }
        })
    }
}

#[cfg(target_os = "macos")]
pub fn list_calendars() -> Result<Vec<CalendarInfo>, String> {
    imp::list_calendars()
}

#[cfg(target_os = "macos")]
pub fn list_items(from_ms: i64, to_ms: i64, calendar_id: Option<&str>, limit: usize) -> Result<Vec<CalendarItem>, String> {
    Ok(sort_and_cap(imp::list_items(from_ms, to_ms, calendar_id)?, limit))
}

#[cfg(target_os = "macos")]
pub fn get_item(event_id: &str, occurrence_ms: Option<i64>) -> Result<CalendarItem, String> {
    imp::get_item(event_id, occurrence_ms)
}

#[cfg(target_os = "macos")]
pub fn write(op: WriteOp) -> Result<WriteOutcome, String> {
    imp::write(op)
}

#[cfg(not(target_os = "macos"))]
pub fn get_item(_event_id: &str, _occurrence_ms: Option<i64>) -> Result<CalendarItem, String> {
    Err("env_assist_calendar_items is only supported on macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn list_calendars() -> Result<Vec<CalendarInfo>, String> {
    Err("env_assist_calendar_items is only supported on macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn list_items(_from_ms: i64, _to_ms: i64, _calendar_id: Option<&str>, _limit: usize) -> Result<Vec<CalendarItem>, String> {
    Err("env_assist_calendar_items is only supported on macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn write(_op: WriteOp) -> Result<WriteOutcome, String> {
    Err("env_assist_calendar_items is only supported on macOS".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, start_ms: i64) -> CalendarItem {
        CalendarItem {
            id: id.into(), calendar_id: "c1".into(), calendar: "工作".into(), title: id.into(),
            start_ms, end_ms: start_ms + 1, all_day: false, recurring: false,
            location: String::new(), notes: String::new(), url: String::new(),
        }
    }

    #[test]
    fn sort_and_cap_orders_and_caps() {
        let got = sort_and_cap(vec![item("b", 20), item("a", 10), item("c", 30)], 2);
        assert_eq!(got.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        let many = (0..300).map(|i| item(&i.to_string(), i)).collect();
        assert_eq!(sort_and_cap(many, 10_000).len(), MAX_ITEMS);
    }

    #[test]
    fn pick_occurrence_addresses_the_given_occurrence_of_a_series() {
        // Two occurrences of one weekly series share the id; only the second must be picked.
        let week = 7 * 24 * 3_600_000;
        let candidates = vec![("series".to_string(), 1_000), ("other".to_string(), 1_000 + week), ("series".to_string(), 1_000 + week)];
        assert_eq!(pick_occurrence(&candidates, "series", Some(1_000 + week)), Some(2));
        assert_eq!(pick_occurrence(&candidates, "series", Some(5)), None);
        assert_eq!(pick_occurrence(&candidates, "series", None), Some(0));
    }

    /// Exercises every EventKit selector of the read paths (objc2 checks encodings in debug builds).
    /// Unauthorized processes just get empty lists; nothing prompts.
    #[cfg(target_os = "macos")]
    #[test]
    fn read_selectors_resolve_without_prompting() {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        assert!(list_calendars().is_ok());
        assert!(list_items(now, now + 86_400_000, None, 5).expect("EventKit read should succeed").len() <= 5);
    }
}
