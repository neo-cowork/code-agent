// Included only inside the macOS #[cfg(test)] module, sharing its fake handlers.
use super::*;
use std::process::Stdio;
use std::time::Instant;

fn run_host_child(server: &BridgeServer) -> serde_json::Value {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let mut child = Command::new("node")
        .args([
            "--import",
            "tsx",
            "tests/unit/host/permissions/envAssist/shellBridgeHandshake.child.ts",
            &server.token[..8],
            "--all-routes",
        ])
        .current_dir(root)
        .env(crate::env_assist_bridge::HANDSHAKE_FLAG_ENV, "1")
        .env_remove("CODE_AGENT_ENV_ASSIST_BRIDGE_URL")
        .env_remove("CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn real Node host child");
    crate::env_assist_bridge::write_handshake(child.stdin.as_mut(), &server.url, &server.token);
    drop(child.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(40);
    while child.try_wait().expect("poll host child").is_none() {
        if Instant::now() > deadline {
            child.kill().expect("kill timed out child");
            let output = child.wait_with_output().expect("reap timed out child");
            panic!(
                "host child timeout: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let output = child.wait_with_output().expect("collect host child");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
    println!("[Rust -> Node prefix={}]\n{stdout}", &server.token[..8]);
    let result: serde_json::Value = serde_json::from_str(
        stdout
            .lines()
            .find_map(|l| l.strip_prefix("RESULT "))
            .expect("child RESULT"),
    )
    .unwrap();
    assert_eq!(
        result,
        serde_json::json!({"hasClient": true, "envLeak": false, "postOk": true})
    );
    let http: serde_json::Value = serde_json::from_str(
        stdout
            .lines()
            .find_map(|l| l.strip_prefix("HTTP "))
            .expect("child HTTP"),
    )
    .unwrap();
    let outcomes = http.as_array().unwrap();
    assert_eq!(outcomes.len(), 8);
    for (index, route) in ["accessibility", "screen", "input", "automation"]
        .iter()
        .enumerate()
    {
        for (offset, kind) in [(0, "passive"), (4, "grant")] {
            assert_eq!(
                outcomes[index + offset]["path"],
                format!("/v1/{kind}/{route}")
            );
            assert_eq!(outcomes[index + offset]["status"], 200);
        }
    }
    result
}

#[test]
fn real_listener_write_handshake_node_client_two_launches_and_cross_token_rejection() {
    let first_fake = Arc::new(FakeBridgeHandlers::default());
    let first = start_bridge_server(make_bridge_token().unwrap(), first_fake.clone()).unwrap();
    run_host_child(&first);
    let second_fake = Arc::new(FakeBridgeHandlers::default());
    let second = start_bridge_server(make_bridge_token().unwrap(), second_fake.clone()).unwrap();
    assert_ne!(first.token, second.token);
    run_host_child(&second);
    let (status, response) = send_raw_http(second.port, &format!(
        "POST /v1/grant/accessibility HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}",
        second.port, first.token,
    ));
    println!(
        "[cross-token prefixes {} -> {}] {}",
        &first.token[..8],
        &second.token[..8],
        response.lines().next().unwrap()
    );
    assert_eq!(status, 401);
    for fake in [&first_fake, &second_fake] {
        assert_eq!(fake.passive_calls.load(Ordering::SeqCst), 4);
        assert_eq!(fake.grant_calls.load(Ordering::SeqCst), 4);
        assert_eq!(
            fake.last_automation_target.lock().unwrap().as_deref(),
            Some("com.apple.iCal")
        );
        println!("[handlers] passive_calls=4 grant_calls=4 (cross-token adds zero)");
    }
}
