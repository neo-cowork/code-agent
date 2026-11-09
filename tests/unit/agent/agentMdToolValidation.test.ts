// ============================================================================
// agent.md 启动期工具名校验（D-SDK-2）
// 写错工具名此前静默丢弃，现在加载时点名报错。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const { errorSpy, debugSpy, warnSpy, infoSpy } = vi.hoisted(() => ({
  errorSpy: vi.fn(), debugSpy: vi.fn(), warnSpy: vi.fn(), infoSpy: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    error: errorSpy,
    debug: debugSpy,
    warn: warnSpy,
    info: infoSpy,
  }),
}));

import { loadAgentMdFiles } from '../../../src/host/agent/hybrid/agentMdLoader';
import {
  describeUnknownTools,
  findUnknownToolNames,
  getKnownToolNames,
  hasProtocolToolRegistry,
} from '../../../src/host/tools/knownToolNames';
// 触发 protocolRegistry 的模块副作用，让 getProtocolToolSchemas() 拿到真实注册表
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import * as protocolRegistration from '../../../src/host/tools/protocolToolRegistration';

function agentMd(name: string, tools: string[]): string {
  return ['---', `name: ${name}`, 'tools:', ...tools.map((tool) => `  - ${tool}`), '---', 'body'].join('\n');
}

let dir = '';

beforeEach(async () => {
  errorSpy.mockClear();
  debugSpy.mockClear();
  warnSpy.mockClear();
  infoSpy.mockClear();
  getProtocolRegistry();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmd-tools-'));
});

afterEach(async () => {
  await fs.chmod(dir, 0o700);
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('findUnknownToolNames', () => {
  it('放过注册表里存在的名字', () => {
    expect(findUnknownToolNames(['Read', 'Bash'], new Set(['Read', 'Bash']))).toEqual([]);
  });

  it('挑出不存在的名字，并给出大小写/下划线写法的近似建议', () => {
    const unknown = findUnknownToolNames(['read_TOOL', 'Nonexistent'], new Set(['ReadTool', 'Bash']));
    expect(unknown).toEqual([
      { name: 'read_TOOL', suggestion: 'ReadTool' },
      { name: 'Nonexistent' },
    ]);
  });
});

describe('describeUnknownTools', () => {
  it('点名专家和工具名，并带上建议', () => {
    const message = describeUnknownTools('数据分析师', [{ name: 'Redd', suggestion: 'Read' }, { name: 'Xyz' }]);
    expect(message).toContain('数据分析师');
    expect(message).toContain('Redd');
    expect(message).toContain('Read');
    expect(message).toContain('Xyz');
  });
});

describe('loadAgentMdFiles 工具名校验', () => {
  it('注册表就绪时，工具名写错的专家在加载时被点名警告一次', async () => {
    expect(hasProtocolToolRegistry()).toBe(true);
    await fs.writeFile(path.join(dir, 'typo.md'), agentMd('typo-expert', ['Read', 'Bashh']));

    const agents = await loadAgentMdFiles(dir);

    // 仍然加载出来（不阻断），但必须留下点名记录
    expect(agents).toHaveLength(1);
    await loadAgentMdFiles(dir);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message, context] = warnSpy.mock.calls[0] as [string, { unknownTools: string[] }];
    expect(message).toContain('typo-expert');
    expect(message).toContain('Bashh');
    expect(context.unknownTools).toEqual(['Bashh']);
  });

  it('工具名全对的专家零影响', async () => {
    await fs.writeFile(path.join(dir, 'ok.md'), agentMd('ok-expert', ['Read', 'Bash', 'Glob']));

    const agents = await loadAgentMdFiles(dir);

    expect(agents).toHaveLength(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('没写 tools 字段时走默认 6 件集，且默认集本身全部有效', async () => {
    await fs.writeFile(path.join(dir, 'plain.md'), ['---', 'name: plain-expert', '---', 'body'].join('\n'));

    const agents = await loadAgentMdFiles(dir);

    expect(agents[0].tools).toEqual(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']);
    expect(findUnknownToolNames(agents[0].tools, getKnownToolNames())).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('loadAgentMdFiles legacy calendar migration', () => {
  const fixtures = path.join(import.meta.dirname, 'fixtures/legacy-calendar');

  it.each(['日历助理RR21', '日历助理RR21B', '日程管家'])('migrates real legacy fixture %s, backs up original, and is idempotent', async (role) => {
    const original = await fs.readFile(path.join(fixtures, `${role}.md`), 'utf-8');
    const file = path.join(dir, `${role}.md`);
    await fs.writeFile(file, original);
    const agents = await loadAgentMdFiles(dir);
    const expected = role === '日历助理RR21' ? ['calendar']
      : role === '日历助理RR21B' ? ['calendar', 'tmeetMeetingList', 'MemoryRead', 'MemoryWrite']
        : ['calendar', 'MemoryRead', 'MemoryWrite', 'Read', 'Write'];
    expect(agents[0].tools).toEqual(expected);
    const rewritten = await fs.readFile(file, 'utf-8');
    expect(rewritten).toBe(original.replace(/^tools:.*$/m, `tools:\n${expected.map((tool) => `  - ${tool}`).join('\n')}`));
    const entries = await fs.readdir(dir);
    const backups = entries.filter((name) => /\.md\.bak-\d{8}$/.test(name));
    expect(backups).toHaveLength(1);
    expect(await fs.readFile(path.join(dir, backups[0]), 'utf-8')).toBe(original);
    expect((await fs.stat(path.join(dir, backups[0]))).mode & 0o777).toBe(0o600);
    expect(await loadAgentMdFiles(dir)).toHaveLength(1);
    expect(await fs.readFile(file, 'utf-8')).toBe(rewritten);
    expect(await fs.readdir(dir)).toEqual(entries);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0][0]).toContain(`migrated: ${role}:`);
    expect(infoSpy.mock.calls[0][0]).toContain('-> calendar');
    console.log(`migration proof ${role}: tools=${JSON.stringify(agents[0].tools)}; backup equals original; second load unchanged; ERROR=0 WARN=0 INFO=1`);
    console.log(rewritten);
    console.log(`directory entries after second load: ${entries.join(', ')}`);
  });

  it('deduplicates both legacy names and an existing calendar without changing other bytes (CRLF)', async () => {
    const original = '---\r\nname: duplicate\r\ncustom: keep  \r\ntools:\r\n  - tmeetCalendarList\r\n  - tmeetCalendarRead\r\n  - calendar\r\n  - Read\r\n\r\nmodel: fast\r\n---\r\n\r\n日程管家 body  \r\n';
    const file = path.join(dir, 'duplicate.md');
    await fs.writeFile(file, original);
    expect((await loadAgentMdFiles(dir))[0].tools).toEqual(['calendar', 'Read']);
    expect(await fs.readFile(file, 'utf-8')).toBe(original.replace('  - tmeetCalendarList\r\n  - tmeetCalendarRead\r\n', ''));
  });

  it('keeps unmappable fooBar untouched and warns exactly once across two loads', async () => {
    const file = path.join(dir, 'unknown.md');
    const original = agentMd('unknown-expert', ['fooBar']);
    await fs.writeFile(file, original);
    expect((await loadAgentMdFiles(dir))[0].tools).toEqual(['fooBar']);
    await loadAgentMdFiles(dir);
    expect(await fs.readFile(file, 'utf-8')).toBe(original);
    expect(await fs.readdir(dir)).toEqual(['unknown.md']);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toBe(describeUnknownTools('unknown-expert', [{ name: 'fooBar' }]));
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    console.log('unmappable fooBar: file unchanged; two loads; WARN=1 ERROR=0 INFO=0');
  });

  it('migrates without a ready registry and preserves an existing same-day backup', async () => {
    const original = agentMd('early', ['tmeetCalendarRead']);
    const file = path.join(dir, 'early.md');
    const backup = `${file}.bak-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
    await fs.writeFile(file, original);
    await fs.writeFile(backup, 'earlier original');
    vi.spyOn(protocolRegistration, 'getProtocolToolSchemas').mockReturnValue([]);
    expect((await loadAgentMdFiles(dir))[0].tools).toEqual(['calendar']);
    expect(await fs.readFile(backup, 'utf-8')).toBe('earlier original');
    expect(debugSpy).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('retains the backup on a file write failure and reports in-memory migration only once', async () => {
    const original = agentMd('locked-file', ['tmeetCalendarList']);
    const file = path.join(dir, 'locked.md');
    await fs.writeFile(file, original, { mode: 0o400 });
    try {
      expect((await loadAgentMdFiles(dir))[0].tools).toEqual(['calendar']);
      expect((await loadAgentMdFiles(dir))[0].tools).toEqual(['calendar']);
      const backups = (await fs.readdir(dir)).filter((name) => name.includes('.bak-'));
      expect(backups).toHaveLength(1);
      expect(await fs.readFile(path.join(dir, backups[0]), 'utf-8')).toBe(original);
      expect(await fs.readFile(file, 'utf-8')).toBe(original);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      await fs.chmod(file, 0o600);
    }
  });

  it('keys warnings by file plus sorted unknown names, independent of declaration order', async () => {
    const file = path.join(dir, 'sorted.md');
    await fs.writeFile(file, agentMd('sorted', ['fooBar', 'bazBar']));
    await loadAgentMdFiles(dir);
    await fs.writeFile(file, agentMd('sorted', ['bazBar', 'fooBar', 'fooBar']));
    await loadAgentMdFiles(dir);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    await fs.writeFile(file, agentMd('sorted', ['anotherUnknown']));
    await loadAgentMdFiles(dir);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    await fs.writeFile(path.join(dir, 'other.md'), agentMd('sorted', ['anotherUnknown']));
    await loadAgentMdFiles(dir);
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('read-only directory warns with reason and still returns the in-memory migration', async () => {
    const original = await fs.readFile(path.join(fixtures, '日历助理RR21.md'), 'utf-8');
    const file = path.join(dir, 'readonly.md');
    await fs.writeFile(file, original);
    await fs.chmod(dir, 0o500);
    try {
      expect((await loadAgentMdFiles(dir))[0].tools).toEqual(['calendar']);
      expect(await fs.readFile(file, 'utf-8')).toBe(original);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][1].reason).toMatch(/EACCES|EPERM|permission denied/i);
      expect(errorSpy).not.toHaveBeenCalled();
      console.log(`read-only migration: tools=[calendar]; WARN=1 ERROR=0 reason=${warnSpy.mock.calls[0][1].reason}`);
    } finally {
      await fs.chmod(dir, 0o700);
    }
  });
});
