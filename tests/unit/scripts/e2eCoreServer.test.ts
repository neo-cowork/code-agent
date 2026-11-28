import { describe, expect, it, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ensureServerAlive, quiesceServer } from '../../../scripts/e2e-core/server';
import type { DbSnapshot, ServerInfo } from '../../../scripts/e2e-core/types';

function reserveClosedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

describe('ensureServerAlive (hung server recovery)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) {
      try {
        cleanups.pop()?.();
      } catch {
        /* ignore */
      }
    }
  });

  it('kills a live unresponsive pid via kill9 before restarting and returns a hang reason', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-core-server-test-'));
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    // Spawn a real live child process that does NOT serve /api/health (simulates hung server)
    const hungChild: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000);'], {
      detached: true,
      stdio: 'ignore',
    });
    const hungPid = hungChild.pid!;
    cleanups.push(() => {
      try {
        process.kill(-hungPid, 'SIGKILL');
      } catch {
        /* already dead */
      }
    });

    const serverDir = path.join(tmpDir, 'server-test');
    fs.mkdirSync(serverDir, { recursive: true });
    const stateFile = path.join(serverDir, 'state.json');
    const port = await reserveClosedPort();
    fs.writeFileSync(stateFile, JSON.stringify({ pid: hungPid, port }));

    const callsLog = path.join(tmpDir, 'calls.log');
    const fakeBin = path.join(tmpDir, 'fake-neo-realrun.mjs');
    fs.writeFileSync(
      fakeBin,
      `
import fs from 'node:fs';
import path from 'node:path';

const [cmd, ...rest] = process.argv.slice(2);
const outIdx = rest.indexOf('--out');
const outDir = outIdx >= 0 ? rest[outIdx + 1] : '';
const statePath = path.join(outDir, 'state.json');
fs.appendFileSync(${JSON.stringify(callsLog)}, cmd + '\\n');

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
if (cmd === 'kill9') {
  try { process.kill(-state.pid, 'SIGKILL'); } catch {}
  for (let i = 0; i < 40; i++) {
    try { process.kill(state.pid, 0); } catch { break; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  console.log('kill9 pgid=' + state.pid);
  process.exit(0);
}
if (cmd === 'restart') {
  let stillAlive = true;
  try { process.kill(state.pid, 0); } catch { stillAlive = false; }
  if (stillAlive) {
    console.error('neo-realrun: pid ' + state.pid + ' 还活着，先 stop 或 kill9');
    process.exit(1);
  }
  console.log('started pid=99999 port=' + state.port);
  process.exit(0);
}
process.exit(2);
`,
      'utf8',
    );

    const server: ServerInfo = {
      port,
      token: 'test-token',
      home: tmpDir,
      dataDir: tmpDir,
      workspace: tmpDir,
      dir: serverDir,
      model: 'test-model',
    };

    const reason = await ensureServerAlive(fakeBin, server);
    expect(reason).not.toBeNull();
    expect(reason).toContain('卡死');
    expect(reason).toContain(String(hungPid));
    expect(reason).toContain('kill9 + restart');

    const calls = fs.readFileSync(callsLog, 'utf8').trim().split('\n');
    expect(calls).toEqual(['kill9', 'restart']);

    let childStillAlive = true;
    try {
      process.kill(hungPid, 0);
    } catch {
      childStillAlive = false;
    }
    expect(childStillAlive).toBe(false);
  });
});

function emptySnapshot(overrides: Partial<DbSnapshot> = {}): DbSnapshot {
  return {
    sessions: [],
    messages: [],
    toolEvents: [],
    pendingApprovals: [],
    permissionDecisions: [],
    cronJobs: [],
    cronExecutions: [],
    ...overrides,
  };
}

describe('quiesceServer (parked approvals, running cron executions, and cancel logging)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanups.length) {
      try {
        await cleanups.pop()?.();
      } catch {
        /* ignore */
      }
    }
  });

  async function setupQuiesceHarness(options: {
    snapshots: DbSnapshot[];
    onCancel?: (body: Record<string, unknown>, req: http.IncomingMessage, res: http.ServerResponse) => void;
  }): Promise<{
    fakeBin: string;
    server: ServerInfo;
    cancelBodies: Array<Record<string, unknown>>;
    readCalls: () => string[];
  }> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-core-quiesce-test-'));
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const serverDir = path.join(tmpDir, 'server-test');
    fs.mkdirSync(serverDir, { recursive: true });

    const cancelBodies: Array<Record<string, unknown>> = [];
    const httpServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/cancel') {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => {
          raw += chunk;
        });
        req.on('end', () => {
          const parsed = JSON.parse(raw || '{}') as Record<string, unknown>;
          cancelBodies.push(parsed);
          if (options.onCancel) {
            options.onCancel(parsed, req, res);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Cancelled', sessionId: parsed.sessionId }));
        });
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });

    const port = await new Promise<number>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => {
        const addr = httpServer.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
        }),
    );

    fs.writeFileSync(path.join(serverDir, 'state.json'), JSON.stringify({ pid: process.pid, port }));

    const snapshotsFile = path.join(tmpDir, 'snapshots.json');
    fs.writeFileSync(snapshotsFile, JSON.stringify(options.snapshots), 'utf8');
    const seqFile = path.join(tmpDir, 'seq.txt');
    fs.writeFileSync(seqFile, '0', 'utf8');
    const callsLog = path.join(tmpDir, 'calls.log');

    const fakeBin = path.join(tmpDir, 'fake-neo-realrun.mjs');
    fs.writeFileSync(
      fakeBin,
      `
import fs from 'node:fs';
import path from 'node:path';

const [cmd, ...rest] = process.argv.slice(2);
const outIdx = rest.indexOf('--out');
const outDir = outIdx >= 0 ? rest[outIdx + 1] : '';
fs.appendFileSync(${JSON.stringify(callsLog)}, cmd + '\\n');

if (cmd === 'dump') {
  const snapshots = JSON.parse(fs.readFileSync(${JSON.stringify(snapshotsFile)}, 'utf8'));
  const idx = Number(fs.readFileSync(${JSON.stringify(seqFile)}, 'utf8').trim() || '0');
  fs.writeFileSync(${JSON.stringify(seqFile)}, String(idx + 1), 'utf8');
  const snap = snapshots[Math.min(idx, snapshots.length - 1)];
  const snapFile = path.join(outDir, 'db-' + (idx + 1) + '.json');
  fs.writeFileSync(snapFile, JSON.stringify(snap, null, 2) + '\\n', 'utf8');
  console.log('db snapshot ' + snapFile + ': sessions=' + snap.sessions.length);
  process.exit(0);
}
if (cmd === 'kill9' || cmd === 'restart') {
  console.log(cmd + ' ok');
  process.exit(0);
}
process.exit(2);
`,
      'utf8',
    );

    const server: ServerInfo = {
      port,
      token: 'test-token',
      home: tmpDir,
      dataDir: tmpDir,
      workspace: tmpDir,
      dir: serverDir,
      model: 'test-model',
    };

    return {
      fakeBin,
      server,
      cancelBodies,
      readCalls: () =>
        fs.existsSync(callsLog)
          ? fs.readFileSync(callsLog, 'utf8').trim().split('\n').filter(Boolean)
          : [],
    };
  }

  it(
    'cancels a scheduled session parked on launch approval (via payload_json) and a running cron_executions session without kill9/restart',
    async () => {
      const warnSpy = vi.spyOn(console, 'warn');
      const busySnap = emptySnapshot({
        sessions: [{ id: 'sess-scheduled-parked', status: 'idle' }],
        pendingApprovals: [
          {
            id: 'launch-approval-1',
            kind: 'launch',
            status: 'pending',
            coordinator_id: null,
            payload_json: JSON.stringify({ sessionId: 'sess-scheduled-parked', kind: 'launch' }),
          },
        ],
        cronExecutions: [
          {
            id: 'cron-exec-1',
            job_id: 'job-weekly',
            session_id: 'sess-cron-running',
            status: 'running',
          },
        ],
      });
      const idleSnap = emptySnapshot({
        sessions: [{ id: 'sess-scheduled-parked', status: 'idle' }],
        pendingApprovals: [
          {
            id: 'launch-approval-1',
            kind: 'launch',
            status: 'rejected',
            coordinator_id: null,
            payload_json: JSON.stringify({ sessionId: 'sess-scheduled-parked', kind: 'launch' }),
          },
        ],
        cronExecutions: [
          {
            id: 'cron-exec-1',
            job_id: 'job-weekly',
            session_id: 'sess-cron-running',
            status: 'failed',
          },
        ],
      });

      const { fakeBin, server, cancelBodies, readCalls } = await setupQuiesceHarness({
        snapshots: [busySnap, idleSnap],
        onCancel: (body, _req, res) => {
          const status = body.sessionId === 'sess-cron-running' ? 202 : 200;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: status === 202 ? 'cancel_requested' : 'Cancelled' }));
        },
      });

      const reason = await quiesceServer(fakeBin, server);
      expect(reason).toBeNull();
      expect(cancelBodies).toEqual([
        { sessionId: 'sess-scheduled-parked', abandonParked: true },
        { sessionId: 'sess-cron-running', abandonParked: true },
      ]);
      expect(readCalls()).toEqual(['dump', 'dump']);
      expect(warnSpy).not.toHaveBeenCalled();
    },
    15_000,
  );

  it(
    'resolves argsRef.sessionId and coordinator_id fallbacks, deduplicates, and skips unparseable or id-less rows',
    async () => {
      const busySnap = emptySnapshot({
        sessions: [
          { id: 'sess-running', status: 'running' },
          { id: '', status: 'running' },
        ],
        pendingApprovals: [
          {
            id: 'pa-argsref',
            kind: 'tool_approval',
            status: 'pending',
            coordinator_id: null,
            payload_json: JSON.stringify({ argsRef: { sessionId: 'sess-from-argsref' } }),
          },
          {
            id: 'pa-coord',
            kind: 'launch',
            status: 'pending',
            coordinator_id: 'sess-from-coordinator',
            payload_json: JSON.stringify({ tool: 'spawn_team' }),
          },
          {
            id: 'pa-duplicate',
            kind: 'tool_approval',
            status: 'pending',
            coordinator_id: null,
            payload_json: JSON.stringify({ sessionId: 'sess-running' }),
          },
          {
            id: 'pa-corrupt',
            kind: 'tool_approval',
            status: 'pending',
            coordinator_id: 'sess-must-skip-corrupt-json',
            payload_json: '{bad-json',
          },
          {
            id: 'pa-pairing-no-id',
            kind: 'channel_pairing',
            status: 'pending',
            coordinator_id: null,
            payload_json: JSON.stringify({ senderId: 'u1' }),
          },
        ],
        cronExecutions: [
          { id: 'exec-empty', job_id: 'job-1', session_id: null, status: 'running' },
          { id: 'exec-undef-str', job_id: 'job-1', session_id: 'undefined', status: 'running' },
          { id: 'exec-done', job_id: 'job-1', session_id: 'sess-already-done', status: 'completed' },
        ],
      });
      const idleSnap = emptySnapshot();

      const { fakeBin, server, cancelBodies } = await setupQuiesceHarness({
        snapshots: [busySnap, idleSnap],
      });

      const reason = await quiesceServer(fakeBin, server);
      expect(reason).toBeNull();
      expect(cancelBodies).toEqual([
        { sessionId: 'sess-running', abandonParked: true },
        { sessionId: 'sess-from-argsref', abandonParked: true },
        { sessionId: 'sess-from-coordinator', abandonParked: true },
      ]);
    },
    15_000,
  );

  it(
    'logs session id, status, and body preview when /api/cancel returns 500 or throws, while continuing to remaining sessions',
    async () => {
      const warnSpy = vi.spyOn(console, 'warn');
      const longTail = 'x'.repeat(240);
      const busySnap = emptySnapshot({
        pendingApprovals: [
          {
            id: 'pa-500',
            kind: 'launch',
            status: 'pending',
            payload_json: JSON.stringify({ sessionId: 'sess-cancel-500' }),
          },
          {
            id: 'pa-throw',
            kind: 'launch',
            status: 'pending',
            payload_json: JSON.stringify({ sessionId: 'sess-cancel-throw' }),
          },
        ],
        cronExecutions: [
          { id: 'exec-next', job_id: 'job-1', session_id: 'sess-cancel-next', status: 'running' },
        ],
      });
      const idleSnap = emptySnapshot();

      const { fakeBin, server, cancelBodies } = await setupQuiesceHarness({
        snapshots: [busySnap, idleSnap],
        onCancel: (body, req, res) => {
          if (body.sessionId === 'sess-cancel-500') {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(`internal_cancel_failure\n${longTail}`);
            return;
          }
          if (body.sessionId === 'sess-cancel-throw') {
            req.socket.destroy();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Cancelled' }));
        },
      });

      const reason = await quiesceServer(fakeBin, server);
      expect(reason).toBeNull();
      expect(cancelBodies.map((b) => b.sessionId)).toEqual([
        'sess-cancel-500',
        'sess-cancel-throw',
        'sess-cancel-next',
      ]);

      const loggedLines = warnSpy.mock.calls.map((args) => args.map(String).join(' '));
      expect(loggedLines).toHaveLength(2);
      expect(loggedLines[0]).toContain('sess-cancel-500');
      expect(loggedLines[0]).toContain('500');
      expect(loggedLines[0]).toContain('internal_cancel_failure');
      expect(loggedLines[0]).not.toContain('\n');
      expect(loggedLines[0].length).toBeLessThan(280);
      expect(loggedLines[1]).toContain('sess-cancel-throw');
      expect(loggedLines[1]).not.toContain('\n');
    },
    15_000,
  );
});
