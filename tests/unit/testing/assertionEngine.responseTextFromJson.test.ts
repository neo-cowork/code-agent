import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { runExpectations } from '../../../src/host/testing/assertionEngine';
import type { Expectation } from '../../../src/host/testing/types';

let workingDirectory = '';

beforeAll(async () => {
  workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'response-text-from-json-'));
  await fs.writeFile(
    path.join(workingDirectory, 'package.json'),
    JSON.stringify({ name: 'code-agent', version: '0.33.0', private: true, revision: 7 }),
  );
});

afterAll(async () => {
  await fs.rm(workingDirectory, { recursive: true, force: true });
});

async function evaluate(params: Record<string, unknown>, response: string) {
  const expectation: Expectation = {
    type: 'response_contains',
    description: 'reply states the expected text',
    weight: 0.8,
    params,
  };
  const result = await runExpectations([expectation], {
    toolExecutions: [],
    responses: [response],
    errors: [],
    turnCount: 1,
    workingDirectory,
  });
  return result.results[0];
}

describe('response_contains text_from_json', () => {
  const versionFromPackage = { text_from_json: { path: 'package.json', field: 'version' } };

  it('passes when the response states the version found in the tested package', async () => {
    const result = await evaluate(versionFromPackage, 'name: `code-agent`, version: `0.33.0`');
    expect(result.passed).toBe(true);
    expect(result.evidence.expected).toBe('response contains ["0.33.0"]');
  });

  it('fails when the response states a version other than the tested package version', async () => {
    const result = await evaluate(versionFromPackage, 'name: code-agent, version: 0.16.0');
    expect(result.passed).toBe(false);
    expect(result.evidence.actual).toBe('name: code-agent, version: 0.16.0');
  });

  it('reads numeric fields as text', async () => {
    const result = await evaluate({ text_from_json: { path: 'package.json', field: 'revision' } }, 'revision 7');
    expect(result.passed).toBe(true);
  });

  it('fails with the reason when the file is missing', async () => {
    const result = await evaluate({ text_from_json: { path: 'missing.json', field: 'version' } }, '0.33.0');
    expect(result.passed).toBe(false);
    expect(String(result.evidence.actual)).toContain('ENOENT');
  });

  it('fails with the reason when the field is not a string or number', async () => {
    const result = await evaluate({ text_from_json: { path: 'package.json', field: 'private' } }, 'true');
    expect(result.passed).toBe(false);
    expect(String(result.evidence.actual)).toContain('is not a non-empty string or number');
  });

  it('fails with the reason when the path leaves the working directory', async () => {
    const result = await evaluate({ text_from_json: { path: '../package.json', field: 'version' } }, '0.33.0');
    expect(result.passed).toBe(false);
    expect(String(result.evidence.actual)).toContain('escapes the working directory');
  });

  it('fails with the reason when path or field is absent', async () => {
    const result = await evaluate({ text_from_json: { path: 'package.json' } }, '0.33.0');
    expect(result.passed).toBe(false);
    expect(String(result.evidence.actual)).toContain('requires non-empty string');
  });

  it('keeps literal text and alternation behaviour unchanged', async () => {
    expect((await evaluate({ text: 'code-agent' }, 'name: code-agent')).passed).toBe(true);
    expect((await evaluate({ text: '版本|version' }, 'version 1')).passed).toBe(true);
    expect((await evaluate({ text: '0.16' }, 'version 0.33.0')).passed).toBe(false);
  });
});
