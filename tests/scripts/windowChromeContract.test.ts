import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

// 窗口 chrome 契约（治理卫生批⑥，2026-07-02 Dev 包实测定案）：
// 主窗口拖拽由【原生标题栏】提供（tauri.conf.json main window 未关 decorations）。
// -webkit-app-region 是 Electron 机制，Tauri 2 的 WKWebView 不支持——实测应用内
// strip 上 -webkit-app-region: drag 完全无效（窗口纹丝不动），属死类已清理。
// 本契约锁两件事，防回潮/防前提被无声打破：
describe('window chrome contract', () => {
  it('源码不得出现 -webkit-app-region（Electron 机制，Tauri 下是死代码）', () => {
    // git grep 走 index，天然覆盖新增文件；命中为空时 exit 1 是预期
    let out = '';
    try {
      out = execFileSync('git', ['grep', '-l', '-webkit-app-region', '--', 'src'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
    } catch {
      // git grep 无命中 → exit 1 → 契约满足（out 保持空串）
    }
    expect(out.trim(), '发现 -webkit-app-region 残留；Tauri 下 webview 拖拽请用 data-tauri-drag-region + 相应能力声明').toBe('');
  });

  it('主窗口保持原生 decorations（拖拽能力的当前唯一来源）', () => {
    const conf = JSON.parse(readFileSync(resolve(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8')) as {
      app: { windows: Array<{ label: string; decorations?: boolean; titleBarStyle?: string }> };
    };
    const main = conf.app.windows.find((w) => w.label === 'main');
    expect(main, 'tauri.conf.json 里找不到 label=main 的窗口，契约测试需同步更新').toBeDefined();
    // decorations 未显式设置时 Tauri 默认 true；一旦有人改成 false/overlay，
    // 必须同时引入 data-tauri-drag-region 方案，此断言强制该决策显式化
    expect(main?.decorations ?? true, '主窗口关掉了原生 decorations：拖拽将失效，需引入 data-tauri-drag-region 并更新本契约').toBe(true);
  });

  it('主窗口配置 acceptFirstMouse=true（非激活窗口的首次点击要直达页面，如审批按钮）', () => {
    const conf = JSON.parse(readFileSync(resolve(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8')) as {
      app: { windows: Array<{ label: string; acceptFirstMouse?: boolean }> };
    };
    const main = conf.app.windows.find((w) => w.label === 'main');
    expect(main?.acceptFirstMouse, 'tauri.conf.json main 窗口缺 acceptFirstMouse:true：从其他 app 切回 Neo 后首次点击只会激活窗口，审批按钮点了没反应').toBe(true);
  });

  it('recreate_main_window 重建路径链上 .accept_first_mouse(true)', () => {
    const src = readFileSync(resolve(repoRoot, 'src-tauri/src/main.rs'), 'utf8');
    const start = src.indexOf('fn recreate_main_window');
    expect(start, 'main.rs 里找不到 fn recreate_main_window，契约测试需同步更新').toBeGreaterThan(-1);
    const rest = src.slice(start + 1);
    const next = rest.search(/\n(?:\/\/\/|(?:pub(?:\([^)]*\))? )?fn )/);
    const body = next === -1 ? rest : rest.slice(0, next);
    expect(body, '重建的主窗口缺 .accept_first_mouse(true)：运行时 ObjC 补丁只覆盖原始窗口，重建后首次点击（如审批按钮）只会激活窗口').toContain('.accept_first_mouse(true)');
  });
});
