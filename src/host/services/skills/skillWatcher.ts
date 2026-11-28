// ============================================================================
// Skill Watcher Service - 监听 Skills 目录变化实现热重载
// ============================================================================

import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { createLogger } from '../infra/logger';
import { getSkillDiscoveryService } from './skillDiscoveryService';
import { getSkillsDir, getUserConfigDir } from '../../config';
import { EVENT_LOOP_DIAG_TIMEOUTS } from '../../../shared/constants';
import { beginSkillWatcherOp } from '../infra/loopBreadcrumbs';

import { Disposable, getServiceRegistry } from '../serviceRegistry';
const logger = createLogger('SkillWatcher');

/**
 * Skills 目录变化事件
 */
export interface SkillChangeEvent {
  type: 'add' | 'change' | 'unlink';
  path: string;
  source: 'user' | 'project' | 'library';
}

/**
 * SkillWatcher 配置
 */
export interface SkillWatcherConfig {
  debounceMs?: number;
}

/** 项目级 skills 目录的一份快照：存在性 + 每个 <skill>/SKILL.md 的 mtime */
interface ProjectDirSnapshot {
  exists: boolean;
  skills: Map<string, string>;
}

interface ProjectPoller {
  timer: NodeJS.Timeout | null;
  stopped: boolean;
}

/**
 * Skill 文件监听服务
 *
 * 监听以下目录的变化（支持新旧路径）：
 * - ~/.code-agent/skills/ (用户级，新格式)
 * - ~/.claude/skills/ (用户级，旧格式)
 * - 库级 libraries 目录
 * 以上三类与工作区无关：只建一次 fs.watch，工作区切换不碰它们。
 * - .code-agent/skills/ (项目级，新格式)
 * - .claude/skills/ (项目级，旧格式)
 * 项目级不用 fs.watch：macOS 上目录 watch 都由 FSEvents 承载，close() 会在主线程
 * 同步等 fseventsd，繁忙时一次几十秒甚至永远（2026-11-26 夜跑卡死）。改为异步、
 * 不重叠、unref 的轮询，切换只清定时器。
 *
 * 变化后自动调用 SkillDiscoveryService.reload()
 */
class SkillWatcher extends EventEmitter implements Disposable {
  /** 用户级/库级监听，按目录去重，跨工作区切换存活 */
  private staticWatchers = new Map<string, fs.FSWatcher>();
  private projectPollers: ProjectPoller[] = [];
  private workingDirectory = '';
  private debounceMs: number;
  private reloadTimer: NodeJS.Timeout | null = null;
  private initialized = false;
  /** 项目级轮询换代：让过期的 tick 失效 */
  private watchGeneration = 0;

  constructor(config: SkillWatcherConfig = {}) {
    super();
    this.debounceMs = config.debounceMs ?? 500;
  }

  /**
   * 初始化监听器
   */
  async initialize(workingDirectory: string): Promise<void> {
    const endOp = beginSkillWatcherOp('initialize');
    try {
      this.stopProjectPolling();
      this.workingDirectory = workingDirectory;

      const skillsDirs = getSkillsDir(workingDirectory);

      // 用户级 + 库级：目录集合不变就原样保留，不 close 也不重建
      this.syncStaticWatchers([
        { dir: skillsDirs.user.new, source: 'user' },
        { dir: skillsDirs.user.legacy, source: 'user' },
        { dir: path.join(getUserConfigDir(), 'libraries'), source: 'library' },
      ]);

      // 项目级 Skills 目录（新旧两个路径）。无文件夹会话的工作目录可能只是规划值，
      // 尚未落盘；这里只读不建，绝不替用户 mkdir。目录（或其祖先）之后才出现也由
      // 轮询里的「存在性」变化发现，不需要祖先 watcher。
      if (skillsDirs.project && await this.projectDirectoryExists()) {
        await Promise.all([
          this.pollProjectDirectory(skillsDirs.project.new),
          this.pollProjectDirectory(skillsDirs.project.legacy),
        ]);
      }

      this.initialized = true;
      logger.info('SkillWatcher initialized', {
        workingDirectory,
        watchCount: this.getWatchCount(),
      });
    } finally {
      endOp();
    }
  }

  private async projectDirectoryExists(): Promise<boolean> {
    try {
      return (await fsp.stat(this.workingDirectory)).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * 更新项目目录（工作目录切换时调用）：只重挂项目级轮询，不 close 任何 FSWatcher
   */
  async updateProjectDirectory(newWorkingDirectory: string): Promise<void> {
    if (this.workingDirectory === newWorkingDirectory) {
      return;
    }

    logger.info('Updating project directory for SkillWatcher', {
      old: this.workingDirectory,
      new: newWorkingDirectory,
    });

    await this.initialize(newWorkingDirectory);
  }

  /** 让 staticWatchers 与期望的目录集合一致；只对「不再需要」的目录 close。 */
  private syncStaticWatchers(wanted: Array<{ dir: string; source: 'user' | 'library' }>): void {
    const wantedDirs = new Set(wanted.map((w) => w.dir));
    for (const [dir, watcher] of this.staticWatchers) {
      if (wantedDirs.has(dir)) continue;
      this.closeWatcher(watcher, dir);
      this.staticWatchers.delete(dir);
    }
    for (const { dir, source } of wanted) {
      if (!this.staticWatchers.has(dir)) this.watchDirectory(dir, source);
    }
  }

  private closeWatcher(watcher: fs.FSWatcher, dir: string): void {
    const endOp = beginSkillWatcherOp(`close-watcher ${dir}`);
    try {
      watcher.close();
    } catch {
      // 忽略关闭错误
    } finally {
      endOp();
    }
  }

  /**
   * 监听用户级/库级目录（应用自己的配置目录，按需创建；只调用一次，之后常驻）
   */
  private watchDirectory(dir: string, source: 'user' | 'library'): void {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      logger.debug('Could not create directory', { dir, error: String(error) });
    }

    try {
      fs.accessSync(dir, fs.constants.R_OK);
    } catch {
      logger.debug('Directory not accessible, skipping watch', { dir });
      return;
    }

    try {
      const watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;

        // 只关注 SKILL.md 文件或目录变化
        if (filename.endsWith('SKILL.md') || !filename.includes('.')) {
          logger.debug('Skill file changed', { eventType, filename, source });

          const event: SkillChangeEvent = {
            type: eventType === 'rename' ? 'add' : 'change',
            path: path.join(dir, filename),
            source,
          };

          this.emit('change', event);
          this.scheduleReload();
        }
      });

      watcher.on('error', (error) => {
        logger.warn('Watcher error', { dir, error: String(error) });
      });

      this.staticWatchers.set(dir, watcher);
      logger.debug('Watching directory', { dir, source });
    } catch (error) {
      logger.warn('Failed to watch directory', { dir, error: String(error) });
    }
  }

  // --------------------------------------------------------------------------
  // 项目级轮询
  // --------------------------------------------------------------------------

  private async readProjectSnapshot(target: string): Promise<ProjectDirSnapshot | null> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(target, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { exists: false, skills: new Map() };
      logger.debug('Project skills dir not readable', { target, error: String(error) });
      return null;
    }
    const skills = new Map<string, string>();
    await Promise.all(entries.map(async (entry) => {
      const mtime = await fsp.stat(path.join(target, entry.name, 'SKILL.md')).then((st) => String(st.mtimeMs), () => '-');
      skills.set(entry.name, mtime);
    }));
    return { exists: true, skills };
  }

  private diffProjectSnapshot(target: string, prev: ProjectDirSnapshot, next: ProjectDirSnapshot): SkillChangeEvent | null {
    const make = (type: SkillChangeEvent['type'], p: string): SkillChangeEvent => ({ type, path: p, source: 'project' });
    if (prev.exists !== next.exists) return make(next.exists ? 'add' : 'unlink', target);
    for (const [name, mtime] of next.skills) {
      const before = prev.skills.get(name);
      if (before === undefined) return make('add', path.join(target, name, 'SKILL.md'));
      if (before !== mtime) return make('change', path.join(target, name, 'SKILL.md'));
    }
    for (const name of prev.skills.keys()) {
      if (!next.skills.has(name)) return make('unlink', path.join(target, name, 'SKILL.md'));
    }
    return null;
  }

  /**
   * 对一个项目级 skills 目录建基线并开始轮询。每轮 await 完才排下一轮（不重叠），
   * 定时器 unref。目录还不存在也照轮询（存在性本身就是签名的一部分）。
   */
  private async pollProjectDirectory(target: string): Promise<void> {
    const generation = this.watchGeneration;
    const poller: ProjectPoller = { timer: null, stopped: false };
    this.projectPollers.push(poller);

    let snapshot = await this.readProjectSnapshot(target);
    if (poller.stopped || generation !== this.watchGeneration) return;

    const schedule = (): void => {
      if (poller.stopped) return;
      poller.timer = setTimeout(() => { void tick(); }, EVENT_LOOP_DIAG_TIMEOUTS.SKILL_PROJECT_POLL_INTERVAL);
      poller.timer.unref();
    };
    const tick = async (): Promise<void> => {
      poller.timer = null;
      const next = await this.readProjectSnapshot(target);
      if (poller.stopped || generation !== this.watchGeneration) return;
      if (next) {
        const event = snapshot ? this.diffProjectSnapshot(target, snapshot, next) : null;
        snapshot = next;
        if (event) {
          logger.debug('Project skill changed', { path: event.path, type: event.type });
          this.emit('change', event);
          this.scheduleReload();
        }
      }
      schedule();
    };
    schedule();
  }

  private stopProjectPolling(): void {
    this.watchGeneration++;
    for (const poller of this.projectPollers) {
      poller.stopped = true;
      if (poller.timer) clearTimeout(poller.timer);
      poller.timer = null;
    }
    this.projectPollers = [];
  }

  /**
   * 调度重新加载（带防抖）
   */
  private scheduleReload(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }

    this.reloadTimer = setTimeout(async () => {
      try {
        logger.info('Reloading skills due to file changes');
        const discoveryService = getSkillDiscoveryService();
        await discoveryService.reload();

        const stats = discoveryService.getStats();
        logger.info('Skills reloaded', {
          total: stats.total,
          bySource: stats.bySource,
        });

        this.emit('reloaded', stats);
      } catch (error) {
        logger.error('Failed to reload skills', { error });
        this.emit('error', error);
      }
    }, this.debounceMs);
  }

  /**
   * 停止所有监听器
   */
  async dispose(): Promise<void> {
    this.stop();
    this.removeAllListeners();
  }

  /** 完整停止（dispose / 测试复位）：这里才会 close 用户级与库级 watcher */
  stop(): void {
    const endOp = beginSkillWatcherOp('stop');
    this.stopProjectPolling();
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }

    for (const [dir, watcher] of this.staticWatchers) {
      this.closeWatcher(watcher, dir);
    }

    this.staticWatchers.clear();
    this.initialized = false;
    endOp();
    logger.debug('SkillWatcher stopped');
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 获取当前监听的目录数量
   */
  getWatchCount(): number {
    return this.staticWatchers.size + this.projectPollers.length;
  }
}

// Global singleton
let globalInstance: SkillWatcher | null = null;

/**
 * 获取全局 SkillWatcher 实例
 */
export function getSkillWatcher(): SkillWatcher {
  if (!globalInstance) {
    globalInstance = new SkillWatcher();
  }
  return globalInstance;
}

/**
 * 初始化 SkillWatcher
 */
export async function initSkillWatcher(workingDirectory: string): Promise<SkillWatcher> {
  const watcher = getSkillWatcher();
  await watcher.initialize(workingDirectory);
  return watcher;
}

/**
 * 重置全局实例（用于测试）
 */
export function resetSkillWatcher(): void {
  if (globalInstance) {
    globalInstance.stop();
    globalInstance = null;
  }
}

getServiceRegistry().register('SkillWatcher', getSkillWatcher());
export { SkillWatcher };
