import * as fs from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSkillWatcher,
  resetSkillWatcher,
} from '../../../../src/host/services/skills/skillWatcher';

describe('SkillWatcher project switch never closes an FSWatcher', () => {
  let tempHome: string;
  let priorEnv: { CODE_AGENT_HOME?: string; CODE_AGENT_DATA_DIR?: string };

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'skill-watcher-switch-'));
    priorEnv = {
      CODE_AGENT_HOME: process.env.CODE_AGENT_HOME,
      CODE_AGENT_DATA_DIR: process.env.CODE_AGENT_DATA_DIR,
    };
    process.env.CODE_AGENT_HOME = tempHome;
    process.env.CODE_AGENT_DATA_DIR = path.join(tempHome, 'nested', '.code-agent');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetSkillWatcher();
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  it('10 alternating A/B switches make 0 FSWatcher.close calls and B still reloads on a new SKILL.md', async () => {
    const dirA = path.join(tempHome, 'task-A');
    const dirB = path.join(tempHome, 'task-B');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });

    const watcher = getSkillWatcher();
    await watcher.initialize(dirA);

    // node 24 不导出 fs.FSWatcher：从一个探针 watcher 取真实原型（与 recursive watcher 同一个）
    const probe = fs.watch(tempHome);
    const closeSpy = vi.spyOn(Object.getPrototypeOf(probe) as { close(): void }, 'close');
    probe.close();
    closeSpy.mockClear();
    for (let i = 0; i < 10; i++) {
      await watcher.updateProjectDirectory(i % 2 === 0 ? dirB : dirA);
    }
    await watcher.updateProjectDirectory(dirB);
    expect(closeSpy.mock.calls.length).toBe(0);

    const reloaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no skills reload after switching to B')), 8000);
      watcher.once('reloaded', () => { clearTimeout(timer); resolve(); });
    });
    await mkdir(path.join(dirB, '.code-agent', 'skills', 'later'), { recursive: true });
    await writeFile(path.join(dirB, '.code-agent', 'skills', 'later', 'SKILL.md'), '---\nname: later\n---\n');
    await reloaded;
    expect(closeSpy.mock.calls.length).toBe(0);
  });

  it('does not poll the old project after a switch and never creates project dirs', async () => {
    const dirA = path.join(tempHome, 'task-A');
    const dirB = path.join(tempHome, 'task-B');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const watcher = getSkillWatcher();
    await watcher.initialize(dirA);
    await watcher.updateProjectDirectory(dirB);

    const changes: string[] = [];
    watcher.on('change', (e: { path: string; source: string }) => {
      if (e.source === 'project') changes.push(e.path);
    });
    await mkdir(path.join(dirA, '.claude', 'skills', 'old'), { recursive: true });
    await writeFile(path.join(dirA, '.claude', 'skills', 'old', 'SKILL.md'), '---\nname: old\n---\n');
    await new Promise((r) => setTimeout(r, 2600));
    expect(changes).toEqual([]);
    expect(fs.existsSync(path.join(dirB, '.code-agent'))).toBe(false);
    expect(fs.existsSync(path.join(dirB, '.claude'))).toBe(false);
  });
});
