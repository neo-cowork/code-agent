import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// @ts-expect-error — .mjs 脚本无类型声明
import { checkNoDevFaultInRelease } from '../../scripts/ci/check-no-dev-fault-in-release.mjs';

const roots: string[] = [];

function fixture(conf: object, bundle: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'no-dev-fault-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'src-tauri'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist/web'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist/renderer'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src-tauri/tauri.conf.json'), JSON.stringify(conf));
  fs.writeFileSync(path.join(root, 'dist/web/webServer.bundle.cjs'), bundle);
  fs.writeFileSync(path.join(root, 'dist/web/webServer.cjs'), 'require("./webServer.bundle.cjs")');
  fs.writeFileSync(path.join(root, 'dist/renderer/index.js'), 'console.log(1)');
  return root;
}

const cleanConf = { bundle: { resources: { '../dist/web/webServer.bundle.cjs': 'dist/web/webServer.bundle.cjs' } } };

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe('check-no-dev-fault-in-release', () => {
  it('干净产物通过', () => {
    expect(checkNoDevFaultInRelease(fixture(cleanConf, 'var a=1;'))).toEqual([]);
  });

  it('变异：bundle 含开关名 → 红', () => {
    const v = checkNoDevFaultInRelease(fixture(cleanConf, 'var a="NEO_DEV_FAULT";'));
    expect(v).toEqual([expect.stringContaining('webServer.bundle.cjs contains NEO_DEV_FAULT')]);
  });

  it('变异：renderer / 日志标记 → 红', () => {
    const root = fixture(cleanConf, 'x');
    fs.writeFileSync(path.join(root, 'dist/renderer/index.js'), 'log("dev_fault_inject")');
    expect(checkNoDevFaultInRelease(root)).toEqual([expect.stringContaining('dist/renderer/index.js contains dev_fault_inject')]);
  });

  it('变异：生产资源清单引用模块 → 红', () => {
    const conf = { bundle: { resources: { '../dist/web/dev-fault-inject.cjs': 'dist/web/dev-fault-inject.cjs' } } };
    expect(checkNoDevFaultInRelease(fixture(conf, 'x'))[0]).toContain('references dev-fault-inject');
  });

  it('真实构建产物（已构建时）不含开关名/日志标记', () => {
    expect(checkNoDevFaultInRelease(process.cwd())).toEqual([]);
  });

  it('仓库里的真实生产资源清单不引用模块，Dev 清单引用', () => {
    expect(checkNoDevFaultInRelease(process.cwd()).filter((l: string) => l.includes('tauri.conf.json'))).toEqual([]);
    const dev = JSON.parse(fs.readFileSync('src-tauri/tauri.dev.conf.json', 'utf8'));
    expect(Object.keys(dev.bundle.resources)).toContain('../dist/web/dev-fault-inject.cjs');
  });
});
