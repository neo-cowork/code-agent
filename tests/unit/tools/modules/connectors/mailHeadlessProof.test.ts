import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';

const mocks = vi.hoisted(() => ({
  runAppleScript: vi.fn(),
  getConnector: vi.fn(),
}));

vi.mock('../../../../../src/host/connectors/native/osascript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../src/host/connectors/native/osascript')>();
  return { ...actual, runAppleScript: mocks.runAppleScript };
});

vi.mock('../../../../../src/host/connectors', () => ({
  getConnectorRegistry: () => ({ get: mocks.getConnector }),
}));

import { mailConnector } from '../../../../../src/host/connectors/native/mail';
import { mailModule } from '../../../../../src/host/tools/modules/connectors/mail';

const PLACEHOLDER = '\uFFFC';
const NOTICE = '邮件正文是图片/附件，未能提取出文本。';
const READ_ARGS = {
  action: 'read_message',
  account: 'Work',
  mailbox: 'INBOX',
  message_id: 7,
};
const allowAll: CanUseToolFn = async () => ({ allow: true });

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(): ToolContext {
  return {
    sessionId: 'mail-headless-proof',
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
  } as unknown as ToolContext;
}

function readLine(
  content: string,
  attachmentCount = 0,
  attachments = '',
): string {
  return `7|Image-only|security@example.com|2026-11-03T22:15:30|true|${content}|${attachmentCount}|${attachments}`;
}

function sourceScriptCall(): string {
  return mocks.runAppleScript.mock.calls[1][0].join('\n');
}

async function run(args: Record<string, unknown>) {
  const handler = await mailModule.createHandler();
  return handler.execute(args, makeCtx(), allowAll);
}

function localEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

beforeEach(() => {
  mocks.runAppleScript.mockReset();
  mocks.getConnector.mockReset();
  mocks.getConnector.mockReturnValue(mailConnector);
});

describe('mailModule headless proof', () => {
  it('(i) read_message returns the image/attachment notice for placeholder-only body with no attachments', async () => {
    mocks.runAppleScript
      .mockResolvedValueOnce(readLine(`${PLACEHOLDER} \n \u200B`, 0))
      .mockResolvedValueOnce([
        'Content-Type: multipart/mixed; boundary="image-only"',
        '',
        '--image-only',
        'Content-Type: image/png',
        'Content-Transfer-Encoding: base64',
        '',
        'iVBORw0KGgo=',
        '--image-only--',
      ].join('\n'));

    const result = await run(READ_ARGS);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain(NOTICE);
      expect(result.output).not.toContain(PLACEHOLDER);
    }
    expect(mocks.runAppleScript).toHaveBeenCalledTimes(2);
    expect(sourceScriptCall()).toContain('return source of msgRef');
  });

  it('(ii) read_message includes the attachment suffix for placeholder-only body with attachments', async () => {
    mocks.runAppleScript
      .mockResolvedValueOnce(readLine(`${PLACEHOLDER}\n\u200B`, 2, 'photo.png; scan.pdf'))
      .mockResolvedValueOnce('Content-Type: image/png\n\nnot-text');

    const result = await run(READ_ARGS);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain(`${NOTICE} 附件：2 个 (photo.png, scan.pdf)`);
      expect(result.output).not.toContain(PLACEHOLDER);
    }
    expect(mocks.runAppleScript).toHaveBeenCalledTimes(2);
    expect(sourceScriptCall()).toContain('return source of msgRef');
  });

  it('(iii) read_message preserves an ordinary text body byte-identically', async () => {
    const body = 'Plain text body.\nSecond line with  two spaces.';
    mocks.runAppleScript.mockResolvedValueOnce(readLine(body));

    const result = await run(READ_ARGS);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain(body);
    expect(mocks.runAppleScript).toHaveBeenCalledTimes(1);
  });

  it('(iv) read_message returns text/plain text from the source fallback', async () => {
    mocks.runAppleScript
      .mockResolvedValueOnce(readLine(PLACEHOLDER))
      .mockResolvedValueOnce([
        'Content-Type: multipart/alternative; boundary="text-fallback"',
        '',
        '--text-fallback',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Source fallback text.',
        '--text-fallback--',
      ].join('\n'));

    const result = await run(READ_ARGS);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain('Source fallback text.');
    expect(mocks.runAppleScript).toHaveBeenCalledTimes(2);
    expect(sourceScriptCall()).toContain('return source of msgRef');
  });

  it('list_messages parses seven Chinese-system dates through the tool entry', async () => {
    const dates = [
      '2026年11月8日 星期日 07:13:46',
      '2026年11月8日 上午7:13:46',
      '2026年11月6日 星期五 22:06:52',
      '2026-11-08T07:13:46',
      '2026年11月7日 下午8:01:02',
      '2026年11月5日 中午12:00:00',
      '2026年11月4日 06:02:03',
    ];
    const expectedEpochs = [
      localEpoch(2026, 11, 8, 7, 13, 46),
      localEpoch(2026, 11, 8, 7, 13, 46),
      localEpoch(2026, 11, 6, 22, 6, 52),
      localEpoch(2026, 11, 8, 7, 13, 46),
      localEpoch(2026, 11, 7, 20, 1, 2),
      localEpoch(2026, 11, 5, 12, 0, 0),
      localEpoch(2026, 11, 4, 6, 2, 3),
    ];
    mocks.runAppleScript.mockResolvedValueOnce(dates
      .map((date, index) => `${index + 1}|Subject ${index + 1}|sender${index + 1}@example.com|${date}|true|false`)
      .join('\n'));

    const result = await run({ action: 'list_messages', account: 'Work', mailbox: 'INBOX', limit: 10 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const meta = result.meta as { messages: Array<{ receivedAtMs: number | null }>; receivedTimeParsed: boolean };
      const actualEpochs = meta.messages.map((message) => message.receivedAtMs);
      expect(actualEpochs).toEqual(expectedEpochs);
      expect(meta.receivedTimeParsed).toBe(true);
      expect(result.output.match(/^- #\d+/gm)).toHaveLength(7);
      expect(result.output).not.toContain('收信时间无法解析');
      for (const date of dates) expect(result.output).not.toContain(date);
      console.log(`[mailHeadlessProof] epoch samples expected=${expectedEpochs.slice(0, 2).join(',')} actual=${actualEpochs.slice(0, 2).join(',')}`);
    }
    expect(mocks.runAppleScript).toHaveBeenCalledTimes(1);
  });
});
