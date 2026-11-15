import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Keep string contents (including comment-looking text) while removing Rust comments.
function productionCode(source: string): string {
  const production = source.split('#[cfg(test)]', 1)[0];
  let code = '';
  let index = 0;
  while (index < production.length) {
    const rest = production.slice(index);
    if (rest.startsWith('//')) {
      const end = production.indexOf('\n', index);
      index = end < 0 ? production.length : end;
    } else if (rest.startsWith('/*')) {
      let depth = 1;
      index += 2;
      while (index < production.length && depth > 0) {
        if (production.startsWith('/*', index)) { depth++; index += 2; }
        else if (production.startsWith('*/', index)) { depth--; index += 2; }
        else { index++; }
      }
      code += ' ';
    } else {
      const raw = /^(?:b)?r(#{0,255})"/.exec(rest);
      const quoted = /^(?:b)?"(?:\\[\s\S]|[^"\\])*"|^'(?:\\[^\n]|[^'\\\n])'/.exec(rest);
      if (raw) {
        const closing = `"${raw[1]}`;
        const end = production.indexOf(closing, index + raw[0].length);
        const length = end < 0 ? rest.length : end + closing.length - index;
        code += rest.slice(0, length);
        index += length;
      } else if (quoted) {
        code += quoted[0];
        index += quoted[0].length;
      } else {
        code += production[index++];
      }
    }
  }
  return code;
}

function cjkInProduction(source: string): string[] {
  const code = productionCode(source);
  const cjk = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/u;
  const matches = [...code].filter(character => cjk.test(character));
  for (const escape of code.matchAll(/\\u(?:\{([\da-fA-F_]+)\}|([\da-fA-F]{4}))/g)) {
    const point = Number.parseInt((escape[1] ?? escape[2]).replaceAll('_', ''), 16);
    if (point <= 0x10ffff && cjk.test(String.fromCodePoint(point))) matches.push(escape[0]);
  }
  return matches;
}

describe('quit_guard Chinese copy boundary', () => {
  it('keeps production Rust free of CJK literals and Unicode escapes', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src-tauri/src/quit_guard.rs'), 'utf8');
    expect(cjkInProduction(source), 'Chinese copy belongs in quit_dialog_i18n.rs language branches').toEqual([]);
  });

  it('ignores line, doc, nested block comments and the test module', () => {
    expect(cjkInProduction('// 中\n/// 中\n//! 中\n/* 中 /* 中 */ 中 */\n#[cfg(test)]\nconst COPY: &str = "中";')).toEqual([]);
  });

  it.each(['中', '㐀', '。', '，', String.raw`\u{4e2d}`, String.raw`\u4E2D`, String.raw`\u{34_00}`, String.raw`\u{3002}`, String.raw`\uFF0C`])('detects production copy: %s', text => {
    expect(cjkInProduction(`const COPY: &str = "${text}";`)).not.toEqual([]);
  });

  it('preserves comment-looking text inside normal and raw Rust strings', () => {
    expect(cjkInProduction('const A: &str = "https://example/中"; const B: &str = r#"/*中*/"#;')).toEqual(['中', '中']);
    expect(cjkInProduction('const A: &str = "English";')).toEqual([]);
  });
});
