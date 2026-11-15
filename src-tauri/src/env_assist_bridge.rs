//! Token-protected loopback HTTP/1.1 bridge for macOS env-assist probes and grants.
//!
//! Binds `127.0.0.1:0` once per shell launch with a 32-byte random hex token
//! (`ring::rand::SystemRandom`), passed exclusively to the webServer child via
//! `CODE_AGENT_ENV_ASSIST_BRIDGE_URL` and `CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN`.

#[cfg(target_os = "macos")]
mod calendar;

#[cfg(target_os = "macos")]
mod imp {
    use serde::Deserialize;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, OnceLock};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;

    const BRIDGE_TOKEN_BYTES: usize = 32;
    // Room for a calendar write (title + location in CJK); every other route takes an empty or tiny body.
    const MAX_BODY_BYTES: usize = 4096;
    const MAX_HEADER_BYTES: usize = 8192;
    const IO_TIMEOUT: Duration = Duration::from_secs(5);

    pub(super) trait BridgeHandlers: Send + Sync + 'static {
        fn passive_accessibility(&self) -> Result<bool, String>;
        fn passive_screen(&self) -> Result<bool, String>;
        fn passive_input(&self) -> Result<i32, String>;
        fn passive_automation(&self, target_bundle_id: &str) -> Result<i32, String>;
        fn grant_accessibility(&self) -> Result<bool, String>;
        fn grant_screen(&self) -> Result<bool, String>;
        fn grant_input(&self) -> Result<bool, String>;
        fn grant_automation(&self, target_bundle_id: &str) -> Result<i32, String>;
        // EventKit calendar routes live in env_assist_bridge_calendar.rs; defaults are the real native calls.
        fn passive_calendar(&self) -> Result<i64, String> {
            crate::env_assist_calendar::authorization_status()
        }
        fn grant_calendar(&self) -> Result<(), String> {
            crate::env_assist_calendar::request_full_access()
        }
        fn read_calendar_events(&self, from_ms: i64, to_ms: i64) -> Result<Vec<crate::env_assist_calendar::CalendarEvent>, String> {
            crate::env_assist_calendar::list_events(from_ms, to_ms)
        }
        // Chat calendar tool (env_assist_calendar_items.rs): same full-access re-check in the route, then these.
        fn list_calendars(&self) -> Result<Vec<crate::env_assist_calendar_items::CalendarInfo>, String> {
            crate::env_assist_calendar_items::list_calendars()
        }
        fn read_calendar_items(&self, from_ms: i64, to_ms: i64, calendar_id: Option<&str>, limit: usize) -> Result<Vec<crate::env_assist_calendar_items::CalendarItem>, String> {
            crate::env_assist_calendar_items::list_items(from_ms, to_ms, calendar_id, limit)
        }
        fn write_calendar_event(&self, op: crate::env_assist_calendar_items::WriteOp) -> Result<crate::env_assist_calendar_items::WriteOutcome, String> {
            crate::env_assist_calendar_items::write(op)
        }
    }

    struct RealBridgeHandlers;

    impl BridgeHandlers for RealBridgeHandlers {
        fn passive_accessibility(&self) -> Result<bool, String> {
            crate::env_assist_passive::check_accessibility()
        }
        fn passive_screen(&self) -> Result<bool, String> {
            crate::env_assist_passive::check_screen_capture()
        }
        fn passive_input(&self) -> Result<i32, String> {
            crate::env_assist_passive::check_input_monitoring()
        }
        fn passive_automation(&self, target_bundle_id: &str) -> Result<i32, String> {
            crate::env_assist_passive::check_automation(target_bundle_id)
        }
        fn grant_accessibility(&self) -> Result<bool, String> {
            crate::env_assist_grant::request_accessibility()
        }
        fn grant_screen(&self) -> Result<bool, String> {
            crate::env_assist_grant::request_screen_capture()
        }
        fn grant_input(&self) -> Result<bool, String> {
            crate::env_assist_grant::request_input_monitoring()
        }
        fn grant_automation(&self, target_bundle_id: &str) -> Result<i32, String> {
            crate::env_assist_grant::request_automation(target_bundle_id)
        }
    }

    pub(super) struct BridgeServer {
        pub(super) url: String,
        pub(super) token: String,
        pub(super) port: u16,
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    impl Drop for BridgeServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            let _ = TcpStream::connect(("127.0.0.1", self.port));
            if let Some(handle) = self.thread.take() {
                let _ = handle.join();
            }
        }
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct AutomationRequest {
        #[serde(rename = "targetBundleId")]
        target_bundle_id: String,
    }

    pub(super) fn make_bridge_token() -> Result<String, String> {
        use ring::rand::SecureRandom;
        let mut bytes = [0u8; BRIDGE_TOKEN_BYTES];
        ring::rand::SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| "Failed to obtain env_assist_bridge randomness".to_string())?;
        Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }

    fn bearer_token_matches(auth_header: Option<&str>, expected_token: &str) -> bool {
        let Some(header) = auth_header else {
            return false;
        };
        let Some(provided) = header.strip_prefix("Bearer ") else {
            return false;
        };
        let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, b"env-assist-bridge-token-v1");
        let expected_tag = ring::hmac::sign(&key, expected_token.as_bytes());
        ring::hmac::verify(&key, provided.as_bytes(), expected_tag.as_ref()).is_ok()
    }

    fn write_json_response(
        stream: &mut TcpStream,
        status: u16,
        reason: &str,
        extra_headers: &str,
        body: &serde_json::Value,
    ) {
        let payload = body.to_string();
        let response = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra_headers}\r\n{payload}",
            payload.len()
        );
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
        let _ = stream.shutdown(std::net::Shutdown::Write);
        let _ = stream.set_read_timeout(Some(Duration::from_millis(50)));
        let mut drain = [0u8; 1024];
        for _ in 0..8 {
            match stream.read(&mut drain) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    }

    fn find_header_end(buf: &[u8]) -> Option<usize> {
        buf.windows(4).position(|window| window == b"\r\n\r\n")
    }

    pub(super) fn parse_empty_or_empty_object(body: &[u8]) -> Result<(), ()> {
        if body.iter().all(|b| b.is_ascii_whitespace()) {
            return Ok(());
        }
        match serde_json::from_slice::<serde_json::Value>(body) {
            Ok(serde_json::Value::Object(map)) if map.is_empty() => Ok(()),
            _ => Err(()),
        }
    }

    fn parse_automation_bundle_id(body: &[u8]) -> Result<String, ()> {
        let parsed: AutomationRequest = serde_json::from_slice(body).map_err(|_| ())?;
        let trimmed = parsed.target_bundle_id.trim();
        if trimmed.is_empty() {
            return Err(());
        }
        Ok(trimmed.to_string())
    }

    fn handle_connection(
        stream: &mut TcpStream,
        expected_host: &str,
        expected_token: &str,
        handlers: &dyn BridgeHandlers,
    ) {
        let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
        let _ = stream.set_write_timeout(Some(IO_TIMEOUT));

        let mut buf = Vec::with_capacity(1024);
        let mut chunk = [0u8; 1024];
        let header_end = loop {
            if let Some(pos) = find_header_end(&buf) {
                break pos;
            }
            if buf.len() > MAX_HEADER_BYTES {
                write_json_response(
                    stream,
                    413,
                    "Payload Too Large",
                    "",
                    &serde_json::json!({ "error": "headers_too_large" }),
                );
                return;
            }
            match stream.read(&mut chunk) {
                Ok(0) => {
                    if !buf.is_empty() {
                        write_json_response(
                            stream,
                            400,
                            "Bad Request",
                            "",
                            &serde_json::json!({ "error": "incomplete_request" }),
                        );
                    }
                    return;
                }
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                Err(_) => return,
            }
        };

        let Ok(header_str) = std::str::from_utf8(&buf[..header_end]) else {
            write_json_response(
                stream,
                400,
                "Bad Request",
                "",
                &serde_json::json!({ "error": "invalid_headers" }),
            );
            return;
        };

        let mut lines = header_str.split("\r\n");
        let Some(request_line) = lines.next() else {
            write_json_response(
                stream,
                400,
                "Bad Request",
                "",
                &serde_json::json!({ "error": "missing_request_line" }),
            );
            return;
        };

        let mut req_parts = request_line.split_whitespace();
        let (Some(method), Some(path), Some(version), None) = (
            req_parts.next(),
            req_parts.next(),
            req_parts.next(),
            req_parts.next(),
        ) else {
            write_json_response(
                stream,
                400,
                "Bad Request",
                "",
                &serde_json::json!({ "error": "malformed_request_line" }),
            );
            return;
        };
        if version != "HTTP/1.1" && version != "HTTP/1.0" {
            write_json_response(
                stream,
                400,
                "Bad Request",
                "",
                &serde_json::json!({ "error": "unsupported_http_version" }),
            );
            return;
        }

        let mut host_header: Option<&str> = None;
        let mut multiple_hosts = false;
        let mut auth_header: Option<&str> = None;
        let mut multiple_auth = false;
        let mut content_length_header: Option<&str> = None;
        let mut multiple_content_length = false;
        let mut has_transfer_encoding = false;

        for line in lines {
            if line.is_empty() {
                continue;
            }
            let Some((raw_name, raw_val)) = line.split_once(':') else {
                write_json_response(
                    stream,
                    400,
                    "Bad Request",
                    "",
                    &serde_json::json!({ "error": "malformed_header" }),
                );
                return;
            };
            let name = raw_name.trim();
            let val = raw_val.trim();
            if name.eq_ignore_ascii_case("host") {
                if host_header.is_some() {
                    multiple_hosts = true;
                }
                host_header = Some(val);
            } else if name.eq_ignore_ascii_case("authorization") {
                if auth_header.is_some() {
                    multiple_auth = true;
                }
                auth_header = Some(val);
            } else if name.eq_ignore_ascii_case("content-length") {
                if content_length_header.is_some() {
                    multiple_content_length = true;
                }
                content_length_header = Some(val);
            } else if name.eq_ignore_ascii_case("transfer-encoding") {
                has_transfer_encoding = true;
            }
        }

        if multiple_hosts || host_header != Some(expected_host) {
            write_json_response(
                stream,
                403,
                "Forbidden",
                "",
                &serde_json::json!({ "error": "invalid_host" }),
            );
            return;
        }

        if method != "POST" {
            write_json_response(
                stream,
                405,
                "Method Not Allowed",
                "Allow: POST\r\n",
                &serde_json::json!({ "error": "method_not_allowed" }),
            );
            return;
        }

        if multiple_auth || !bearer_token_matches(auth_header, expected_token) {
            write_json_response(
                stream,
                401,
                "Unauthorized",
                "",
                &serde_json::json!({ "error": "unauthorized" }),
            );
            return;
        }

        if multiple_content_length {
            write_json_response(
                stream,
                400,
                "Bad Request",
                "",
                &serde_json::json!({ "error": "duplicate_content_length" }),
            );
            return;
        }

        if has_transfer_encoding {
            write_json_response(
                stream,
                413,
                "Payload Too Large",
                "",
                &serde_json::json!({ "error": "body_too_large" }),
            );
            return;
        }

        let initial_body = &buf[header_end + 4..];
        if initial_body.len() > MAX_BODY_BYTES {
            write_json_response(
                stream,
                413,
                "Payload Too Large",
                "",
                &serde_json::json!({ "error": "body_too_large" }),
            );
            return;
        }

        let expected_len = match content_length_header {
            Some(raw_len) => match raw_len.parse::<usize>() {
                Ok(len) if len <= MAX_BODY_BYTES => len,
                Ok(_) => {
                    write_json_response(
                        stream,
                        413,
                        "Payload Too Large",
                        "",
                        &serde_json::json!({ "error": "body_too_large" }),
                    );
                    return;
                }
                Err(_) => {
                    write_json_response(
                        stream,
                        400,
                        "Bad Request",
                        "",
                        &serde_json::json!({ "error": "invalid_content_length" }),
                    );
                    return;
                }
            },
            None => {
                if !initial_body.is_empty() {
                    write_json_response(
                        stream,
                        400,
                        "Bad Request",
                        "",
                        &serde_json::json!({ "error": "missing_content_length" }),
                    );
                    return;
                }
                0
            }
        };

        let mut body = Vec::with_capacity(expected_len);
        body.extend_from_slice(initial_body);
        while body.len() < expected_len {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => {
                    write_json_response(
                        stream,
                        400,
                        "Bad Request",
                        "",
                        &serde_json::json!({ "error": "truncated_body" }),
                    );
                    return;
                }
                Ok(n) => {
                    body.extend_from_slice(&chunk[..n]);
                    if body.len() > MAX_BODY_BYTES {
                        write_json_response(
                            stream,
                            413,
                            "Payload Too Large",
                            "",
                            &serde_json::json!({ "error": "body_too_large" }),
                        );
                        return;
                    }
                }
            }
        }
        if body.len() > expected_len {
            write_json_response(
                stream,
                400,
                "Bad Request",
                "",
                &serde_json::json!({ "error": "body_exceeds_content_length" }),
            );
            return;
        }

        let outcome: Result<serde_json::Value, (u16, &'static str, serde_json::Value)> = match path
        {
            "/v1/passive/accessibility" => parse_empty_or_empty_object(&body)
                .map_err(|_| bad_body())
                .and_then(|()| {
                    handlers
                        .passive_accessibility()
                        .map(|trusted| serde_json::json!({ "trusted": trusted }))
                        .map_err(native_err)
                }),
            "/v1/passive/screen" => parse_empty_or_empty_object(&body)
                .map_err(|_| bad_body())
                .and_then(|()| {
                    handlers
                        .passive_screen()
                        .map(|granted| serde_json::json!({ "granted": granted }))
                        .map_err(native_err)
                }),
            "/v1/passive/input" => parse_empty_or_empty_object(&body)
                .map_err(|_| bad_body())
                .and_then(|()| {
                    handlers
                        .passive_input()
                        .map(|code| serde_json::json!({ "code": code }))
                        .map_err(native_err)
                }),
            "/v1/passive/automation" => parse_automation_bundle_id(&body)
                .map_err(|_| bad_body())
                .and_then(|bundle_id| {
                    handlers
                        .passive_automation(&bundle_id)
                        .map(|code| serde_json::json!({ "code": code }))
                        .map_err(native_err)
                }),
            "/v1/grant/accessibility" => parse_empty_or_empty_object(&body)
                .map_err(|_| bad_body())
                .and_then(|()| {
                    handlers
                        .grant_accessibility()
                        .map(|trusted| serde_json::json!({ "requested": true, "trusted": trusted }))
                        .map_err(native_err)
                }),
            "/v1/grant/screen" => parse_empty_or_empty_object(&body)
                .map_err(|_| bad_body())
                .and_then(|()| {
                    handlers
                        .grant_screen()
                        .map(|granted| serde_json::json!({ "requested": true, "granted": granted }))
                        .map_err(native_err)
                }),
            "/v1/grant/input" => parse_empty_or_empty_object(&body)
                .map_err(|_| bad_body())
                .and_then(|()| {
                    handlers
                        .grant_input()
                        .map(|granted| serde_json::json!({ "requested": true, "granted": granted }))
                        .map_err(native_err)
                }),
            "/v1/grant/automation" => parse_automation_bundle_id(&body)
                .map_err(|_| bad_body())
                .and_then(|bundle_id| {
                    handlers
                        .grant_automation(&bundle_id)
                        .map(|code| serde_json::json!({ "requested": true, "code": code }))
                        .map_err(native_err)
                }),
            "/v1/passive/calendar" | "/v1/grant/calendar" | "/v1/read/calendar-events" | "/v1/read/calendars"
            | "/v1/read/calendar-items" | "/v1/write/calendar-event" => {
                super::calendar::route(path, &body, handlers)
            }
            _ => Err((
                404,
                "Not Found",
                serde_json::json!({ "error": "not_found" }),
            )),
        };

        match outcome {
            Ok(json) => write_json_response(stream, 200, "OK", "", &json),
            Err((status, reason, err_json)) => {
                write_json_response(stream, status, reason, "", &err_json)
            }
        }
    }

    pub(super) fn bad_body() -> (u16, &'static str, serde_json::Value) {
        (
            400,
            "Bad Request",
            serde_json::json!({ "error": "invalid_request_body" }),
        )
    }

    pub(super) fn native_err(detail: String) -> (u16, &'static str, serde_json::Value) {
        (
            500,
            "Internal Server Error",
            serde_json::json!({ "error": "native_error", "detail": detail }),
        )
    }

    pub(super) fn start_bridge_server(
        token: String,
        handlers: Arc<dyn BridgeHandlers>,
    ) -> Result<BridgeServer, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|err| format!("Failed to bind env_assist_bridge on 127.0.0.1:0: {err}"))?;
        let port = listener
            .local_addr()
            .map_err(|err| format!("Failed to read env_assist_bridge local_addr: {err}"))?
            .port();
        let expected_host = format!("127.0.0.1:{port}");
        let url = format!("http://127.0.0.1:{port}");
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread_token = token.clone();

        let thread = thread::Builder::new()
            .name("env-assist-bridge".to_string())
            .spawn(move || {
                for accepted in listener.incoming() {
                    if thread_stop.load(Ordering::SeqCst) {
                        break;
                    }
                    if let Ok(mut stream) = accepted {
                        handle_connection(
                            &mut stream,
                            &expected_host,
                            &thread_token,
                            handlers.as_ref(),
                        );
                    }
                }
            })
            .map_err(|err| format!("Failed to spawn env_assist_bridge thread: {err}"))?;

        Ok(BridgeServer {
            url,
            token,
            port,
            stop,
            thread: Some(thread),
        })
    }

    pub(super) fn ensure_started() -> Option<(&'static str, &'static str)> {
        static BRIDGE: OnceLock<Option<BridgeServer>> = OnceLock::new();
        let server = BRIDGE.get_or_init(|| {
            match make_bridge_token()
                .and_then(|token| start_bridge_server(token, Arc::new(RealBridgeHandlers)))
            {
                Ok(started) => Some(started),
                Err(error) => {
                    eprintln!("[env_assist_bridge] failed to start loopback bridge: {error}");
                    None
                }
            }
        });
        server
            .as_ref()
            .map(|started| (started.url.as_str(), started.token.as_str()))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::process::Command;
        use std::sync::atomic::AtomicUsize;
        use std::sync::Mutex;

        struct FakeBridgeHandlers {
            passive_calls: AtomicUsize,
            grant_calls: AtomicUsize,
            last_automation_target: Mutex<Option<String>>,
        }

        impl Default for FakeBridgeHandlers {
            fn default() -> Self {
                Self {
                    passive_calls: AtomicUsize::new(0),
                    grant_calls: AtomicUsize::new(0),
                    last_automation_target: Mutex::new(None),
                }
            }
        }

        impl BridgeHandlers for FakeBridgeHandlers {
            fn passive_accessibility(&self) -> Result<bool, String> {
                self.passive_calls.fetch_add(1, Ordering::SeqCst);
                Ok(false)
            }
            fn passive_screen(&self) -> Result<bool, String> {
                self.passive_calls.fetch_add(1, Ordering::SeqCst);
                Ok(true)
            }
            fn passive_input(&self) -> Result<i32, String> {
                self.passive_calls.fetch_add(1, Ordering::SeqCst);
                Ok(2)
            }
            fn passive_automation(&self, target_bundle_id: &str) -> Result<i32, String> {
                self.passive_calls.fetch_add(1, Ordering::SeqCst);
                *self.last_automation_target.lock().unwrap() = Some(target_bundle_id.to_string());
                Ok(-1744)
            }
            fn grant_accessibility(&self) -> Result<bool, String> {
                self.grant_calls.fetch_add(1, Ordering::SeqCst);
                Ok(true)
            }
            fn grant_screen(&self) -> Result<bool, String> {
                self.grant_calls.fetch_add(1, Ordering::SeqCst);
                Ok(true)
            }
            fn grant_input(&self) -> Result<bool, String> {
                self.grant_calls.fetch_add(1, Ordering::SeqCst);
                Ok(true)
            }
            fn grant_automation(&self, target_bundle_id: &str) -> Result<i32, String> {
                self.grant_calls.fetch_add(1, Ordering::SeqCst);
                *self.last_automation_target.lock().unwrap() = Some(target_bundle_id.to_string());
                Ok(0)
            }
        }

        fn send_raw_http(port: u16, raw_request: &str) -> (u16, String) {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect bridge");
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .expect("read timeout");
            stream
                .write_all(raw_request.as_bytes())
                .expect("write raw request");
            let mut resp = String::new();
            stream.read_to_string(&mut resp).expect("read response");
            let status_line = resp.lines().next().expect("status line");
            let code: u16 = status_line
                .split_whitespace()
                .nth(1)
                .expect("status code")
                .parse()
                .expect("numeric status");
            (code, resp)
        }

        mod node_chain {
            include!("env_assist_bridge_chain_tests.rs");
        }

        #[test]
        fn token_is_64_hex_chars_and_random_per_launch() {
            let first = make_bridge_token().expect("first token");
            let second = make_bridge_token().expect("second token");
            assert_eq!(first.len(), 64);
            assert_eq!(second.len(), 64);
            assert!(first.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
            assert!(second.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
            assert_ne!(first, second);
        }

        #[test]
        fn wrong_or_missing_token_returns_401_and_never_calls_handlers() {
            let fake = Arc::new(FakeBridgeHandlers::default());
            let token = make_bridge_token().expect("token");
            let server = start_bridge_server(token.clone(), fake.clone()).expect("start bridge");
            let host = format!("127.0.0.1:{}", server.port);
            let wrong_same_len = "0".repeat(64);

            for auth_line in [
                String::new(),
                "Authorization: Basic dXNlcjpwYXNz\r\n".to_string(),
                "Authorization: Bearer short\r\n".to_string(),
                format!("Authorization: Bearer {wrong_same_len}\r\n"),
            ] {
                let req = format!(
                    "POST /v1/grant/accessibility HTTP/1.1\r\nHost: {host}\r\n{auth_line}Content-Length: 2\r\n\r\n{{}}"
                );
                let (status, _) = send_raw_http(server.port, &req);
                assert_eq!(status, 401, "expected 401 for auth header {auth_line:?}");
            }
            assert_eq!(fake.passive_calls.load(Ordering::SeqCst), 0);
            assert_eq!(fake.grant_calls.load(Ordering::SeqCst), 0);
        }

        #[test]
        fn wrong_or_missing_host_returns_403_and_never_calls_handlers() {
            let fake = Arc::new(FakeBridgeHandlers::default());
            let token = make_bridge_token().expect("token");
            let server = start_bridge_server(token.clone(), fake.clone()).expect("start bridge");

            for host_line in [
                String::new(),
                format!("Host: localhost:{}\r\n", server.port),
                "Host: evil.example\r\n".to_string(),
                "Host: 127.0.0.1:1\r\n".to_string(),
            ] {
                let req = format!(
                    "POST /v1/passive/accessibility HTTP/1.1\r\n{host_line}Authorization: Bearer {token}\r\nContent-Length: 2\r\n\r\n{{}}"
                );
                let (status, _) = send_raw_http(server.port, &req);
                assert_eq!(status, 403, "expected 403 for host header {host_line:?}");
            }
            assert_eq!(fake.passive_calls.load(Ordering::SeqCst), 0);
            assert_eq!(fake.grant_calls.load(Ordering::SeqCst), 0);
        }

        #[test]
        fn non_post_methods_return_405_and_never_calls_handlers() {
            let fake = Arc::new(FakeBridgeHandlers::default());
            let token = make_bridge_token().expect("token");
            let server = start_bridge_server(token.clone(), fake.clone()).expect("start bridge");
            let host = format!("127.0.0.1:{}", server.port);

            for method in ["GET", "PUT", "DELETE", "OPTIONS", "HEAD"] {
                let req = format!(
                    "{method} /v1/passive/accessibility HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\n\r\n"
                );
                let (status, raw) = send_raw_http(server.port, &req);
                assert_eq!(status, 405, "expected 405 for {method}");
                assert!(raw.contains("Allow: POST\r\n"));
            }
            assert_eq!(fake.passive_calls.load(Ordering::SeqCst), 0);
            assert_eq!(fake.grant_calls.load(Ordering::SeqCst), 0);
        }

        #[test]
        fn oversize_body_is_rejected_with_413_and_never_calls_handlers() {
            let fake = Arc::new(FakeBridgeHandlers::default());
            let token = make_bridge_token().expect("token");
            let server = start_bridge_server(token.clone(), fake.clone()).expect("start bridge");
            let host = format!("127.0.0.1:{}", server.port);

            let oversize = format!(
                "{{\"targetBundleId\":\"{}\"}}",
                "a".repeat(MAX_BODY_BYTES + 1)
            );
            let req = format!(
                "POST /v1/passive/automation HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{oversize}",
                oversize.len()
            );
            let (status, _) = send_raw_http(server.port, &req);
            assert_eq!(status, 413);

            let chunked = format!(
                "POST /v1/passive/accessibility HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{{}}\r\n0\r\n\r\n"
            );
            let (chunked_status, _) = send_raw_http(server.port, &chunked);
            assert_eq!(chunked_status, 413);

            assert_eq!(fake.passive_calls.load(Ordering::SeqCst), 0);
            assert_eq!(fake.grant_calls.load(Ordering::SeqCst), 0);
        }

        #[test]
        fn passive_and_grant_routes_are_isolated_and_unknown_or_bad_body_rejected() {
            let fake = Arc::new(FakeBridgeHandlers::default());
            let token = make_bridge_token().expect("token");
            let server = start_bridge_server(token.clone(), fake.clone()).expect("start bridge");
            let host = format!("127.0.0.1:{}", server.port);

            for route in ["/v1/passive/accessibility", "/v1/passive/screen", "/v1/passive/input"] {
                let req = format!(
                    "POST {route} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nContent-Length: 2\r\n\r\n{{}}"
                );
                let (status, _) = send_raw_http(server.port, &req);
                assert_eq!(status, 200, "passive route {route}");
            }
            let auto_body = r#"{"targetBundleId":"com.apple.Calendar"}"#;
            let auto_req = format!(
                "POST /v1/passive/automation HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n{auto_body}",
                auto_body.len()
            );
            let (auto_status, auto_raw) = send_raw_http(server.port, &auto_req);
            assert_eq!(auto_status, 200);
            assert!(auto_raw.ends_with(r#"{"code":-1744}"#));
            assert_eq!(fake.passive_calls.load(Ordering::SeqCst), 4);
            assert_eq!(fake.grant_calls.load(Ordering::SeqCst), 0);

            let unknown_req = format!(
                "POST /v1/passive/unknown HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nContent-Length: 2\r\n\r\n{{}}"
            );
            assert_eq!(send_raw_http(server.port, &unknown_req).0, 404);

            let empty_bundle = r#"{"targetBundleId":"   "}"#;
            let bad_auto = format!(
                "POST /v1/grant/automation HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n{empty_bundle}",
                empty_bundle.len()
            );
            assert_eq!(send_raw_http(server.port, &bad_auto).0, 400);
            assert_eq!(fake.grant_calls.load(Ordering::SeqCst), 0);

            for route in ["/v1/grant/accessibility", "/v1/grant/screen", "/v1/grant/input"] {
                let req = format!(
                    "POST {route} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nContent-Length: 2\r\n\r\n{{}}"
                );
                assert_eq!(send_raw_http(server.port, &req).0, 200);
            }
            let grant_auto = format!(
                "POST /v1/grant/automation HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n{auto_body}",
                auto_body.len()
            );
            assert_eq!(send_raw_http(server.port, &grant_auto).0, 200);
            assert_eq!(fake.grant_calls.load(Ordering::SeqCst), 4);
        }

        #[test]
        fn ephemeral_listener_responds_to_curl_with_injected_fakes() {
            let fake = Arc::new(FakeBridgeHandlers::default());
            let token = make_bridge_token().expect("token");
            let server = start_bridge_server(token.clone(), fake.clone()).expect("start bridge");

            let run_curl = |args: &[&str]| -> String {
                let output = Command::new("curl")
                    .args(["--noproxy", "127.0.0.1", "-i", "-sS"])
                    .args(args)
                    .output()
                    .expect("spawn curl");
                assert!(
                    output.status.success(),
                    "curl failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                String::from_utf8_lossy(&output.stdout).into_owned()
            };

            let auth = format!("Authorization: Bearer {token}");
            let passive_ax = run_curl(&[
                "-X",
                "POST",
                "-H",
                &auth,
                "-H",
                "Content-Type: application/json",
                "-d",
                "{}",
                &format!("{}/v1/passive/accessibility", server.url),
            ]);
            println!("[curl passive accessibility]\n{passive_ax}");
            assert!(passive_ax.starts_with("HTTP/1.1 200 OK\r\n"));
            assert!(passive_ax.trim_end().ends_with(r#"{"trusted":false}"#));
            assert_eq!(fake.passive_calls.load(Ordering::SeqCst), 1);
            assert_eq!(fake.grant_calls.load(Ordering::SeqCst), 0);

            let grant_auto = run_curl(&[
                "-X",
                "POST",
                "-H",
                &auth,
                "-H",
                "Content-Type: application/json",
                "-d",
                r#"{"targetBundleId":"com.apple.Calendar"}"#,
                &format!("{}/v1/grant/automation", server.url),
            ]);
            println!("[curl grant automation]\n{grant_auto}");
            assert!(grant_auto.starts_with("HTTP/1.1 200 OK\r\n"));
            assert!(grant_auto.trim_end().ends_with(r#"{"code":0,"requested":true}"#)
                || grant_auto.trim_end().ends_with(r#"{"requested":true,"code":0}"#));
            assert_eq!(fake.passive_calls.load(Ordering::SeqCst), 1);
            assert_eq!(fake.grant_calls.load(Ordering::SeqCst), 1);

            let wrong_auth = run_curl(&[
                "-X",
                "POST",
                "-H",
                "Authorization: Bearer invalid",
                "-H",
                "Content-Type: application/json",
                "-d",
                "{}",
                &format!("{}/v1/grant/accessibility", server.url),
            ]);
            println!("[curl wrong token]\n{wrong_auth}");
            assert!(wrong_auth.starts_with("HTTP/1.1 401 Unauthorized\r\n"));
            assert!(wrong_auth.trim_end().ends_with(r#"{"error":"unauthorized"}"#));
            assert_eq!(fake.grant_calls.load(Ordering::SeqCst), 1);
        }
    }
}

pub const HANDSHAKE_FLAG_ENV: &str = "CODE_AGENT_ENV_ASSIST_BRIDGE_HANDSHAKE";

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn handshake_line(url: &str, token: &str) -> String {
    format!("CODE_AGENT_ENV_ASSIST_BRIDGE {url} {token}\n")
}

/// Writes the single handshake line to the child's stdin and flushes; keeps the handle open.
pub fn write_handshake(stdin: Option<&mut std::process::ChildStdin>, url: &str, token: &str) {
    use std::io::Write;
    if let Some(pipe) = stdin {
        let _ = pipe
            .write_all(handshake_line(url, token).as_bytes())
            .and_then(|_| pipe.flush());
    }
}

#[cfg(test)]
mod handshake_tests {
    use super::*;

    #[test]
    fn handshake_line_is_single_newline_terminated_line() {
        let line = handshake_line("http://127.0.0.1:5555", "abc123");
        assert_eq!(line, "CODE_AGENT_ENV_ASSIST_BRIDGE http://127.0.0.1:5555 abc123\n");
        assert_eq!(line.matches('\n').count(), 1);
    }

    #[test]
    fn spawn_path_never_puts_token_or_url_in_child_env() {
        let main_rs = include_str!("main.rs");
        for name in ["CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN", "CODE_AGENT_ENV_ASSIST_BRIDGE_URL"] {
            assert!(
                !main_rs.contains(&format!(".env(\"{name}\"")),
                "main.rs must not set {name} on the child"
            );
        }
        assert!(main_rs.contains("write_handshake("));
    }
}

#[cfg(target_os = "macos")]
pub fn ensure_started() -> Option<(&'static str, &'static str)> {
    imp::ensure_started()
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
pub fn ensure_started() -> Option<(&'static str, &'static str)> {
    None
}
