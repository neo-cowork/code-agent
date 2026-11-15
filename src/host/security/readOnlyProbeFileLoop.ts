import path from 'path';

type Part = { text: string } | { value: 'file' | 'bytes' };
export interface ProbeFileLoop {
  kind: 'file-loop';
  directory: string;
  files: Array<{ label: string; path: string }>;
  body: Array<{ kind: 'cat' } | { kind: 'echo'; parts: Part[] }>;
  sources: string[];
}

function literalWords(input: string, home: string): string[] | null {
  const words: string[] = [];
  let rest = input.trim();
  while (rest) {
    const match = /^(?:"([^"$`\\\r\n]*)"|'([^'\r\n]*)'|([A-Za-z0-9_./~-]+))(?=\s|$)/.exec(rest);
    if (!match) return null;
    const value = match[1] ?? match[2] ?? match[3];
    if (!value) return null;
    const bare = match[3];
    if (bare?.startsWith('~')) {
      if (bare === '~') words.push(home);
      else if (bare.startsWith('~/')) words.push(path.join(home, value.slice(2)));
      else return null; // ~other-user needs shell account lookup; never treat it as a local literal.
    } else words.push(value);
    rest = rest.slice(match[0].length).trim();
  }
  return words;
}

/** A finite literal file list and a closed body grammar, never shell evaluation. */
export function compileReadOnlyFileLoop(command: string, home: string): ProbeFileLoop | null {
  const match = /^\s*cd\s+(.+?)\s*&&\s*for\s+([a-z][a-z0-9_]*)\s+in\s+([^;]+);\s*do\s+([\s\S]+);\s*done\s*;?\s*$/.exec(command);
  if (!match) return null;
  const directories = literalWords(match[1], home);
  const labels = literalWords(match[3], home);
  if (directories?.length !== 1 || !path.isAbsolute(directories[0]) || !labels?.length || labels.length > 64) return null;
  if (labels.some((label) => label.startsWith('-'))) return null;
  const directory = path.resolve(directories[0]);
  const variable = match[2];
  const reference = `(?:\\$${variable}|\\$\\{${variable}\\})`;
  const cat = new RegExp(`^cat\\s+(?:--\\s+)?"${reference}"$`);
  const byteTarget = labels.every((label) => /^[A-Za-z0-9_./~-]+$/.test(label))
    ? `(?:"${reference}"|${reference})` : `"${reference}"`;
  const bytes = new RegExp(`^\\$\\(wc\\s+-c\\s*<\\s*${byteTarget}\\s*\\)`);
  const ref = new RegExp(`^${reference}(?![A-Za-z0-9_])`);
  const body: ProbeFileLoop['body'] = [];
  for (const raw of match[4].split(';')) {
    const statement = raw.trim();
    if (cat.test(statement)) { body.push({ kind: 'cat' }); continue; }
    if (statement === 'echo') { body.push({ kind: 'echo', parts: [{ text: '' }] }); continue; }
    if (!statement.startsWith('echo ')) return null;
    const argument = statement.slice(5).trim();
    if (argument[1] === '-') return null;
    if (argument.startsWith("'") && argument.endsWith("'") && !argument.slice(1, -1).includes("'")) {
      body.push({ kind: 'echo', parts: [{ text: argument.slice(1, -1) }] });
      continue;
    }
    if (!argument.startsWith('"') || !argument.endsWith('"')) return null;
    let text = argument.slice(1, -1);
    const parts: Part[] = [];
    while (text) {
      const size = bytes.exec(text);
      const file = ref.exec(text);
      const substitution = size ?? file;
      if (substitution) {
        parts.push({ value: size ? 'bytes' : 'file' });
        text = text.slice(substitution[0].length);
        continue;
      }
      const literal = /^[^$`\\"]+/.exec(text);
      if (!literal) return null;
      parts.push({ text: literal[0] });
      text = text.slice(literal[0].length);
    }
    body.push({ kind: 'echo', parts });
  }
  if (!body.some((statement) => statement.kind === 'cat')) return null;
  return { kind: 'file-loop', directory, files: labels.map((label) => ({ label, path: path.resolve(directory, label) })), body, sources: match[4].split(';').map((source) => source.trim()) };
}
