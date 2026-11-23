// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const bashSchema: ToolSchema = {
  name: 'Bash',
  description: `Executes a bash command. Working directory persists across calls.
Command substitution \`$(...)\`, backticks, and process substitution are always refused; run the inner command as its own Bash call and reuse its output.

Returns: stdout/stderr (combined), exit code if non-zero, signal if terminated, background PIDs if started.

Prefer dedicated tools for file/search ops:
- File listing: Glob (instead of \`find\` / \`ls\`)
- Content search: Grep (instead of \`grep\` / \`rg\`)
- Read files: Read (instead of \`cat\` / \`head\` / \`tail\` / \`sed -n\`)
- Edit files: Edit (instead of \`sed\` / \`awk\`)
- Write files: Write (instead of \`echo >\` / \`cat <<EOF\`)

For everything else — scripts, git, build/install, CLIs on PATH (jq, ffmpeg, opencli, jina, mineru, pdftotext ...), or probing with \`which\` / \`<cli> --help\` — use Bash. When built-in tools fall short (anti-scraping responses, niche formats, structured data wrangling), fall back to Bash and explore. <env-capabilities> lists locally detected CLIs; check others with \`command -v X\`.

Git: never \`--force\` push, \`--no-verify\`, \`--no-gpg-sign\`, or change git config unless explicitly requested. Avoid \`commit --amend\` — only when the user asks for it or a pre-commit hook rewrote files, and never on a commit already pushed. Commit messages say why, not what. Before drafting a PR, read every commit on the branch, not just the last one.

A failed command tells you what to do next. A permission or workspace-scope denial will not pass on a retry — use request_directory or tell the user what access you need. A timeout means split the work or raise \`timeout\`. Never rerun an unchanged command hoping for a different result, and never report success on a non-zero exit.`,
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The command to execute',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in ms (default 120000, max 600000)',
      },
      working_directory: {
        type: 'string',
        description: 'Working directory for the command',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Run in background and return task_id immediately',
      },
      pty: {
        type: 'boolean',
        description: 'Use PTY for interactive commands (vim, ssh)',
      },
      cols: {
        type: 'number',
        description: 'PTY columns (default 80)',
      },
      rows: {
        type: 'number',
        description: 'PTY rows (default 24)',
      },
      wait_for_completion: {
        type: 'boolean',
        description: 'PTY mode: wait for completion before returning (default false)',
      },
      description: {
        type: 'string',
        description: 'One user-facing verb phrase explaining what this command does, in the same language as the conversation.',
      },
    },
    required: ['command'],
  },
  category: 'shell',
  permissionLevel: 'execute',
  pathAuthority: [{ kind: 'shell', commandParameter: 'command' }],
  readOnly: false,
  allowInPlanMode: false,
};
