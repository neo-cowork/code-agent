import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const GRANT_MODULE = 'src-tauri/src/env_assist_grant.rs';
const PASSIVE_MODULE = 'src-tauri/src/env_assist_passive.rs';

const FORBIDDEN_PROMPT_APIS =
  /\b(?:AXIsProcessTrustedWithOptions|kAXTrustedCheckOptionPrompt|CGRequestScreenCaptureAccess|CGRequestListenEventAccess|CGRequestPostEventAccess|IOHIDRequestAccess)\b/;

const AUTOMATE_TARGET_TRUE_CALL =
  /\bAEDeterminePermissionToAutomateTarget\s*\([^)]*,\s*(?:true|1)\s*,?\s*\)/g;

// Existing shell callers outside env_assist_grant.rs are frozen by exact trimmed line.
// Each entry is user-initiated; moving it in this ticket would change existing runtime behaviour.
const LEGACY_PROMPT_LINES: Record<string, string[]> = {
  // User-initiated screenshot flow prompts once per session if Screen Recording is not yet granted; moving it changes behaviour.
  'src-tauri/src/native_desktop.rs': [
    'fn CGRequestScreenCaptureAccess() -> bool;',
    '// First time this session: trigger the system permission dialog via CGRequestScreenCaptureAccess().',
    'let requested = unsafe { CGRequestScreenCaptureAccess() };',
  ],
  // User-initiated hotkey setup command (appshots_request_hotkey_access) resolves CGRequestListenEventAccess via dlsym once per process.
  'src-tauri/src/appshots.rs': [
    'let outcome = match RESOLVED.get_or_init(|| listen_event_access_fn(c"CGRequestListenEventAccess")) {',
  ],
  // Doc comment describing the explicit appshots_request_hotkey_access gate above.
  'src-tauri/src/appshots_hotkey_gate.rs': [
    '/// 显式请求但尚未授权 → 先 CGRequestListenEventAccess（每进程至多一次），授权了再装。',
  ],
};

function collectRustFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectRustFiles(full);
    return full.endsWith('.rs') ? [full] : [];
  });
}

describe('env-assist Rust permission boundary', () => {
  it('restricts dialog-raising macOS permission APIs to env_assist_grant.rs', () => {
    const root = process.cwd();
    const rustFiles = collectRustFiles(path.join(root, 'src-tauri/src'));
    const relPaths = rustFiles.map((file) => path.relative(root, file).replaceAll('\\', '/'));

    expect(relPaths).toContain(GRANT_MODULE);
    expect(relPaths).toContain(PASSIVE_MODULE);

    const violations: string[] = [];

    for (const file of rustFiles) {
      const rel = path.relative(root, file).replaceAll('\\', '/');
      const source = fs.readFileSync(file, 'utf8');

      if (rel === GRANT_MODULE) continue;

      for (const match of source.matchAll(AUTOMATE_TARGET_TRUE_CALL)) {
        violations.push(`${rel}: ${match[0].replace(/\s+/g, ' ').trim()}`);
      }

      if (rel !== PASSIVE_MODULE && /\bAEDeterminePermissionToAutomateTarget\b/.test(source)) {
        violations.push(`${rel}: unexpected AEDeterminePermissionToAutomateTarget outside env_assist modules`);
      }

      if (rel === PASSIVE_MODULE) {
        if (/\benv_assist_grant\b/.test(source)) {
          violations.push(`${rel}: passive module must not reference env_assist_grant`);
        }
        for (const call of source.matchAll(/imp::AEDeterminePermissionToAutomateTarget\s*\([^)]*\)/g)) {
          if (!/,\s*false\s*,?\s*\)$/.test(call[0])) {
            violations.push(`${rel}: passive automation call must pass false: ${call[0].replace(/\s+/g, ' ')}`);
          }
        }
      }

      const remaining = rel === PASSIVE_MODULE ? [] : [...(LEGACY_PROMPT_LINES[rel] ?? [])];
      for (const line of source.split('\n')) {
        const trimmed = line.trim();
        if (!FORBIDDEN_PROMPT_APIS.test(trimmed)) continue;
        const idx = remaining.indexOf(trimmed);
        if (idx < 0) {
          violations.push(`${rel}: ${trimmed}`);
        } else {
          remaining.splice(idx, 1);
        }
      }
    }

    expect(violations, 'dialog-raising macOS APIs outside env_assist_grant.rs').toEqual([]);
  });

  it('keeps both env_assist modules plain pub fns off the webview Tauri command surface', () => {
    const root = process.cwd();
    const passive = fs.readFileSync(path.join(root, PASSIVE_MODULE), 'utf8');
    const grant = fs.readFileSync(path.join(root, GRANT_MODULE), 'utf8');
    const main = fs.readFileSync(path.join(root, 'src-tauri/src/main.rs'), 'utf8');

    expect(passive).not.toMatch(/^\s*#\[\s*tauri::command/m);
    expect(grant).not.toMatch(/^\s*#\[\s*tauri::command/m);

    const handlerMatch = /tauri::generate_handler!\[[\s\S]*?\]/.exec(main);
    expect(handlerMatch, 'tauri::generate_handler! anchor missing').not.toBeNull();
    expect(handlerMatch![0]).not.toMatch(/env_assist/);
  });
});
