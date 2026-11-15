#!/usr/bin/env node
// resolve-push-base — 把 `github.event.before` 解析成浅检出里一定可用的基线参照。
//
// 背景（run 43212993532，2026-11-12）：main-full-gate 以 fetch-depth: 2 检出，而
// concurrency 不取消在跑的旧 run，一次 push 事件可以携带多个提交——event.before
// 落在 HEAD~2 之外时深度 2 里没有那个对象，coverage-ratchet 的
// `git cat-file -e <sha>^{commit}` 直接红。本脚本在棘轮之前把参照收敛为本地可解析：
//   - before 为空 / 全零（workflow_dispatch、初始推送）→ HEAD^
//   - before 已在本地（深度 2 覆盖 HEAD^）→ 原样返回，不 fetch
//   - before 缺失 → 只补取这一个提交（--depth=1：棘轮只读该提交里的基线 JSON /
//     改动行 diff，不需要全量历史；GitHub 对可达对象允许按 SHA fetch）
//   - 仍拿不到（force push 改写、gc 清理、网络故障）→ 降级 HEAD^，但必须用
//     ::warning:: 注解把真实 git 报错留在步骤日志里——降级路径要可分辨，
//     不许静默吞掉 git 的报错文本
//
// 约定：stdout 恰好一行 ref（供 shell 命令替换消费），诊断一律走 stderr，恒退出 0。

import { spawnSync } from 'node:child_process';
import process from 'node:process';

function runGit(args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

function hasCommit(rev) {
  return runGit(['cat-file', '-e', `${rev}^{commit}`]).status === 0;
}

const before = (process.argv[2] ?? '').trim();

if (before === '' || /^0+$/.test(before)) {
  console.log('HEAD^');
  process.exit(0);
}

if (hasCommit(before)) {
  console.log(before);
  process.exit(0);
}

const fetched = runGit(['fetch', '--no-tags', '--depth=1', 'origin', before]);
if (fetched.status === 0 && hasCommit(before)) {
  console.log(before);
  process.exit(0);
}

const gitError = (fetched.stderr || '').trim()
  || `git fetch --no-tags --depth=1 origin ${before} 退出码 ${fetched.status}（stderr 为空）`;
console.error(`::warning::[resolve-push-base] push 基线参照 ${before} 不可解析（补取后仍缺对象），已降级为 HEAD^。真实 git 报错：${gitError}`);
console.log('HEAD^');
