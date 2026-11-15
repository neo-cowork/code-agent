// Child fixture for shellBridgeHandshake.test.ts: runs the real capture logic with stdin handshake.
import {
  captureShellBridgeEnv,
  resolveShellBridgeClientFromEnv,
} from '../../../../../src/host/permissions/envAssist/shellBridge/client';

captureShellBridgeEnv();
const client = resolveShellBridgeClientFromEnv();
const secretProbe = process.argv[2] ?? '';
const envLeak = Object.values(process.env).some((v) => secretProbe && v?.includes(secretProbe));
let postOk = false;
if (client) {
  try {
    await client.post('/v1/passive/accessibility');
    postOk = true;
  } catch {
    postOk = false;
  }
}
process.stdout.write(`RESULT ${JSON.stringify({ hasClient: client !== null, envLeak, postOk })}\n`);
let rest = '';
process.stdin.on('data', (chunk) => {
  rest += chunk.toString();
  if (rest.includes('\n')) {
    process.stdout.write(`REST ${JSON.stringify(rest)}\n`);
    process.stdin.pause();
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
