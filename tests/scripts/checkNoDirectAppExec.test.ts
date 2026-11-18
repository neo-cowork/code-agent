import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GATE = path.resolve('scripts/ci/check-no-direct-app-exec.mjs');

function runGate(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'no-direct-exec-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    return spawnSync(process.execPath, [GATE, '--root', root], { encoding: 'utf8' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const OLD_SPAWN = `import { spawn } from 'node:child_process';
import path from 'node:path';
export function launch(appPath) {
  const dir = path.join(appPath, 'Contents', 'MacOS');
  return spawn(path.join(dir, 'x'), []);
}
`;

describe('check-no-direct-app-exec gate', () => {
  it('is red on the old launchApp shape (split join form)', () => {
    const res = runGate({ 'scripts/smoke.mjs': OLD_SPAWN });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('scripts/smoke.mjs:4');
  });
  it('is red on the literal form and on code-agent-tauri', () => {
    expect(runGate({ 'scripts/a.mjs': "import {execFileSync} from 'node:child_process';\nexecFileSync('/A.app/Contents/MacOS/foo');\n" }).status).toBe(1);
    expect(runGate({ 'scripts/b.sh': '#!/bin/bash\n"$APP/Contents/MacOS/code-agent-tauri" &\n' }).status).toBe(1);
  });
  it('is green for pgrep filters, comments, and allowlisted files', () => {
    expect(runGate({
      'scripts/ok.sh': '# Contents/MacOS note\npgrep -f "$APP/Contents/MacOS/"\n',
      'scripts/verify-browser-runtime.mjs': "import {spawn} from 'node:child_process';\nspawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');\n",
    }).status).toBe(0);
  });
  it('fails self-check when nothing is scanned', () => {
    expect(runGate({ 'README.md': 'x' }).status).toBe(1);
  });
});
