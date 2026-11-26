import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../../src/host/agent/runtime');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/** 返回 onEvent( 调用负载里出现内部诊断字面量的位置 */
function findDiagnosticLeaks(source: string): string[] {
  const hits: string[] = [];
  let idx = source.indexOf('onEvent(');
  while (idx !== -1) {
    // 取调用括号内的平衡片段
    let depth = 0;
    let end = idx + 'onEvent'.length;
    for (let i = end; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')' && --depth === 0) { end = i; break; }
    }
    const payload = source.slice(idx, end);
    if (payload.includes('[runtime]') || payload.includes('Thinking Step')) hits.push(payload.slice(0, 80));
    idx = source.indexOf('onEvent(', idx + 1);
  }
  return hits;
}

describe('runtime diagnostics never reach user-visible events', () => {
  it('no onEvent payload under src/host/agent/runtime carries [runtime] / Thinking Step', () => {
    const offenders = walk(ROOT)
      .filter((f) => findDiagnosticLeaks(readFileSync(f, 'utf8')).length > 0)
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('scanner flags a seeded violation', () => {
    const seeded = "this.ctx.onEvent({ type: 'stream_reasoning', data: { content: `\\n[runtime] ${d}\\n` } });";
    expect(findDiagnosticLeaks(seeded)).toHaveLength(1);
    expect(findDiagnosticLeaks("ctx.onEvent({ message: `[Thinking Step 1]` })")).toHaveLength(1);
    expect(findDiagnosticLeaks("logger.info('[RuntimeDiagnostic] x'); ctx.onEvent({type:'x'})")).toHaveLength(0);
  });
});
