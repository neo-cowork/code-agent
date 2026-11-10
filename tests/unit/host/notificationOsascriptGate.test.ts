// Static contract for the macOS osascript notification fallback and its host-side callers.
//
// Known limit: this text scan does not reconstruct string concatenation such as
// `\'display \' + \'notification\'`; that form is outside this gate's lexical contract.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type NotificationRule = 'display-notification' | 'host-native-notification-constructor';
type AllowlistEntry = Readonly<{ file: string; reason: string }>;
type ScanHit = Readonly<{
  file: string;
  line: number;
  rule: NotificationRule;
  text: string;
}>;

const DISPLAY_NOTIFICATION_PATTERN = /display\s+notification/i;
const HOST_NATIVE_NOTIFICATION_PATTERN = /new\s+Notification\s*\(/;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs']);

const ALLOWLIST = {
  'display-notification': [
    {
      file: 'src/host/platform/notifications.ts',
      reason:
        'Sole implementation of the macOS host-side fallback; the banner is attributed to Script Editor, so no new caller may use it for user-visible notices.',
    },
  ],
  'host-native-notification-constructor': [
    {
      file: 'src/host/platform/notifications.ts',
      reason:
        'Sole implementation of the macOS host-side fallback; the banner is attributed to Script Editor, so no new caller may use it for user-visible notices.',
    },
    {
      file: 'src/host/services/infra/notificationService.ts',
      reason:
        'Fallback B sender; osascript banners are attributed to Script Editor, and this is the single approved caller.',
    },
    {
      file: 'src/host/services/roleAssets/roleProactivity.ts',
      reason:
        'Dead branch in production: electron is aliased to electronMock.ts with isSupported() === false; Settings copy still promises realtime desktop notices, so a follow-up is needed.',
    },
  ],
} as const satisfies Record<NotificationRule, readonly AllowlistEntry[]>;

function isHostOrWebFile(relativePath: string): boolean {
  return relativePath.startsWith('src/host/') || relativePath.startsWith('src/web/');
}

function scanSourceText(relativePath: string, source: string): ScanHit[] {
  return source.split(/\r?\n/).flatMap((text, index) => {
    const line = index + 1;
    const hits: ScanHit[] = [];
    if (DISPLAY_NOTIFICATION_PATTERN.test(text)) {
      hits.push({ file: relativePath, line, rule: 'display-notification', text: text.trim() });
    }
    if (isHostOrWebFile(relativePath) && HOST_NATIVE_NOTIFICATION_PATTERN.test(text)) {
      hits.push({
        file: relativePath,
        line,
        rule: 'host-native-notification-constructor',
        text: text.trim(),
      });
    }
    return hits;
  });
}

function listSourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return listSourceFiles(fullPath);
    return entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [fullPath] : [];
  });
}

function scanRepository(): ScanHit[] {
  const srcRoot = path.resolve('src');
  return listSourceFiles(srcRoot).flatMap((file) => {
    const relativePath = path.relative(process.cwd(), file);
    return scanSourceText(relativePath, fs.readFileSync(file, 'utf8'));
  });
}

function isAllowlisted(hit: ScanHit): boolean {
  return ALLOWLIST[hit.rule].some((entry) => entry.file === hit.file);
}

function formatUnexpectedHits(hits: ScanHit[]): string {
  return hits.map((hit) => `${hit.file}:${hit.line} [${hit.rule}] ${hit.text}`).join('\n');
}

describe('osascript notification static gate', () => {
  it('rejects every repo hit outside the typed allowlist', () => {
    const unexpectedHits = scanRepository().filter((hit) => !isAllowlisted(hit));
    expect(
      unexpectedHits,
      `Unexpected notification call site(s):\n${formatUnexpectedHits(unexpectedHits)}`,
    ).toEqual([]);
  });

  it('detects the inline positive sample without requiring repository hits', () => {
    const hits = scanSourceText(
      'src/host/__inline-positive__.ts',
      `const banner = 'display notification "x"';\nnew Notification({ title: 'x' });`,
    );

    expect(hits.map(({ rule, line }) => ({ rule, line }))).toEqual([
      { rule: 'display-notification', line: 1 },
      { rule: 'host-native-notification-constructor', line: 2 },
    ]);
  });

  it('keeps the comment-free unrelated sample clean without requiring repository hits', () => {
    expect(scanSourceText('src/host/__inline-negative__.ts', "const value = 'unrelated string';")).toEqual([]);
  });
});
