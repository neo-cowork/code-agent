import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const scriptsDir = join(repoRoot, 'scripts');

const allowedProcessKills = [
  {
    file: 'tauri-install.sh',
    command: 'pkill -f "$INSTALLED_APP/Contents/MacOS/" 2>/dev/null || true',
    reason: 'FB-553：生产升级必须关闭当前生产 app，且路径锚点避免误伤 Dev 槽。',
  },
  {
    file: 'tauri-install.sh',
    command: 'pkill -f "$APPLICATIONS_DIR/$LEGACY_APP_NAME.app/Contents/MacOS/" 2>/dev/null || true',
    reason: 'FB-553：生产升级必须关闭旧命名的生产 app，且路径锚点避免误伤 Dev 槽。',
  },
];

describe('install script process-kill safety', () => {
  it('rejects unallowlisted pkill and killall commands in install-class scripts', () => {
    const scriptNames = readdirSync(scriptsDir)
      .filter((name) => name.includes('install') && name.endsWith('.sh'))
      .sort();
    const violations: string[] = [];
    const matchedAllowlist = new Set<string>();

    expect(scriptNames).toEqual(['install-mcp-server.sh', 'tauri-install-dev.sh', 'tauri-install.sh']);
    for (const name of scriptNames) {
      const lines = readFileSync(join(scriptsDir, name), 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (/^\s*#/.test(line) || !/\b(?:pkill|killall)\b/.test(line)) return;
        const command = line.trim();
        const allowed = allowedProcessKills.find((entry) => (
          entry.file === name && entry.command === command
        ));
        if (allowed) {
          expect(allowed.reason.length).toBeGreaterThan(0);
          matchedAllowlist.add(`${name}:${command}`);
        } else {
          violations.push(`scripts/${name}:${index + 1}: ${command}`);
        }
      });
    }

    expect(violations).toEqual([]);
    expect([...matchedAllowlist].sort()).toEqual(
      allowedProcessKills.map((entry) => `${entry.file}:${entry.command}`).sort(),
    );
  });
});
