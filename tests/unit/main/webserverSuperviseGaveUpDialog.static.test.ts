import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'src-tauri/src/webserver_supervise.rs'), 'utf8');

function stripComments(rust: string): string {
  return rust.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (token) =>
    token.startsWith('"') ? token : ' ');
}

function functionBody(rust: string, name: string): string {
  const stripped = stripComments(rust);
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

describe('webserver gave-up dialog i18n contract', () => {
  it('reads the shell language once and builds per-language copy', () => {
    const body = functionBody(source, 'show_gave_up_dialog');
    expect(body).toContain('let language = crate::menu_i18n::read_language(crate::real_data_dir().as_deref());');
    expect(body).toContain('let copy = gave_up_dialog_copy(language);');
  });

  it('shows the localized copy on the native dialog instead of consts', () => {
    const body = functionBody(source, 'show_gave_up_dialog');
    expect(body).toContain('.message(copy.message)');
    expect(body).toContain('.title(copy.title)');
    expect(body).toContain('copy.retry_label.to_string()');
    expect(body).toContain('copy.later_label.to_string()');
  });

  it('maps the clicked button through the same language that built the dialog', () => {
    const body = functionBody(source, 'show_gave_up_dialog');
    expect(body).toContain('gave_up_dialog_action(custom_label.as_deref(), language)');
  });

  it('gave_up_dialog_action takes the language and compares the localized retry label', () => {
    expect(stripComments(source)).toContain(
      'fn gave_up_dialog_action(custom_label: Option<&str>, language: crate::menu_i18n::Language)',
    );
    const body = functionBody(source, 'gave_up_dialog_action');
    expect(body).toContain('gave_up_dialog_copy(language).retry_label');
  });

  it('pins zh and en copy byte-exact inside gave_up_dialog_copy', () => {
    const body = functionBody(source, 'gave_up_dialog_copy');
    expect(body).toContain('Language::Zh');
    expect(body).toContain('Language::En');
    for (const copy of [
      '"Agent Neo"',
      '"后台服务没能自动恢复。"',
      '"重试"',
      '"稍后"',
      '"Background service could not recover automatically."',
      '"Retry"',
      '"Later"',
    ]) {
      expect(body).toContain(copy);
    }
  });

  it('removed the hardcoded Chinese consts so call sites cannot bypass i18n', () => {
    expect(source).not.toContain('GAVE_UP_DIALOG_TITLE');
    expect(source).not.toContain('GAVE_UP_DIALOG_MESSAGE');
    expect(source).not.toContain('GAVE_UP_DIALOG_RETRY_LABEL');
    expect(source).not.toContain('GAVE_UP_DIALOG_LATER_LABEL');
  });
});
