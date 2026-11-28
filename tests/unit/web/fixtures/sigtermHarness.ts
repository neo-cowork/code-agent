// 子进程夹具（由 sigtermUnderInjection.test.ts 经 tsx 启动，不是测试文件）：
// 在注入故障的条件下装上 SIGTERM 处理器，让父进程量「信号 → 进程退出」的时延。
// 处理器只用生产模块 recordShutdownCause 落最后遗言，再 process.exit(0)——webServer 的完整
// shutdown 是 startServer 闭包里的函数，没有可单独 import 的入口；这里量的是 11-26 坏掉的那一环：
// 事件循环被阻塞时信号处理器根本轮不到运行。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { recordShutdownCause } from '../../../../src/web/shutdownCause';

const mode = process.env.HARNESS_MODE;
const readyFile = process.env.HARNESS_READY_FILE as string;
const workDir = process.env.HARNESS_WORK_DIR as string;

process.on('SIGTERM', (signal) => {
  recordShutdownCause(signal);
  process.exit(0);
});
const keepAlive = setInterval(() => undefined, 1_000);   // 切换/初始化结束后也别让进程自己退出
void keepAlive;

async function skillSwitch(): Promise<void> {
  const { getSkillWatcher } = await import('../../../../src/host/services/skills/skillWatcher');
  const dirA = path.join(workDir, 'task-A');
  const dirB = path.join(workDir, 'task-B');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  const watcher = getSkillWatcher();
  await watcher.initialize(dirA);

  // 注入：FSWatcher.close 同步阻塞 300ms（模拟 fseventsd 繁忙）
  const probe = fs.watch(workDir);
  const proto = Object.getPrototypeOf(probe) as { close(this: unknown): void };
  probe.close();
  const realClose = proto.close;
  proto.close = function (this: unknown) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    return realClose.call(this);
  };

  fs.writeFileSync(readyFile, String(process.pid));
  for (let i = 0; i < 10; i++) {
    await watcher.updateProjectDirectory(i % 2 === 0 ? dirB : dirA);
  }
}

async function lspPending(): Promise<void> {
  const { initializeLSPManager } = await import('../../../../src/host/lsp/manager');
  // PATH 上的 typescript-language-server 垫片会拉起永不应答 initialize 的 stub
  const pending = initializeLSPManager(workDir);
  pending.catch(() => undefined);
  fs.writeFileSync(readyFile, String(process.pid));
}

void (mode === 'skill-switch' ? skillSwitch() : lspPending());
