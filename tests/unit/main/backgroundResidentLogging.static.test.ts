import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Preserve code offsets while hiding Rust strings (including raw strings) and comments.
function codeOnly(source: string): string {
  return source.replace(/r(#+)?"[\s\S]*?"\1|"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (token) => ' '.repeat(token.length));
}

function productionCode(source: string): string {
  const code = codeOnly(source);
  const testModule = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*mod\s+tests\s*\{/.exec(code);
  if (!testModule) throw new Error('Missing trailing cfg(test) module');
  return code.slice(0, testModule.index);
}

const message = 'Background-resident diagnostics must use the rotating shell sink';
function check(source: string): void {
  expect(productionCode(source), message).not.toMatch(/\beprintln\s*!/);
}

describe('background-resident disk logging gate', () => {
  it('rejects direct stderr logging in production code on every platform', () => {
    check(fs.readFileSync(path.join(process.cwd(), 'src-tauri/src/background_resident.rs'), 'utf8'));
  });

  it('ignores comments and strings without letting a quoted cfg(test) bypass the gate', () => {
    check('fn log() { /* eprintln!("comment"); */ let s = "eprintln!"; let r = r#"eprintln!"#; }\n#[cfg(test)] mod tests { eprintln!("test"); }');
    expect(() => check('fn log() { let s = "#[cfg(test)] mod tests {"; eprintln!("lost"); }\n#[cfg(test)] mod tests {}')).toThrow(message);
  });

  it('rejects a direct stderr macro even across whitespace', () => {
    expect(() => check('fn log() { eprintln ! ("lost"); }\n#[cfg(test)] mod tests {}')).toThrow(message);
  });
});
