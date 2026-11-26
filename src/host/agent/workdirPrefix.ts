/** Model-visible working-directory preamble for sub-agent tasks, and its display-side inverse. */
export function withWorkdirPrefix(cwd: string, task: string): string {
  return `[工作目录: ${cwd}] 所有文件路径基于此目录。\n\n${task}`;
}

const WORKDIR_PREFIX_RE = /^\s*\[工作目录[:：][^\]]*\]\s*所有文件路径基于此目录。[ \t]*(?:\r?\n)*/;

/** Remove the injected preamble so cards/member views only show the user's task. */
export function stripWorkdirPrefix(text: string): string;
export function stripWorkdirPrefix(text: string | undefined): string | undefined;
export function stripWorkdirPrefix(text: string | undefined): string | undefined {
  return text?.replace(WORKDIR_PREFIX_RE, '');
}
