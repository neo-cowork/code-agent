import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('ConfigService webServer watcher wiring', () => {
  it('starts after initialization and stops during shutdown before database close', () => {
    const source = readFileSync(join(process.cwd(), 'src/web/webServer.ts'), 'utf8');
    const initialized = source.indexOf('await configService.initialize()');
    const started = source.indexOf('configService.startWatchingConfigFile()', initialized);
    const shutdown = source.indexOf('const shutdown = async');
    const stopped = source.indexOf('configService.stopWatchingConfigFile()', shutdown);
    const databaseClosed = source.indexOf('closeAllDatabaseConnections()', stopped);

    expect(initialized).toBeGreaterThanOrEqual(0);
    expect(started).toBeGreaterThan(initialized);
    expect(shutdown).toBeGreaterThan(started);
    expect(stopped).toBeGreaterThan(shutdown);
    expect(databaseClosed).toBeGreaterThan(stopped);
  });
});
