// ============================================================================
// 静态结构回归：TaskManager 类 JSDoc 必须紧贴 export class TaskManager 声明
// ----------------------------------------------------------------------------
// 2026-11-27 修复（4297b1809）前的缺陷：模块级辅助函数 isBackgroundApprovalDetached
// 插在类 JSDoc 收口 */ 与 export class TaskManager 之间，IDE 悬停与文档工具把
// 整段「TaskManager - 多会话任务编排器」类说明错挂到该辅助函数上，类本身没有文档。
// 搬移修复本身没有行为可测（纯移动），这里读源码文本锁住结构，防再次回退：
// 1. export class TaskManager 的上一个非空行必须是 JSDoc 收口  */
// 2. 该 JSDoc 的 /** 开口与类声明行之间不夹任何 function/const/interface/type 声明
// ============================================================================

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = resolve(process.cwd(), 'src/host/task/TaskManager.ts');

function loadLines(): string[] {
  return readFileSync(SOURCE, 'utf8').split('\n');
}

function classDeclarationIndex(lines: string[]): number {
  return lines.findIndex((line) => line.startsWith('export class TaskManager'));
}

describe('TaskManager 类 JSDoc 归位静态契约', () => {
  it('export class TaskManager 的上一个非空行是 JSDoc 收口 */', () => {
    const lines = loadLines();
    const classLine = classDeclarationIndex(lines);
    // 前提断言：类声明必须找得到，找不到报红而不是静默绿
    expect(classLine).toBeGreaterThan(0);
    let prev = classLine - 1;
    while (prev >= 0 && lines[prev].trim() === '') prev -= 1;
    expect(lines[prev].trim()).toBe('*/');
  });

  it('类 JSDoc 的 /** 开口与类声明行之间不夹 function/const/interface/type 声明', () => {
    const lines = loadLines();
    const classLine = classDeclarationIndex(lines);
    expect(classLine).toBeGreaterThan(0);
    let close = classLine - 1;
    while (close >= 0 && lines[close].trim() === '') close -= 1;
    expect(lines[close].trim()).toBe('*/');
    let open = close;
    while (open >= 0 && lines[open].trim() !== '/**') open -= 1;
    // 前提断言：JSDoc 开口必须找得到
    expect(open).toBeGreaterThanOrEqual(0);
    const between = lines.slice(open + 1, classLine);
    const intruders = between.filter((line) => /^\s*(?:function|const|interface|type)\s/.test(line));
    expect(intruders).toEqual([]);
  });
});
