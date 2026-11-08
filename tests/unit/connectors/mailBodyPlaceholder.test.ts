import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ runAppleScript: vi.fn() }));

vi.mock('../../../src/host/connectors/native/osascript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/connectors/native/osascript')>();
  return { ...actual, runAppleScript: mocks.runAppleScript };
});

import { mailConnector } from '../../../src/host/connectors/native/mail';

const PLACEHOLDER = '\uFFFC';
const READ_ARGS = { account: 'Work', mailbox: 'INBOX', message_id: 7 };

function mailLine(content: string, attachmentCount = 0, attachments = ''): string {
  return `7|Security alert|security@example.com|2026-11-03T22:15:30|true|${content}|${attachmentCount}|${attachments}`;
}

function resultContent(result: Awaited<ReturnType<typeof mailConnector.execute>>): string {
  return (result.data as { content: string }).content;
}

beforeEach(() => mocks.runAppleScript.mockReset());

describe('native Mail body placeholder handling', () => {
  it('judges a body containing only U+FFFC empty and uses the source fallback', async () => {
    mocks.runAppleScript
      .mockResolvedValueOnce(mailLine(PLACEHOLDER, 1, 'signin.png'))
      .mockResolvedValueOnce('Content-Type: text/plain; charset=utf-8\n\nNew device sign-in detected.');

    const result = await mailConnector.execute('read_message', READ_ARGS);

    expect(resultContent(result)).toBe('New device sign-in detected.');
    expect(mocks.runAppleScript).toHaveBeenCalledTimes(2);
    expect(mocks.runAppleScript.mock.calls[1][0].join('\n')).toContain('return source of msgRef');
  });

  it('drops U+FFFC and other zero-width placeholders while keeping mixed text', async () => {
    mocks.runAppleScript.mockResolvedValueOnce(mailLine(`Before${PLACEHOLDER}middle\u200B\u200C\u200D\u2060\uFEFFafter`));

    const result = await mailConnector.execute('read_message', READ_ARGS);

    expect(resultContent(result)).toBe('Beforemiddleafter');
    expect(mocks.runAppleScript).toHaveBeenCalledTimes(1);
  });

  it('leaves ordinary plain text byte-identical', async () => {
    const plain = 'Security mail body with spacing.';
    mocks.runAppleScript.mockResolvedValueOnce(mailLine(plain));

    const result = await mailConnector.execute('read_message', READ_ARGS);

    expect(resultContent(result)).toBe(plain);
    expect(mocks.runAppleScript).toHaveBeenCalledTimes(1);
  });

  it('prefers text/plain and decodes a simple quoted-printable source part', async () => {
    mocks.runAppleScript
      .mockResolvedValueOnce(mailLine(''))
      .mockResolvedValueOnce([
        'Content-Type: multipart/alternative; boundary="mail-boundary"',
        '',
        '--mail-boundary',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>HTML version</p>',
        '--mail-boundary',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'Plain=20version=21',
        '--mail-boundary--',
      ].join('\n'));

    const result = await mailConnector.execute('read_message', READ_ARGS);

    expect(resultContent(result)).toBe('Plain version!');
  });

  it('decodes a simple base64 text/plain source part', async () => {
    mocks.runAppleScript
      .mockResolvedValueOnce(mailLine(''))
      .mockResolvedValueOnce([
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        'U2VjdXJpdHkgYWxlcnQgYm9keQ==',
      ].join('\n'));

    const result = await mailConnector.execute('read_message', READ_ARGS);

    expect(resultContent(result)).toBe('Security alert body');
  });

  it('returns the explicit image/attachment notice when the source has no extractable text', async () => {
    mocks.runAppleScript
      .mockResolvedValueOnce(mailLine('', 2, 'photo.png; scan.pdf'))
      .mockResolvedValueOnce('Content-Type: text/plain; charset=utf-8\n\nSGVsbG8=');

    const result = await mailConnector.execute('read_message', READ_ARGS);

    expect(resultContent(result)).toBe('邮件正文是图片/附件，未能提取出文本。 附件：2 个 (photo.png, scan.pdf)');
  });
});
