import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Copy model settings and selectively read model keys, never a login store. */
export async function seedVerificationModels(sourceDir: string, targetDir: string): Promise<void> {
  const source = JSON.parse(readFileSync(path.join(sourceDir, 'config.json'), 'utf8'));
  const { readModelCredentialsFromDataDir } = await import('../../src/host/services/core/secureStorage.ts');
  const credentials = readModelCredentialsFromDataDir(sourceDir);
  const models = source.models ?? {};
  for (const [key, value] of Object.entries(credentials)) {
    if (!key.startsWith('apikey.')) continue;
    const provider = models.providers?.[key.slice('apikey.'.length)];
    if (provider) provider.apiKey = value;
  }
  writeFileSync(path.join(targetDir, 'config.json'), JSON.stringify({
    models, cloud: { enabled: false, warmupOnInit: false }, connectors: { enabledNative: [] },
  }), { mode: 0o600 });
}
