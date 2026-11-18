import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getSkillWatcher,
  resetSkillWatcher,
} from '../../../../src/host/services/skills/skillWatcher';

describe('SkillWatcher planned work directory', () => {
  let tempHome: string;
  let priorEnv: { CODE_AGENT_HOME?: string; CODE_AGENT_DATA_DIR?: string };

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'skill-watcher-planned-dir-'));
    priorEnv = {
      CODE_AGENT_HOME: process.env.CODE_AGENT_HOME,
      CODE_AGENT_DATA_DIR: process.env.CODE_AGENT_DATA_DIR,
    };
    process.env.CODE_AGENT_HOME = tempHome;
    process.env.CODE_AGENT_DATA_DIR = path.join(tempHome, 'nested', '.code-agent');
  });

  afterEach(async () => {
    resetSkillWatcher();
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  it('does not create project skill directories below an absent planned directory', async () => {
    const existingProject = path.join(tempHome, 'existing-project');
    const plannedDirectory = path.join(tempHome, 'default-work-root', '任务_1107_只调连接器');
    await mkdir(existingProject, { recursive: true });
    const watcher = getSkillWatcher();
    await watcher.initialize(existingProject);

    await watcher.updateProjectDirectory(plannedDirectory);

    await expect(stat(plannedDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('picks up a project skills dir that appears after startup, without pre-creating it', async () => {
    const project = path.join(tempHome, 'notes');
    await mkdir(project, { recursive: true });
    const watcher = getSkillWatcher();
    await watcher.initialize(project);
    expect(await readdir(project)).toEqual([]);

    const nextReload = () => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no skills reload')), 8000);
      watcher.once('reloaded', () => { clearTimeout(timer); resolve(); });
    });

    // 会话中途 skill_create(scope=project) 一次性建出整条路径
    const first = nextReload();
    await mkdir(path.join(project, '.code-agent', 'skills', 'first'), { recursive: true });
    await writeFile(path.join(project, '.code-agent', 'skills', 'first', 'SKILL.md'), '---\nname: first\n---\n');
    await first;

    // 之后的递归监听已经挂上：再写一个技能仍会触发重扫
    const second = nextReload();
    await mkdir(path.join(project, '.code-agent', 'skills', 'second'), { recursive: true });
    await writeFile(path.join(project, '.code-agent', 'skills', 'second', 'SKILL.md'), '---\nname: second\n---\n');
    await second;
  });
});
