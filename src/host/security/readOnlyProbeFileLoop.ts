import path from 'path';

type Part = { text: string } | { value: 'file' | 'bytes' };
export interface ProbeFileLoop {
  kind: 'file-loop';
  directory: string;
  files: Array<{ label: string; path: string }>;
  body: Array<{ kind: 'cat' } | { kind: 'echo'; parts: Part[] }>;
  sources: string[];
  prefix?: string;
  regularFilesOnly?: boolean;
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
  let directoryText = match?.[1];
  let variable = match?.[2];
  let labelsText = match?.[3];
  let bodyText = match?.[4];
  let sourcesText = bodyText;
  let prefix: string | undefined;
  let regularFilesOnly = false;
  if (!match) {
    const assigned = /^\s*([\s\S]*?;\s*)?for\s+([a-z][a-z0-9_]*)\s+in\s+([^;]+);\s*do\s+([a-z][a-z0-9_]*)="([^"$`\\\r\n]+)\/(\$[a-z][a-z0-9_]*|\$\{[a-z][a-z0-9_]*\})";\s*if\s+\[\s+-f\s+"(\$[a-z][a-z0-9_]*|\$\{[a-z][a-z0-9_]*\})"\s*\];\s*then\s+([\s\S]+);\s*fi;\s*done\s*;?\s*$/.exec(command);
    if (!assigned || assigned[2] === assigned[4]) return null;
    const isReference = (value: string, name: string) => value === `$${name}` || value === `\${${name}}`;
    if (!isReference(assigned[6], assigned[2]) || !isReference(assigned[7], assigned[4])) return null;
    prefix = assigned[1]?.trim();
    directoryText = `"${assigned[5]}"`;
    variable = assigned[2];
    labelsText = assigned[3];
    const catPath = new RegExp(`^cat\\s+(?:--\\s+)?"(?:\\$${assigned[4]}|\\$\\{${assigned[4]}\\})"$`);
    sourcesText = assigned[8];
    bodyText = assigned[8].split(';').map((statement) => catPath.test(statement.trim()) ? `cat "$${variable}"` : statement).join(';');
    regularFilesOnly = true;
  }
  if (!directoryText || !variable || !labelsText || !bodyText) return null;
  const directories = literalWords(directoryText, home);
  const labels = literalWords(labelsText, home);
  if (directories?.length !== 1 || !path.isAbsolute(directories[0]) || !labels?.length || labels.length > 64) return null;
  if (labels.some((label) => label.startsWith('-'))) return null;
  const directory = path.resolve(directories[0]);
  const reference = `(?:\\$${variable}|\\$\\{${variable}\\})`;
  const cat = new RegExp(`^cat\\s+(?:--\\s+)?"${reference}"$`);
  const byteTarget = labels.every((label) => /^[A-Za-z0-9_./~-]+$/.test(label))
    ? `(?:"${reference}"|${reference})` : `"${reference}"`;
  const bytes = new RegExp(`^\\$\\(wc\\s+-c\\s*<\\s*${byteTarget}\\s*\\)`);
  const ref = new RegExp(`^${reference}(?![A-Za-z0-9_])`);
  const body: ProbeFileLoop['body'] = [];
  for (const raw of bodyText.split(';')) {
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
  return { kind: 'file-loop', directory, files: labels.map((label) => ({ label, path: regularFilesOnly ? path.resolve(`${directory}/${label}`) : path.resolve(directory, label) })), body, sources: (sourcesText ?? bodyText).split(';').map((source) => source.trim()), prefix, regularFilesOnly };
}
