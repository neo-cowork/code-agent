#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ensureDist,
  reservePort,
  stopRun,
  waitForHealth,
  buildWebServerEnv,
} from './verify-slotless.mjs';

const STATE_FILE = '.neo-verify-state.json';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

function fail(message) {
  throw new Error(message);
}

function usage() {
  return [
    'Usage:',
    '  node scripts/verify-fresh-user.mjs <ticket> [--reuse-dist]',
    '  node scripts/verify-fresh-user.mjs --stop <NEO_VERIFY_DATA_DIR>',
    '',
    'Starts the worktree webServer with a brand-new empty data directory and no sign-in.',
  ].join('\n');
}

function sanitizeTicket(value) {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!sanitized) fail('ticket must contain at least one letter or digit');
  return sanitized.slice(0, 80);
}

function writePrivateJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function createFreshUserName() {
  // A per-run suffix prevents a previous fresh run's Keychain session from
  // turning the next run into an authenticated launch.
  return `fresh-${randomUUID().slice(0, 8)}`;
}

function resolveDevSlotOneBundleId() {
  // This script runs directly under Node, while devSlot.ts has extensionless
  // imports for the bundler. Read its single source-of-truth production id
  // and apply the documented slot-1 suffix instead of duplicating the id.
  const source = readFileSync(path.join(repoRoot, 'src/shared/devSlot.ts'), 'utf8');
  const match = source.match(/export const PROD_BUNDLE_ID = '([^']+)';/);
  if (!match) fail('src/shared/devSlot.ts is missing PROD_BUNDLE_ID');
  return `${match[1]}.dev`;
}

function signalChild(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function parseArgs(args) {
  let ticket;
  let reuseDist = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--reuse-dist') {
      reuseDist = true;
      continue;
    }
    if (arg.startsWith('--')) fail(`unknown option: ${arg}\n${usage()}`);
    if (ticket) fail(`unexpected argument: ${arg}\n${usage()}`);
    ticket = arg;
  }
  if (!ticket) fail(usage());
  return { ticket: sanitizeTicket(ticket), reuseDist };
}

async function startRun(ticketArg, reuseDist) {
  const ticket = sanitizeTicket(ticketArg);
  const webServer = ensureDist(reuseDist);
  const dataDir = mkdtempSync(path.join(os.tmpdir(), `neo-verify-${ticket}-`));
  const marker = path.basename(dataDir);
  const freshUser = createFreshUserName();
  let child;
  try {
    mkdirSync(path.join(dataDir, 'runtime-tmp'), { mode: 0o700 });
    const port = await reservePort();
    const url = `http://127.0.0.1:${port}`;
    const logPath = path.join(dataDir, 'webserver.log');
    const logFd = openSync(logPath, 'a', 0o600);
    const env = buildWebServerEnv({
      baseEnv: {
        ...process.env,
        CODE_AGENT_BUNDLE_ID: resolveDevSlotOneBundleId(),
        CODE_AGENT_FRESH_USER: freshUser,
      },
      dataDir,
      runtimeTmpDir: path.join(dataDir, 'runtime-tmp'),
      port,
    });
    try {
      child = spawn(process.execPath, [webServer, `--neo-verify-run=${marker}`], {
        cwd: dataDir,
        detached: true,
        env,
        stdio: ['ignore', logFd, logFd],
      });
    } finally {
      closeSync(logFd);
    }

    await waitForHealth(child, url);
    writePrivateJson(path.join(dataDir, STATE_FILE), {
      version: 1,
      ticket,
      marker,
      pid: child.pid,
      port,
      dataDir,
      repoRoot,
      freshUser,
      startedAt: new Date().toISOString(),
    });
    child.unref();
    console.log(`NEO_VERIFY_URL=${url}`);
    console.log(`NEO_VERIFY_DATA_DIR=${dataDir}`);
    console.log(`NEO_VERIFY_FRESH_USER=${freshUser}`);
  } catch (error) {
    signalChild(child, 'SIGTERM');
    if (dataDir && existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
}

async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    return;
  }
  if (args[0] === '--stop') {
    await stopRun(args[1]);
    return;
  }
  const { ticket, reuseDist } = parseArgs(args);
  await startRun(ticket, reuseDist);
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  main().catch((error) => {
    console.error(`verify-fresh-user: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
