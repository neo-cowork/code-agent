import { describe, expect, it } from 'vitest';
import { resolveBackgroundTaskName } from '../../../../src/host/tools/shell/backgroundTasks';

const CURL = 'curl -s -m 5 -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:8899/ ; echo "--done"';

describe('resolveBackgroundTaskName', () => {
  it('keeps a usable description', () => {
    expect(resolveBackgroundTaskName('检查 8899 端口', CURL)).toBe('检查 8899 端口');
  });
  it('curl title from feedback FB-1171 => host:port, never the raw command', () => {
    const name = resolveBackgroundTaskName(undefined, CURL);
    expect(name).toBe('127.0.0.1:8899');
    expect(name).not.toContain('curl');
  });
  it('multi-line script => executable basename', () => {
    expect(resolveBackgroundTaskName('line1\nline2', 'cd /tmp/x && ./scripts/run-tests.sh --all\necho done')).toBe('run-tests.sh');
  });
  it('python http.server => python3', () => {
    expect(resolveBackgroundTaskName('', 'python3 -m http.server 8899')).toBe('python3');
  });
  it('skips sudo/env wrappers', () => {
    expect(resolveBackgroundTaskName(undefined, 'sudo env FOO=1 /usr/local/bin/node server.js')).toBe('node');
  });
  it('empty command => generic name', () => {
    expect(resolveBackgroundTaskName(undefined, '')).toBe('Background task');
  });
  it('>60-char description is not used', () => {
    const name = resolveBackgroundTaskName('x'.repeat(61), 'npm run dev -- --port 3000');
    expect(name).toBe('npm');
  });
  it.each([
    ['sudo -u nobody env -u SECRET /usr/bin/python3 -m http.server 8899', 'python3'],
    ['sandbox-exec -f /tmp/profile.sb /bin/sh -c "python3 -m http.server 8899"', 'python3'],
    ['sandbox-exec -f /tmp/profile.sb /usr/local/bin/python3 -m http.server 8899', 'python3'],
    ['# service check\ncd /tmp\npython3 -m http.server 8899\necho done', 'python3'],
    ['cd "/tmp/a;b" && ./scripts/check.sh 2>/tmp/result | cat; echo done', 'check.sh'],
    ['echo done', 'Background task'],
    ['curl https://user:password@example.test:8899/private?token=hidden', 'example.test:8899'],
  ])('derives a target without wrapper arguments or command tails: %s', (command, name) => {
    expect(resolveBackgroundTaskName(undefined, command)).toBe(name);
  });
  it('limits fallback names to 40 characters', () => {
    expect(resolveBackgroundTaskName(undefined, './' + 'x'.repeat(80))).toBe('x'.repeat(40));
  });

});
