//! EventKit calendar routes of the env-assist bridge (`env_assist_bridge::calendar`; dispatched from
//! `imp::handle_connection`, so it shares the same token / Host / body checks that already ran in `handle_connection`).
//!
//! - `/v1/passive/calendar`      → `{ "status": 0..4 }`, never prompts.
//! - `/v1/grant/calendar`        → `{ "requested": true }`, fires the system dialog and returns at once.
//! - `/v1/read/calendar-events`  → `{ "events": [...] }` (meeting reminder: starts in a ≤1h window).
//! - `/v1/read/calendars`        → `{ "calendars": [{ id, title, writable }] }` (chat calendar tool).
//! - `/v1/read/calendar-items`   → `{ "events": [...] }` overlapping a ≤400-day window (chat calendar tool).
//! - `/v1/read/calendar-event`   → `{ "event": {...} }` one event / occurrence by id (+ occurrence start).
//! - `/v1/write/calendar-event`  → create / update / delete one event or one occurrence (chat calendar tool).
//!
//! Every route but passive/grant re-reads the authorization status natively first and refuses anything short of
//! full access with 403, so a caller can't skip the grant by claiming it was given. None of them prompts.

use super::imp::{bad_body, native_err, parse_empty_or_empty_object, BridgeHandlers};
use crate::env_assist_calendar::{effective_status, FULL_ACCESS, MAX_WINDOW_MS};
use crate::env_assist_calendar_items::{EventFields, WriteOp, WriteOutcome, MAX_ITEMS, MAX_ITEMS_WINDOW_MS};
use serde::Deserialize;

type Outcome = Result<serde_json::Value, (u16, &'static str, serde_json::Value)>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadRequest {
    #[serde(rename = "fromMs")]
    from_ms: i64,
    #[serde(rename = "toMs")]
    to_ms: i64,
}

fn parse_read(body: &[u8]) -> Result<ReadRequest, ()> {
    let req: ReadRequest = serde_json::from_slice(body).map_err(|_| ())?;
    if req.to_ms <= req.from_ms || req.to_ms - req.from_ms > MAX_WINDOW_MS {
        return Err(());
    }
    Ok(req)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ItemsRequest {
    #[serde(rename = "fromMs")]
    from_ms: i64,
    #[serde(rename = "toMs")]
    to_ms: i64,
    #[serde(rename = "calendarId")]
    calendar_id: Option<String>,
    limit: Option<usize>,
}

fn parse_items(body: &[u8]) -> Result<ItemsRequest, ()> {
    let req: ItemsRequest = serde_json::from_slice(body).map_err(|_| ())?;
    if req.to_ms <= req.from_ms || req.to_ms - req.from_ms > MAX_ITEMS_WINDOW_MS || req.limit == Some(0) {
        return Err(());
    }
    Ok(req)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EventRequest {
    #[serde(rename = "eventId")]
    event_id: String,
    #[serde(rename = "occurrenceMs")]
    occurrence_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteRequest {
    op: String,
    #[serde(rename = "calendarId")]
    calendar_id: Option<String>,
    #[serde(rename = "eventId")]
    event_id: Option<String>,
    #[serde(rename = "occurrenceMs")]
    occurrence_ms: Option<i64>,
    title: Option<String>,
    #[serde(rename = "startMs")]
    start_ms: Option<i64>,
    #[serde(rename = "endMs")]
    end_ms: Option<i64>,
    location: Option<String>,
    notes: Option<String>,
}

/// Shape checks only; whether the event / calendar exists is the native layer's answer (404).
fn parse_write(body: &[u8]) -> Result<WriteOp, ()> {
    let r: WriteRequest = serde_json::from_slice(body).map_err(|_| ())?;
    let fields = EventFields { title: r.title, start_ms: r.start_ms, end_ms: r.end_ms, location: r.location, notes: r.notes };
    if let (Some(start), Some(end)) = (fields.start_ms, fields.end_ms) {
        if end < start {
            return Err(());
        }
    }
    let event_id = r.event_id.filter(|id| !id.is_empty());
    match r.op.as_str() {
        "create" => {
            let titled = fields.title.as_deref().is_some_and(|t| !t.trim().is_empty());
            if event_id.is_some() || r.occurrence_ms.is_some() || !titled || fields.start_ms.is_none() || fields.end_ms.is_none() {
                return Err(());
            }
            Ok(WriteOp::Create { calendar_id: r.calendar_id, fields })
        }
        "update" => {
            if r.calendar_id.is_some() || fields.notes.is_some() || fields == EventFields::default() {
                return Err(());
            }
            Ok(WriteOp::Update { event_id: event_id.ok_or(())?, occurrence_ms: r.occurrence_ms, fields })
        }
        "delete" => {
            if r.calendar_id.is_some() || fields != EventFields::default() {
                return Err(());
            }
            Ok(WriteOp::Delete { event_id: event_id.ok_or(())?, occurrence_ms: r.occurrence_ms })
        }
        _ => Err(()),
    }
}

/// Native "nothing by that id" answers are 404s the host can tell apart from a failed read.
fn item_err(detail: String) -> (u16, &'static str, serde_json::Value) {
    match detail.as_str() {
        "event_not_found" | "calendar_not_found" | "no_writable_calendar" => (404, "Not Found", serde_json::json!({ "error": detail })),
        "event_end_not_after_start" => (400, "Bad Request", serde_json::json!({ "error": detail })),
        _ => native_err(detail),
    }
}

type RouteErr = (u16, &'static str, serde_json::Value);

/// Raw class status plus our own request's answer → the one status every route trusts.
fn calendar_status(handlers: &dyn BridgeHandlers) -> Result<(i64, i64, Option<bool>), RouteErr> {
    let raw = handlers.passive_calendar().map_err(native_err)?;
    let answer = handlers.calendar_request_answer();
    Ok((effective_status(raw, answer), raw, answer))
}

fn require_full_access(handlers: &dyn BridgeHandlers) -> Result<(), RouteErr> {
    let (status, _, _) = calendar_status(handlers)?;
    if status != FULL_ACCESS {
        return Err((403, "Forbidden", serde_json::json!({ "error": "calendar_not_authorized", "status": status })));
    }
    Ok(())
}

pub(super) fn route(path: &str, body: &[u8], handlers: &dyn BridgeHandlers) -> Outcome {
    match path {
        "/v1/passive/calendar" => parse_empty_or_empty_object(body)
            .map_err(|_| bad_body())
            .and_then(|()| {
                // raw / answer ride along so the host can log when they disagree (diagnosis only; status is the truth)
                calendar_status(handlers)
                    .map(|(status, raw, answer)| serde_json::json!({ "status": status, "raw": raw, "answer": answer }))
            }),
        "/v1/grant/calendar" => parse_empty_or_empty_object(body)
            .map_err(|_| bad_body())
            .and_then(|()| {
                handlers
                    .grant_calendar()
                    .map(|()| serde_json::json!({ "requested": true }))
                    .map_err(native_err)
            }),
        "/v1/read/calendars" => {
            parse_empty_or_empty_object(body).map_err(|_| bad_body())?;
            require_full_access(handlers)?;
            handlers
                .list_calendars()
                .map(|calendars| serde_json::json!({ "calendars": calendars }))
                .map_err(native_err)
        }
        "/v1/read/calendar-items" => {
            let req = parse_items(body).map_err(|_| bad_body())?;
            require_full_access(handlers)?;
            handlers
                .read_calendar_items(req.from_ms, req.to_ms, req.calendar_id.as_deref(), req.limit.unwrap_or(MAX_ITEMS))
                .map(|events| serde_json::json!({ "events": events }))
                .map_err(item_err)
        }
        "/v1/read/calendar-event" => {
            let req: EventRequest = serde_json::from_slice(body).map_err(|_| bad_body())?;
            if req.event_id.is_empty() {
                return Err(bad_body());
            }
            require_full_access(handlers)?;
            handlers
                .get_calendar_item(&req.event_id, req.occurrence_ms)
                .map(|event| serde_json::json!({ "event": event }))
                .map_err(item_err)
        }
        "/v1/write/calendar-event" => {
            let op = parse_write(body).map_err(|_| bad_body())?;
            require_full_access(handlers)?;
            handlers
                .write_calendar_event(op)
                .map(|outcome| match outcome {
                    WriteOutcome::Saved(event) => serde_json::json!({ "event": event }),
                    WriteOutcome::Deleted { title } => serde_json::json!({ "deleted": true, "title": title }),
                })
                .map_err(item_err)
        }
        _ => {
            let req = parse_read(body).map_err(|_| bad_body())?;
            require_full_access(handlers)?;
            handlers
                .read_calendar_events(req.from_ms, req.to_ms)
                .map(|events| serde_json::json!({ "events": events }))
                .map_err(native_err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::imp::{make_bridge_token, start_bridge_server, BridgeServer};
    use super::*;
    use crate::env_assist_calendar::CalendarEvent;
    use crate::env_assist_calendar_items::{pick_occurrence, CalendarInfo, CalendarItem};
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    #[derive(Default)]
    struct FakeCalendar {
        status: AtomicI64,
        status_reads: AtomicUsize,
        grants: AtomicUsize,
        reads: AtomicUsize,
        writes: AtomicUsize,
        items: Mutex<Vec<CalendarItem>>,
        answer: Mutex<Option<bool>>,
    }

    const WEEK: i64 = 7 * 24 * 3_600_000;

    fn occurrence(start_ms: i64) -> CalendarItem {
        CalendarItem {
            id: "series".into(), calendar_id: "c1".into(), calendar: "工作".into(), title: "周会".into(),
            start_ms, end_ms: start_ms + 3_600_000, all_day: false, recurring: true,
            location: String::new(), notes: String::new(), url: String::new(),
        }
    }

    impl BridgeHandlers for FakeCalendar {
        fn list_calendars(&self) -> Result<Vec<CalendarInfo>, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(vec![CalendarInfo { id: "c1".into(), title: "工作".into(), writable: true, is_default: true }])
        }
        fn read_calendar_items(&self, _: i64, _: i64, calendar_id: Option<&str>, limit: usize) -> Result<Vec<CalendarItem>, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            if calendar_id == Some("missing") {
                return Err("calendar_not_found".into());
            }
            Ok(self.items.lock().unwrap().iter().take(limit).cloned().collect())
        }
        fn get_calendar_item(&self, event_id: &str, occurrence_ms: Option<i64>) -> Result<CalendarItem, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            let items = self.items.lock().unwrap();
            let keyed: Vec<(String, i64)> = items.iter().map(|e| (e.id.clone(), e.start_ms)).collect();
            let i = pick_occurrence(&keyed, event_id, occurrence_ms).ok_or("event_not_found")?;
            Ok(items[i].clone())
        }
        /// Same occurrence addressing as the native layer: id + start time picks one occurrence of the series.
        fn write_calendar_event(&self, op: WriteOp) -> Result<WriteOutcome, String> {
            self.writes.fetch_add(1, Ordering::SeqCst);
            let mut items = self.items.lock().unwrap();
            let keyed: Vec<(String, i64)> = items.iter().map(|e| (e.id.clone(), e.start_ms)).collect();
            match op {
                WriteOp::Create { fields, .. } => {
                    let mut created = occurrence(fields.start_ms.unwrap());
                    created.id = "new".into();
                    created.title = fields.title.unwrap();
                    items.push(created.clone());
                    Ok(WriteOutcome::Saved(created))
                }
                WriteOp::Update { event_id, occurrence_ms, fields } => {
                    let i = pick_occurrence(&keyed, &event_id, occurrence_ms).ok_or("event_not_found")?;
                    if let Some(title) = fields.title { items[i].title = title; }
                    Ok(WriteOutcome::Saved(items[i].clone()))
                }
                WriteOp::Delete { event_id, occurrence_ms } => {
                    let i = pick_occurrence(&keyed, &event_id, occurrence_ms).ok_or("event_not_found")?;
                    Ok(WriteOutcome::Deleted { title: items.remove(i).title })
                }
            }
        }
        fn passive_accessibility(&self) -> Result<bool, String> { unreachable!() }
        fn passive_screen(&self) -> Result<bool, String> { unreachable!() }
        fn passive_input(&self) -> Result<i32, String> { unreachable!() }
        fn passive_automation(&self, _: &str) -> Result<i32, String> { unreachable!() }
        fn grant_accessibility(&self) -> Result<bool, String> { unreachable!() }
        fn grant_screen(&self) -> Result<bool, String> { unreachable!() }
        fn grant_input(&self) -> Result<bool, String> { unreachable!() }
        fn grant_automation(&self, _: &str) -> Result<i32, String> { unreachable!() }
        fn passive_calendar(&self) -> Result<i64, String> {
            self.status_reads.fetch_add(1, Ordering::SeqCst);
            Ok(self.status.load(Ordering::SeqCst))
        }
        fn grant_calendar(&self) -> Result<(), String> {
            self.grants.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn calendar_request_answer(&self) -> Option<bool> {
            *self.answer.lock().unwrap()
        }
        fn read_calendar_events(&self, from_ms: i64, _to_ms: i64) -> Result<Vec<CalendarEvent>, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(vec![CalendarEvent { id: "e1".into(), title: "周会".into(), start_ms: from_ms + 60_000, end_ms: from_ms + 3_600_000 }])
        }
    }

    fn post(port: u16, token: &str, path: &str, body: &str) -> (u16, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect bridge");
        stream.set_read_timeout(Some(Duration::from_secs(3))).expect("read timeout");
        let req = format!(
            "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(req.as_bytes()).expect("write request");
        let mut resp = String::new();
        stream.read_to_string(&mut resp).expect("read response");
        let code = resp.split_whitespace().nth(1).expect("status").parse().expect("numeric status");
        (code, resp)
    }

    fn start(status: i64) -> (Arc<FakeCalendar>, BridgeServer) {
        let fake = Arc::new(FakeCalendar::default());
        fake.status.store(status, Ordering::SeqCst);
        let server = start_bridge_server(make_bridge_token().expect("token"), fake.clone()).expect("start bridge");
        (fake, server)
    }

    #[test]
    fn passive_returns_raw_status_and_never_grants() {
        let (fake, server) = start(4);
        let (code, raw) = post(server.port, &server.token, "/v1/passive/calendar", "{}");
        assert_eq!(code, 200);
        assert!(raw.ends_with(r#"{"answer":null,"raw":4,"status":4}"#), "{raw}");
        assert_eq!(fake.grants.load(Ordering::SeqCst), 0);
    }

    /// 11-15 real run: Allow in our own dialog, class status still notDetermined in-process; the completion's granted wins.
    #[test]
    fn a_granted_completion_lifts_a_stale_not_determined_status_for_passive_and_reads() {
        let (fake, server) = start(0);
        *fake.answer.lock().unwrap() = Some(true);
        let (code, raw) = post(server.port, &server.token, "/v1/passive/calendar", "{}");
        assert_eq!(code, 200);
        assert!(raw.ends_with(r#"{"answer":true,"raw":0,"status":3}"#), "{raw}");
        assert_eq!(post(server.port, &server.token, "/v1/read/calendars", "{}").0, 200);
        // A refusal read after an old granted answer stays a refusal.
        fake.status.store(2, Ordering::SeqCst);
        assert_eq!(post(server.port, &server.token, "/v1/read/calendars", "{}").0, 403);
        assert_eq!(fake.grants.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn grant_fires_once_and_returns_requested() {
        let (fake, server) = start(0);
        let (code, raw) = post(server.port, &server.token, "/v1/grant/calendar", "{}");
        assert_eq!(code, 200);
        assert!(raw.ends_with(r#"{"requested":true}"#), "{raw}");
        assert_eq!(fake.grants.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn read_rechecks_status_natively_and_refuses_unless_full_access() {
        // writeOnly (4), restricted (1), denied (2) and notDetermined (0) all refuse without reading or prompting.
        for status in [0, 1, 2, 4] {
            let (fake, server) = start(status);
            let (code, raw) = post(server.port, &server.token, "/v1/read/calendar-events", r#"{"fromMs":0,"toMs":120000}"#);
            assert_eq!(code, 403, "status {status}: {raw}");
            assert!(raw.contains("calendar_not_authorized"));
            assert_eq!(fake.status_reads.load(Ordering::SeqCst), 1);
            assert_eq!(fake.reads.load(Ordering::SeqCst), 0);
            assert_eq!(fake.grants.load(Ordering::SeqCst), 0);
        }
        let (fake, server) = start(FULL_ACCESS);
        let (code, raw) = post(server.port, &server.token, "/v1/read/calendar-events", r#"{"fromMs":0,"toMs":120000}"#);
        assert_eq!(code, 200, "{raw}");
        assert!(raw.contains(r#""title":"周会""#) && raw.contains(r#""startMs":60000"#), "{raw}");
        assert_eq!(fake.reads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn read_rejects_bad_window_and_wrong_token() {
        let (fake, server) = start(FULL_ACCESS);
        for body in ["{}", r#"{"fromMs":10,"toMs":10}"#, r#"{"fromMs":0,"toMs":3600001}"#, r#"{"fromMs":0,"toMs":1,"x":1}"#] {
            assert_eq!(post(server.port, &server.token, "/v1/read/calendar-events", body).0, 400, "{body}");
        }
        let wrong = "0".repeat(64);
        for path in ["/v1/passive/calendar", "/v1/grant/calendar", "/v1/read/calendar-events"] {
            assert_eq!(post(server.port, &wrong, path, r#"{"fromMs":0,"toMs":1}"#).0, 401, "{path}");
        }
        assert_eq!(fake.status_reads.load(Ordering::SeqCst), 0);
        assert_eq!(fake.reads.load(Ordering::SeqCst), 0);
        assert_eq!(fake.grants.load(Ordering::SeqCst), 0);
    }

    const CHAT_ROUTES: [(&str, &str); 4] = [
        ("/v1/read/calendars", "{}"),
        ("/v1/read/calendar-items", r#"{"fromMs":0,"toMs":86400000}"#),
        ("/v1/read/calendar-event", r#"{"eventId":"series"}"#),
        ("/v1/write/calendar-event", r#"{"op":"delete","eventId":"series"}"#),
    ];

    #[test]
    fn chat_routes_recheck_status_natively_and_refuse_unless_full_access() {
        for status in [0, 1, 2, 4] {
            for (path, body) in CHAT_ROUTES {
                let (fake, server) = start(status);
                fake.items.lock().unwrap().push(occurrence(1_000));
                let (code, raw) = post(server.port, &server.token, path, body);
                assert_eq!(code, 403, "{path} status {status}: {raw}");
                assert!(raw.contains("calendar_not_authorized"));
                assert_eq!(fake.status_reads.load(Ordering::SeqCst), 1);
                assert_eq!(fake.reads.load(Ordering::SeqCst) + fake.writes.load(Ordering::SeqCst), 0, "{path}");
                assert_eq!(fake.grants.load(Ordering::SeqCst), 0);
                assert_eq!(fake.items.lock().unwrap().len(), 1, "{path} must not touch data");
            }
        }
        let wrong = "0".repeat(64);
        let (fake, server) = start(FULL_ACCESS);
        for (path, body) in CHAT_ROUTES {
            assert_eq!(post(server.port, &wrong, path, body).0, 401, "{path}");
        }
        assert_eq!(fake.status_reads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn chat_reads_return_calendars_and_items() {
        let (fake, server) = start(FULL_ACCESS);
        fake.items.lock().unwrap().push(occurrence(1_000));
        let (code, raw) = post(server.port, &server.token, "/v1/read/calendars", "{}");
        assert_eq!(code, 200, "{raw}");
        assert!(raw.ends_with(r#"{"calendars":[{"id":"c1","isDefault":true,"title":"工作","writable":true}]}"#), "{raw}");
        let (code, raw) = post(server.port, &server.token, "/v1/read/calendar-items", r#"{"fromMs":0,"toMs":86400000,"calendarId":"c1","limit":5}"#);
        assert_eq!(code, 200, "{raw}");
        assert!(raw.contains(r#""calendarId":"c1""#) && raw.contains(r#""startMs":1000"#) && raw.contains(r#""recurring":true"#), "{raw}");
        let (code, raw) = post(server.port, &server.token, "/v1/read/calendar-items", r#"{"fromMs":0,"toMs":1,"calendarId":"missing"}"#);
        assert_eq!(code, 404, "{raw}");
        assert!(raw.contains("calendar_not_found"));
    }

    #[test]
    fn chat_routes_reject_bad_bodies_before_touching_eventkit() {
        let (fake, server) = start(FULL_ACCESS);
        let window = 400 * 24 * 3_600_000_i64 + 1;
        let items_bad = [
            "{}".to_string(),
            r#"{"fromMs":5,"toMs":5}"#.to_string(),
            format!(r#"{{"fromMs":0,"toMs":{window}}}"#),
            r#"{"fromMs":0,"toMs":1,"limit":0}"#.to_string(),
            r#"{"fromMs":0,"toMs":1,"x":1}"#.to_string(),
        ];
        for body in &items_bad {
            assert_eq!(post(server.port, &server.token, "/v1/read/calendar-items", body).0, 400, "{body}");
        }
        let writes_bad = [
            r#"{"op":"create","title":"","startMs":0,"endMs":1}"#,
            r#"{"op":"create","title":"a","startMs":0}"#,
            r#"{"op":"create","title":"a","startMs":5,"endMs":1}"#,
            r#"{"op":"create","title":"a","startMs":0,"endMs":1,"eventId":"x"}"#,
            r#"{"op":"update","eventId":"series"}"#,
            r#"{"op":"update","title":"a"}"#,
            r#"{"op":"delete","eventId":"series","title":"a"}"#,
            r#"{"op":"delete"}"#,
            r#"{"op":"move","eventId":"series"}"#,
            r#"{"op":"delete","eventId":"series","extra":1}"#,
        ];
        for body in writes_bad {
            assert_eq!(post(server.port, &server.token, "/v1/write/calendar-event", body).0, 400, "{body}");
        }
        assert_eq!(fake.status_reads.load(Ordering::SeqCst), 0);
        assert_eq!(fake.reads.load(Ordering::SeqCst) + fake.writes.load(Ordering::SeqCst), 0);
    }

    /// ai-review Important: undo re-creates an event with its notes; a meeting invite's notes run well past 4 KB.
    #[test]
    fn a_create_with_long_notes_fits_the_body_limit() {
        let (fake, server) = start(FULL_ACCESS);
        let notes = "拨入号码与多语言说明。".repeat(1_500); // ≈ 49 KB UTF-8
        let body = format!(r#"{{"op":"create","title":"周会","startMs":10,"endMs":20,"notes":"{notes}"}}"#);
        assert!(body.len() > 40_000);
        let (code, raw) = post(server.port, &server.token, "/v1/write/calendar-event", &body);
        assert_eq!(code, 200, "{}", &raw[..raw.len().min(200)]);
        assert_eq!(fake.writes.load(Ordering::SeqCst), 1);
    }

    /// One weekly series, two occurrences sharing the id: the occurrence time picks the second one only.
    #[test]
    fn write_addresses_one_occurrence_of_a_recurring_series() {
        let (fake, server) = start(FULL_ACCESS);
        fake.items.lock().unwrap().extend([occurrence(1_000), occurrence(1_000 + WEEK)]);
        let body = format!(r#"{{"eventId":"series","occurrenceMs":{}}}"#, 1_000 + WEEK);
        let (code, raw) = post(server.port, &server.token, "/v1/read/calendar-event", &body);
        assert_eq!(code, 200, "{raw}");
        assert!(raw.contains(&format!(r#""startMs":{}"#, 1_000 + WEEK)), "{raw}");
        assert_eq!(post(server.port, &server.token, "/v1/read/calendar-event", r#"{"eventId":""}"#).0, 400);
        let body = format!(r#"{{"op":"update","eventId":"series","occurrenceMs":{},"title":"改期"}}"#, 1_000 + WEEK);
        let (code, raw) = post(server.port, &server.token, "/v1/write/calendar-event", &body);
        assert_eq!(code, 200, "{raw}");
        let titles: Vec<String> = fake.items.lock().unwrap().iter().map(|e| e.title.clone()).collect();
        assert_eq!(titles, ["周会", "改期"]);

        let body = format!(r#"{{"op":"delete","eventId":"series","occurrenceMs":{}}}"#, 1_000 + WEEK);
        let (code, raw) = post(server.port, &server.token, "/v1/write/calendar-event", &body);
        assert_eq!(code, 200, "{raw}");
        assert!(raw.ends_with(r#"{"deleted":true,"title":"改期"}"#), "{raw}");
        assert_eq!(fake.items.lock().unwrap().iter().map(|e| e.start_ms).collect::<Vec<_>>(), [1_000]);

        let (code, raw) = post(server.port, &server.token, "/v1/write/calendar-event", r#"{"op":"delete","eventId":"series","occurrenceMs":7}"#);
        assert_eq!(code, 404, "{raw}");
        assert!(raw.contains("event_not_found"));

        let (code, raw) = post(server.port, &server.token, "/v1/write/calendar-event", r#"{"op":"create","title":"新会","startMs":10,"endMs":20,"location":"三楼","notes":"撤销重建带备注"}"#);
        assert_eq!(code, 200, "{raw}");
        assert!(raw.contains(r#""id":"new""#) && raw.contains(r#""title":"新会""#), "{raw}");
    }
}
