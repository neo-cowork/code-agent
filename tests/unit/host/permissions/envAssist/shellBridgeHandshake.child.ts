// Child fixture for shellBridgeHandshake.test.ts: runs the real capture logic with stdin handshake.
import {
  captureShellBridgeEnv,
  resolveShellBridgeClientFromEnv,
} from '../../../../../src/host/permissions/envAssist/shellBridge/client';

captureShellBridgeEnv();
const client = resolveShellBridgeClientFromEnv();
const secretProbe = process.argv[2] ?? '';
const envLeak = Object.values(process.env).some((v) => secretProbe && v?.includes(secretProbe));
const allRoutes = process.argv.includes('--all-routes');
const httpOutcomes: Array<{ path: string; status: number }> = [];
if (allRoutes) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await realFetch(...args);
    const path = new URL(String(args[0])).pathname;
    httpOutcomes.push({ path, status: response.status });
    return response;
  };
}
let postOk = false;
if (client) {
  try {
    await client.post('/v1/passive/accessibility');
    if (allRoutes) {
      for (const route of ['screen', 'input', 'automation']) {
        await client.post(`/v1/passive/${route}`, route === 'automation' ? { targetBundleId: 'com.apple.iCal' } : {});
      }
      for (const route of ['accessibility', 'screen', 'input', 'automation']) {
        await client.post(`/v1/grant/${route}`, route === 'automation' ? { targetBundleId: 'com.apple.iCal' } : {});
      }
    }
    postOk = true;
  } catch {
    postOk = false;
  }
}
process.stdout.write(`RESULT ${JSON.stringify({ hasClient: client !== null, envLeak, postOk })}\n`);
if (allRoutes) process.stdout.write(`HTTP ${JSON.stringify(httpOutcomes)}\n`);
if (!allRoutes) {
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
}
