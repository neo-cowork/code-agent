import { describe, expect, it } from 'vitest';
import { resolveStoppedTaskOutcome } from '../../../../src/host/services/commandCenter/sessionTaskStopConclusion';

const CLOSED = '<tool_call><function=Browser><parameter=action>type</parameter><parameter=targetRef>tref_snapshot_example_23</parameter><parameter=text>Tauri</parameter></function></tool_call>';
const UNCLOSED = '<tool_call><function=Browser><parameter=action>type</parameter><parameter=text>Tauri';
const PAGE = '「Example Domain」';

describe('resolveStoppedTaskOutcome markup-only browser conclusion', () => {
  it.each([
    ['closed tool_call', CLOSED],
    ['unclosed tool_call', UNCLOSED],
  ])('%s is unfinished and names the last page', (_label, detail) => {
    const outcome = resolveStoppedTaskOutcome({ status: 'completed', detail, lastUrl: PAGE });
    expect(outcome).toMatchObject({ status: 'failed', kind: 'no_conclusion' });
    expect(outcome.notice).toBe(outcome.detail);
    expect(outcome.detail).toContain('没有留下最终结果');
    expect(outcome.detail).toContain('继续');
    expect(outcome.detail).toContain(`最后停留在页面${PAGE}`);
    expect(outcome.detail).not.toMatch(/tool_call|function=|targetRef/);
  });

  it('keeps prose around a tool_call as a completed conclusion', () => {
    const outcome = resolveStoppedTaskOutcome({
      status: 'completed',
      detail: `页面标题是 Example Domain。\n${CLOSED}`,
      lastUrl: PAGE,
    });
    expect(outcome).toEqual({ status: 'completed', detail: '页面标题是 Example Domain。' });
  });

  it('leaves an ordinary conclusion completed', () => {
    expect(resolveStoppedTaskOutcome({
      status: 'completed',
      detail: '  页面标题是 Example Domain。  ',
    })).toEqual({ status: 'completed', detail: '页面标题是 Example Domain。' });
  });

  it('does not append markup-only leftovers onto a step-cap sentence', () => {
    const outcome = resolveStoppedTaskOutcome({
      status: 'completed',
      detail: CLOSED,
      lastUrl: PAGE,
      stepCap: { max: 8 },
    });
    expect(outcome.kind).toBe('step_cap');
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain('第 8 步（上限 8 步）');
    expect(outcome.detail).toContain(`最后停留在页面${PAGE}`);
    expect(outcome.detail).not.toMatch(/tool_call|function=/);
    expect(outcome.notice).toBe(outcome.detail);
  });
});

const REAL_FAILED_ROWS = [
  '抓取失败了，没有任何定价内容可以总结——我不会编造要点。\n**请求的地址**：x',
  '**任务未能完成：定价表没有抓到，因此没有 3 条要点可交付。**\n- 抓取失败原因：DNS 直接失败。',
  '**任务未完成——页面打不开，没有任何定价表内容。**\n原因：域名无法解析。',
  '没能取到显示名称',
];

it('notice keeps only the first conclusion line, plain text; detail keeps the full cleaned text', () => {
  const outcome = resolveStoppedTaskOutcome({
    status: 'completed',
    detail: '**结论：抓取失败，没有拿到页面内容。**\n1. 直接访问 → `Failed to fetch URL: fetch failed`',
  });
  expect(outcome.notice).toBe('这个后台任务没有完成你交代的事，下面是它留下的说明：结论：抓取失败，没有拿到页面内容。');
  expect(outcome.detail).toContain('Failed to fetch URL');
  expect(outcome.notice).not.toContain('Failed to fetch');
});

describe('resolveStoppedTaskOutcome unfinished-opener conclusion', () => {
  it.each([
    '执行失败：连接超时',
    '未能完成：页面需要登录',
    '无法打开页面 https://x.invalid',
    '结论：任务未完成，页面打不开',
    '- **任务失败**',
    'Unable to open the page.',
    'Failed to fetch the pricing table',
    ...REAL_FAILED_ROWS,
  ])('failure prose with completed status becomes failed: %s', (detail) => {
    const outcome = resolveStoppedTaskOutcome({ status: 'completed', detail });
    expect(outcome).toMatchObject({ status: 'failed', kind: 'error' });
    expect(outcome.notice).toContain('这个后台任务没有完成你交代的事，下面是它留下的说明：');
    expect(outcome.detail).toContain('这个后台任务没有完成你交代的事');
    expect(`${outcome.notice}${outcome.detail}`).not.toMatch(/\*\*|__|`/);
    const firstLine = detail.split('\n')[0].replace(/(\*\*|__|`)/g, '').replace(/^[-*+]\s+/, '').trim();
    expect(outcome.notice).toContain(firstLine);
    expect(outcome.detail).toContain(firstLine);
  });

  it.each([
    '页面标题是 Example Domain。',
    '三条要点已整理好。其中一个子页面打不开，已跳过；任务未完成的只有附录。',
    '\n\n已完成。\n无法打开的链接有 1 个。',
    '无法访问英文版，以下是中文版定价页的三条要点：\n1. 基础版 99 元/月',
    '未能找到官方折扣说明，但已核对标准价格：专业版 299 元/月。',
  ])('success prose stays completed: %s', (detail) => {
    expect(resolveStoppedTaskOutcome({ status: 'completed', detail }).status).toBe('completed');
  });

  it('markup-only stays failed/no_conclusion', () => {
    expect(resolveStoppedTaskOutcome({ status: 'completed', detail: CLOSED })).toMatchObject({ status: 'failed', kind: 'no_conclusion' });
  });
});
