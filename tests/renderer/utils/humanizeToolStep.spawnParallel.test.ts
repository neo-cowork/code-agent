import { describe, expect, it } from 'vitest';
import { humanizeToolStep } from '../../../src/renderer/utils/humanizeToolStep';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

// 真实并行参数，取自父单 N-FIX-SPAWN-APPROVAL-CARD-TASK-BLANK 证据
const named = {
  agents: [
    { name: '销售助手', role: 'explore', task: 'read sales.txt' },
    { name: '产品助手', role: 'explore', task: 'read product.txt' },
    { name: '支持助手', role: 'explore', task: 'read support.txt' },
  ],
  parallel: true,
  waitForCompletion: true,
};
const roleOnly = {
  agents: [{ role: 'explore', task: 'a' }, { role: 'explore', task: 'b' }],
  parallel: true,
};

describe('humanizeToolStep — spawn_agent parallel form', () => {
  it('zh: count + names in running / completed / pending / failed', () => {
    expect(humanizeToolStep('spawn_agent', named, zh, undefined, 'running')).toBe('正在启动 3 个代理 — 销售助手、产品助手、支持助手');
    expect(humanizeToolStep('spawn_agent', named, zh)).toBe('启动了 3 个代理 — 销售助手、产品助手、支持助手');
    expect(humanizeToolStep('spawn_agent', named, zh, undefined, 'pending-approval')).toBe('请求启动 3 个代理 — 销售助手、产品助手、支持助手');
    expect(humanizeToolStep('spawn_agent', named, zh, undefined, 'failed')).toBe('启动 3 个代理未成功 — 销售助手、产品助手、支持助手');
  });

  it('en: count + names in running and completed', () => {
    const n = { agents: [{ name: 'Sales helper' }, { name: 'Product helper' }, { name: 'Support helper' }], parallel: true };
    expect(humanizeToolStep('spawn_agent', n, en, undefined, 'running')).toBe('Starting 3 agent tasks — Sales helper, Product helper, Support helper');
    expect(humanizeToolStep('spawn_agent', n, en)).toBe('Started 3 agent tasks — Sales helper, Product helper, Support helper');
  });

  it('role-only entries use role labels, never empty', () => {
    const zhOut = humanizeToolStep('spawn_agent', roleOnly, zh, undefined, 'running');
    expect(zhOut).toMatch(/^正在启动 2 个代理 — .+/);
    expect(zhOut).not.toMatch(/— $/);
    expect(humanizeToolStep('spawn_agent', roleOnly, en)).toMatch(/^Started 2 agent tasks — .+/);
  });

  it('4 agents show at most 3 names then an ellipsis', () => {
    const four = { parallel: true, agents: ['甲', '乙', '丙', '丁'].map((name) => ({ name })) };
    expect(humanizeToolStep('spawn_agent', four, zh)).toBe('启动了 4 个代理 — 甲、乙、丙…');
    expect(humanizeToolStep('spawn_agent', { parallel: true, agents: ['A', 'B', 'C', 'D'].map((name) => ({ name })) }, en))
      .toBe('Started 4 agent tasks — A, B, C…');
  });

  it('one entry behaves like the single form with that role', () => {
    expect(humanizeToolStep('spawn_agent', { parallel: true, agents: [{ role: 'explore', task: 'x' }] }, zh))
      .toBe(humanizeToolStep('spawn_agent', { role: 'explore', task: 'x' }, zh));
  });

  it('missing / invalid input keeps the fallback', () => {
    expect(humanizeToolStep('spawn_agent', {}, zh)).toBe('启动了一个代理');
    expect(humanizeToolStep('spawn_agent', { parallel: true, agents: [] }, zh)).toBe('启动了一个代理');
    expect(humanizeToolStep('spawn_agent', { parallel: true, agents: [null, 3] }, en)).toBe('Started an agent');
  });

  it('single form unchanged (role / Task subagent_type / Explore)', () => {
    expect(humanizeToolStep('spawn_agent', { role: 'explore', task: 't' }, zh)).toBe('启动了代理 — ' + (humanizeToolStep('spawn_agent', { role: 'explore' }, zh).split('— ')[1]));
    expect(humanizeToolStep('Task', { subagent_type: 'general-purpose', description: '核对清单' }, zh)).toBe('启动了代理 — 核对清单');
    expect(humanizeToolStep('Explore', { description: 'x' }, en, undefined, 'running')).toMatch(/^Starting an agent — .+/);
  });

  it('agents[] without parallel===true is ignored (host runs the top-level single form)', () => {
    const args = { role: 'explore', task: 'x', agents: [{ role: 'coder', task: 'a' }, { role: 'coder', task: 'b' }] };
    const single = humanizeToolStep('spawn_agent', { role: 'explore', task: 'x' }, zh);
    expect(humanizeToolStep('spawn_agent', args, zh)).toBe(single);
    expect(humanizeToolStep('spawn_agent', { ...args, parallel: false }, zh, undefined, 'pending-approval'))
      .toBe(humanizeToolStep('spawn_agent', { role: 'explore', task: 'x' }, zh, undefined, 'pending-approval'));
    expect(humanizeToolStep('spawn_agent', { agents: [{ name: 'a' }, { name: 'b' }] }, zh)).toBe('启动了一个代理');
  });
});
