import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const SMOKE_SCRIPT = path.resolve('scripts/desktop-shell-packaged-smoke.mjs');

function listenOnRandomPort(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to bind random TCP port'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function runSmokeCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-preflight-test-'));
  const dataDir = path.join(tmpRoot, 'data');
  const tauriDataDir = path.join(tmpRoot, 'tauri-data');
  try {
    return spawnSync(
      process.execPath,
      [
        SMOKE_SCRIPT,
        '--data-dir',
        dataDir,
        '--tauri-data-dir',
        tauriDataDir,
        ...args,
      ],
      {
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, ...env },
      },
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

describe('desktop-shell-packaged-smoke preflight port check', () => {
  it('(a) fails immediately with desktop_shell_port_in_use when the target port is already listening', async () => {
    const { server, port } = await listenOnRandomPort();
    try {
      const proc = runSmokeCli([
        '--app',
        '/nonexistent',
        '--port',
        String(port),
        '--app-port',
        String(port),
        '--health-only',
        '--json',
      ]);

      expect(proc.status).toBe(1);
      const combined = `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`;
      expect(combined).toContain('desktop_shell_port_in_use');
      expect(combined).toContain(String(port));
      expect(combined).not.toContain('desktop_shell_boot_json_missing');
      expect(combined).not.toContain('desktop_shell_health_missing');
      expect(combined).not.toContain('desktop_shell_boot_json_stale');

      const parsed = JSON.parse(proc.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.failures).toHaveLength(1);
      expect(parsed.failures[0].code).toBe('desktop_shell_port_in_use');
      expect(parsed.failures[0].message).toContain(String(port));
      expect(parsed.failures[0].message).toContain(String(process.pid));
      expect(parsed.failures[0].message).toMatch(/quit it first.*then re-run/i);
    } finally {
      await closeServer(server);
    }
  });

  it('(b) does not report desktop_shell_port_in_use when the port is free', async () => {
    const { server, port } = await listenOnRandomPort();
    await closeServer(server);

    const proc = runSmokeCli([
      '--app',
      '/nonexistent',
      '--port',
      String(port),
      '--app-port',
      String(port),
      '--health-only',
      '--json',
    ]);

    expect(proc.status).toBe(1);
    const combined = `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`;
    expect(combined).not.toContain('desktop_shell_port_in_use');
    expect(combined).toContain('desktop_shell_packaged_smoke_failed');
  });

  it('(c) skips the preflight port check when --skip-launch is passed', async () => {
    const { server, port } = await listenOnRandomPort();
    try {
      const proc = runSmokeCli([
        '--app',
        '/nonexistent',
        '--port',
        String(port),
        '--app-port',
        String(port),
        '--health-only',
        '--skip-launch',
        '--timeout-ms',
        '100',
        '--json',
      ]);

      const combined = `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`;
      expect(combined).not.toContain('desktop_shell_port_in_use');
    } finally {
      await closeServer(server);
    }
  });

  it('(d) resolves lsof from PATH so the preflight works on Linux', async () => {
    const { server, port } = await listenOnRandomPort();
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-preflight-lsof-'));
    const fakeLsof = path.join(fakeBin, 'lsof');
    fs.writeFileSync(
      fakeLsof,
      `#!/usr/bin/env node\nprocess.stdout.write('COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\\nportable-lsof-marker ${process.pid} test 1u IPv4 0 0 TCP 127.0.0.1:${port} (LISTEN)\\n');\n`,
      { mode: 0o755 },
    );
    try {
      const proc = runSmokeCli([
        '--app',
        '/nonexistent',
        '--port',
        String(port),
        '--app-port',
        String(port),
        '--health-only',
        '--json',
      ], {
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
      });

      expect(proc.status).toBe(1);
      const parsed = JSON.parse(proc.stdout);
      expect(parsed.failures[0].evidence.command).toBe('portable-lsof-marker');
    } finally {
      await closeServer(server);
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });
});
