import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyToolPath } from '../../../src/host/tools/utils/toolPathKind';
import { humanizeToolPath } from '../../../src/shared/utils/humanizeToolPath';

const UUID = '3ab3c0de-1111-4222-8333-444455556666';
const dataDir = path.join(os.tmpdir(), 'neo-pathkind-data');
const prevDataDir = process.env.CODE_AGENT_DATA_DIR;
process.env.CODE_AGENT_DATA_DIR = dataDir;
afterEach(() => { process.env.CODE_AGENT_DATA_DIR = dataDir; });

describe('classifyToolPath (real upload / temp roots only)', () => {
  it('real <dataDir>/uploads/<uuid>/ path is an upload with the sub-path', () => {
    const p = path.join(dataDir, 'uploads', UUID, 'x.xlsx');
    expect(classifyToolPath(p)).toEqual({ path: p, kind: 'upload', rest: 'x.xlsx' });
    expect(humanizeToolPath(p, 'zh', classifyToolPath(p))).toBe('你上传的文件：x.xlsx');
  });

  it('os.tmpdir() path is temp; /tmp is temp off Windows', () => {
    const p = path.join(os.tmpdir(), 'sales.csv');
    expect(classifyToolPath(p)).toEqual({ path: p, kind: 'temp', rest: 'sales.csv' });
    if (process.platform !== 'win32') expect(classifyToolPath('/tmp/a/b.txt')?.rest).toBe('a/b.txt');
  });

  it.runIf(process.platform === 'darwin')('/private/var alias of the tmpdir still matches', () => {
    expect(classifyToolPath(`/private${path.join(os.tmpdir(), 's.csv')}`)).toMatchObject({ kind: 'temp', rest: 's.csv' });
  });

  it.each([
    `/Users/x/project/uploads/${UUID}/avatar.png`,
    `/Users/x/code-agent-uploads/${UUID}/a.png`,
    `/Users/x/Library/uploads/${UUID}/a.png`,
    '/Users/x/project/tmp/a.png',
  ])('project path that only looks like an upload/temp stays unclassified: %s', (p) => {
    expect(classifyToolPath(p)).toBeUndefined();
    expect(humanizeToolPath(p, 'en')).toBe(p);
  });

  it('a path with .. is never classified, and the formatter also refuses a classification of one', () => {
    const p = `${dataDir}/uploads/${UUID}/../../../etc/hosts`;
    expect(classifyToolPath(p)).toBeUndefined();
    const forged = { path: '/tmp/../etc/passwd', kind: 'temp' as const, rest: 'passwd' };
    expect(humanizeToolPath('/tmp/../etc/passwd', 'en', forged)).toBe('/tmp/../etc/passwd');
  });

  it('formatter ignores a classification for a different path', () => {
    expect(humanizeToolPath('/a/b.txt', 'en', { path: '/tmp/x', kind: 'temp', rest: 'x' })).toBe('/a/b.txt');
  });
});

process.on('exit', () => { if (prevDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR; else process.env.CODE_AGENT_DATA_DIR = prevDataDir; });
