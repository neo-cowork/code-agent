import { spawnSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { quote } from 'shell-quote';
import { describe, expect, it } from 'vitest';
import { wrapCommandForSandbox } from '../../../../src/host/sandbox/manager';
import { generateProfile, type SeatbeltConfig } from '../../../../src/host/sandbox/seatbelt';

function config(allowOfficeIpc: boolean): SeatbeltConfig {
  return {
    allowNetwork: false, allowOfficeIpc, readPaths: [], writePaths: [], executePaths: [],
    allowProcessExec: true, allowProcessFork: true, envPassthrough: [], customEnv: {}, sensitivePaths: [],
  };
}

describe('Seatbelt LibreOffice IPC exception', () => {
  it('is opt-in and grants exactly the current uid SingleOfficeIPC filename, local bind/inbound only', () => {
    const uid = process.getuid?.();
    const baseline = generateProfile(config(false));
    expect(baseline).not.toContain('OSL_PIPE_');
    const profile = generateProfile(config(true));
    const additions = profile.split('\n').filter((line) => !baseline.split('\n').includes(line));
    expect(additions).toEqual(uid === undefined ? [] : [
      `(allow network-bind network-inbound (local unix-socket (path-regex #"^/private/tmp/OSL_PIPE_${uid}_SingleOfficeIPC_[^/]+$")))`,
      `(allow file-write* (regex #"^/private/tmp/OSL_PIPE_${uid}_SingleOfficeIPC_[^/]+$"))`,
    ]);
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain('(deny file-write*)');
    if (uid !== undefined) expect(profile.indexOf('(allow file-write* (regex')).toBeGreaterThan(profile.indexOf('(deny file-write*)'));
  });
});

const sandboxReady = process.platform === 'darwin' && spawnSync('which', ['sandbox-exec']).status === 0;
describe.skipIf(!sandboxReady)('Seatbelt LibreOffice IPC real confinement', () => {
  it('allows its unix socket, denies other tmp writes/sockets, TCP, UDP and outbound IP', async () => {
    const deck = fs.mkdtempSync(path.join(os.tmpdir(), 'office-ipc-jail-'));
    const uid = process.getuid!();
    const allowed = `/private/tmp/OSL_PIPE_${uid}_SingleOfficeIPC_probe${process.pid}`;
    const other = `/private/tmp/other-office-probe-${process.pid}`;
    const foreign = `/private/tmp/OSL_PIPE_${uid + 1}_SingleOfficeIPC_probe${process.pid}`;
    const outside = net.createServer();
    await new Promise<void>((resolve) => outside.listen(0, '127.0.0.1', resolve));
    const address = outside.address();
    if (!address || typeof address === 'string') throw new Error('TCP probe server unavailable');
    const program = `
      const fs = require('fs'), net = require('net'), dgram = require('dgram');
      const probes = ${JSON.stringify({ allowed, other, foreign, port: address.port })};
      (async () => {
        try { fs.writeFileSync(probes.other, 'escape', {flag:'wx'}); console.log('tmp-write ALLOWED'); }
        catch(e) { console.log('tmp-write ' + e.code); }
        async function listen(label, options) {
          await new Promise(resolve => {
            const s = net.createServer();
            s.on('error', e => { console.log(label + ' ' + e.code); resolve(); });
            s.listen(options, () => { console.log(label + ' ALLOWED'); s.close(resolve); });
          });
        }
        await listen('office-socket', probes.allowed);
        await listen('other-socket', probes.other);
        await listen('foreign-uid-socket', probes.foreign);
        await listen('tcp-listener', {port:0, host:'127.0.0.1'});
        await new Promise(resolve => {
          const s = dgram.createSocket('udp4');
          s.on('error', e => { console.log('udp-listener ' + e.code); s.close(); resolve(); });
          s.bind(0, '127.0.0.1', () => { console.log('udp-listener ALLOWED'); s.close(resolve); });
        });
        await new Promise(resolve => {
          const s = net.connect(probes.port, '127.0.0.1');
          s.on('error', e => { console.log('outbound-ip ' + e.code); resolve(); });
          s.on('connect', () => { console.log('outbound-ip ALLOWED'); s.destroy(); resolve(); });
        });
      })().catch(e => { console.error(e); process.exitCode=1; });
    `;
    const wrapped = wrapCommandForSandbox(quote([process.execPath, '-e', program]), {
      workingDirectory: deck, allowNetwork: false,
    });
    try {
      const result = spawnSync('/bin/sh', ['-c', wrapped.command], { encoding: 'utf8', cwd: deck, timeout: 15_000 });
      console.log(result.stdout);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('office-socket ALLOWED');
      for (const label of ['tmp-write', 'other-socket', 'foreign-uid-socket', 'tcp-listener', 'udp-listener', 'outbound-ip']) {
        expect(result.stdout).toMatch(new RegExp(`${label} (?:EPERM|EACCES)`));
      }
      expect(fs.existsSync(other)).toBe(false);
    } finally {
      wrapped.cleanup();
      outside.close();
      for (const file of [allowed, other, foreign]) fs.rmSync(file, { force: true });
      fs.rmSync(deck, { recursive: true, force: true });
    }
  });
});
