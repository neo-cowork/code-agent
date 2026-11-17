import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => fs.readFileSync(path.join(process.cwd(), 'src-tauri/src', name), 'utf8');
const native = read('native_notification.rs');

describe('durable notification-click-released shell event contract', () => {
  it('records the renderer-ready release with the drained count next to the writer call', () => {
    const start = native.indexOf('app.listen("renderer-ready"');
    const end = native.indexOf('let timeout_app', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const listener = native.slice(start, end);
    expect(listener).toMatch(/let released = pending\.len\(\);/);
    expect(listener).toContain(
      'write_notification_click_released(&ready_app, "renderer-ready", released)',
    );
  });

  it('records the timeout release with the reason returned by renderer_ready_timeout', () => {
    const start = native.indexOf('std::thread::spawn(move || {');
    expect(start).toBeGreaterThan(-1);
    const thread = native.slice(start);
    const end = thread.indexOf('Ok(())');
    expect(end).toBeGreaterThan(-1);
    const body = thread.slice(0, end);
    expect(body).toMatch(/renderer_ready_timeout\(installed_at\.elapsed\(\)\)/);
    expect(body).toContain('write_notification_click_released(&timeout_app, reason, released)');
    // The reason is the literal bound in ClickDelivery::renderer_ready_timeout,
    // not a second string that could drift from it.
    expect(native).toContain(
      'Some(("notification-click-ready-timeout", self.renderer_ready()))',
    );
  });

  it('routes the release payload through the durable shell event envelope', () => {
    const start = native.indexOf('fn write_notification_click_released');
    const end = native.indexOf('#[cfg(target_os = "macos")]', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const writer = native.slice(start, end);
    expect(writer).toContain('crate::append_shell_event_payload(');
    expect(writer).toContain('"event": payload["event"]');
    expect(writer).toContain('"details": payload["details"]');
    const builder = native.slice(
      native.indexOf('fn notification_click_released_payload'),
      start,
    );
    expect(builder).toMatch(/if released == 0\s*\{\s*return None;\s*\}/);
    expect(builder).toContain('NOTIFICATION_CLICK_RELEASED_EVENT');
    expect(native).toContain(
      'const NOTIFICATION_CLICK_RELEASED_EVENT: &str = "notification-click-released";',
    );
  });
});
