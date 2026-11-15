//! EventKit calendar routes of the env-assist bridge (`env_assist_bridge::calendar`; dispatched from
//! `imp::handle_connection`, so it shares the same token / Host / body checks that already ran in `handle_connection`).
//!
//! - `/v1/passive/calendar`      → `{ "status": 0..4 }`, never prompts.
//! - `/v1/grant/calendar`        → `{ "requested": true }`, fires the system dialog and returns at once.
//! - `/v1/read/calendar-events`  → `{ "events": [...] }`; the authorization status is re-read natively
//!   before every read, so a caller can't skip the grant by claiming it was given.

use super::imp::{bad_body, native_err, parse_empty_or_empty_object, BridgeHandlers};
use crate::env_assist_calendar::{FULL_ACCESS, MAX_WINDOW_MS};
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

pub(super) fn route(path: &str, body: &[u8], handlers: &dyn BridgeHandlers) -> Outcome {
    match path {
        "/v1/passive/calendar" => parse_empty_or_empty_object(body)
            .map_err(|_| bad_body())
            .and_then(|()| {
                handlers
                    .passive_calendar()
                    .map(|status| serde_json::json!({ "status": status }))
                    .map_err(native_err)
            }),
        "/v1/grant/calendar" => parse_empty_or_empty_object(body)
            .map_err(|_| bad_body())
            .and_then(|()| {
                handlers
                    .grant_calendar()
                    .map(|()| serde_json::json!({ "requested": true }))
                    .map_err(native_err)
            }),
        _ => {
            let req = parse_read(body).map_err(|_| bad_body())?;
            let status = handlers.passive_calendar().map_err(native_err)?;
            if status != FULL_ACCESS {
                return Err((
                    403,
                    "Forbidden",
                    serde_json::json!({ "error": "calendar_not_authorized", "status": status }),
                ));
            }
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
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    #[derive(Default)]
    struct FakeCalendar {
        status: AtomicI64,
        status_reads: AtomicUsize,
        grants: AtomicUsize,
        reads: AtomicUsize,
    }

    impl BridgeHandlers for FakeCalendar {
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
        assert!(raw.ends_with(r#"{"status":4}"#), "{raw}");
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
}
