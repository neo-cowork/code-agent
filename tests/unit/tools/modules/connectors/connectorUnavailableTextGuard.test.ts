import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CONNECTORS_DIR = join(process.cwd(), 'src/host/tools/modules/connectors');

describe('connector missing text guard', () => {
  it('no connector tool source hand-writes "connector is not available"', () => {
    const files = readdirSync(CONNECTORS_DIR).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((f) =>
      /connector is not available/i.test(readFileSync(join(CONNECTORS_DIR, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
