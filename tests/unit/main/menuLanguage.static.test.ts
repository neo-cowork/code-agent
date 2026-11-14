import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const main = fs.readFileSync(path.join(process.cwd(), 'src-tauri/src/main.rs'), 'utf8');
const message = 'Native menu copy belongs in menu_i18n.rs';

function stripComments(source: string): string {
  return source.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (token) =>
    token.startsWith('"') ? token : ' ');
}

function functionBody(source: string, name: string): string {
  const stripped = stripComments(source);
  const start = stripped.indexOf(`fn ${name}(`);
  expect(start, `Missing function ${name}`).toBeGreaterThanOrEqual(0);
  const opening = stripped.indexOf('{', start);
  let depth = 1;
  const tokens = /"(?:\\.|[^"\\])*"|[{}]/g;
  tokens.lastIndex = opening + 1;
  for (let token = tokens.exec(stripped); token; token = tokens.exec(stripped)) {
    if (token[0] === '{') depth++;
    if (token[0] === '}' && --depth === 0) return stripped.slice(opening + 1, token.index);
  }
  throw new Error(`Unclosed function ${name}`);
}

function expectNoCjk(body: string): void {
  const decoded = body.replace(/\\u(?:\{([0-9a-fA-F]{1,6})\}|([0-9a-fA-F]{4}))/g,
    (_match, braced: string | undefined, plain: string | undefined) =>
      String.fromCodePoint(Number.parseInt(braced ?? plain!, 16)));
  expect(decoded, message).not.toMatch(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u);
}

describe('native menu language copy gate', () => {
  for (const name of ['setup_app_menu', 'setup_tray']) {
    it(`${name} gets copy from menu_i18n.rs without CJK literals or escapes`, () => {
      const body = functionBody(main, name);
      expect(body).toContain('menu_i18n::read_language(real_data_dir().as_deref()).labels()');
      expectNoCjk(body);
    });
  }

  it('ignores comments and braces inside string literals when extracting a function', () => {
    expectNoCjk(functionBody('fn menu() { // 中文\n /* 中文 */ let s = "}"; }', 'menu'));
  });

  it.each(['"设置"', '"\\u{8bbe}"', '"\\u8bbe"'])('rejects CJK copy %s', (copy) => {
    expect(() => expectNoCjk(copy)).toThrow(message);
  });
});
