// ============================================================================
// Native Mail Connector - macOS Mail via AppleScript
// ============================================================================

import fs from 'fs';
import type { Connector, ConnectorExecutionResult, ConnectorStatus } from '../base';
import {
  describeAppleScriptFailure,
  escapeAppleScriptString,
  isAppleScriptFailure,
  parseAppleScriptDate,
  runAppleScript,
  sharedAppleScriptHandlers,
} from './osascript';

interface MailAccountItem {
  name: string;
}

interface MailboxItem {
  account: string;
  name: string;
}

interface MailMessageSummary {
  id: number;
  account?: string;
  mailbox?: string;
  subject: string;
  sender: string;
  receivedAtMs: number | null;
  read: boolean;
}

interface MailMessageDetail extends MailMessageSummary {
  content: string;
  attachments?: string[];
  attachmentCount?: number;
}

interface MailDraftItem {
  subject: string;
  to: string[];
  cc: string[];
  bcc: string[];
  attachments: string[];
  saved: boolean;
}

interface MailSentItem extends MailDraftItem {
  sent: boolean;
}

type NativeReadiness = 'unchecked' | 'ready' | 'failed' | 'unavailable';

function initialMailReadiness(): NativeReadiness {
  return process.platform === 'darwin' ? 'unchecked' : 'unavailable';
}

let mailReadiness: NativeReadiness = initialMailReadiness();
let mailProbeError: string | undefined;
let mailProbeCheckedAt: number | undefined;
// 最近一次探测拿到的账户列表是否为空（授权通过但 Mail 无账号）——getStatus 的
// ready 分支作为 noAccessibleItems 结构化信号下发，渲染层不做文案匹配
let mailProbeListEmpty = false;

export function resetMailConnectorReadiness(): void {
  mailReadiness = initialMailReadiness();
  mailProbeError = undefined;
  mailProbeCheckedAt = undefined;
  mailProbeListEmpty = false;
}

function parseLine(line: string): string[] {
  return line.split('|').map((part) => part.trim());
}

function errorMessage(error: unknown): string {
  return isAppleScriptFailure(error)
    ? describeAppleScriptFailure('Mail', error).message
    : error instanceof Error ? error.message : String(error);
}

function buildMailStatus(capabilities: string[]): ConnectorStatus {
  if (process.platform !== 'darwin') {
    return {
      connected: false,
      readiness: 'unavailable',
      detail: 'Mail connector 仅在 macOS 可用。',
      actions: [],
      capabilities,
    };
  }

  if (mailReadiness === 'ready') {
    return {
      connected: true,
      readiness: 'ready',
      checkedAt: mailProbeCheckedAt,
      detail: 'Mail connector 已通过本地授权/可用性检查。',
      noAccessibleItems: mailProbeListEmpty,
      actions: ['disconnect', 'remove'],
      capabilities,
    };
  }

  if (mailReadiness === 'failed') {
    return {
      connected: false,
      readiness: 'failed',
      error: mailProbeError,
      checkedAt: mailProbeCheckedAt,
      detail: `Mail 授权/可用性检查失败：${mailProbeError || '未知错误'}`,
      actions: ['repair_permissions', 'disconnect', 'remove'],
      capabilities,
    };
  }

  return {
    connected: false,
    readiness: 'unchecked',
    detail: 'Mail connector 已启用，但还未检查本地授权；点“检查/授权”时才会拉起 Mail 或触发系统授权。',
    actions: ['repair_permissions', 'disconnect', 'remove'],
    capabilities,
  };
}

function normalizeAddressList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(/[,\n;]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function appleScriptAddressList(addresses: string[]): string {
  return `{${addresses.map((item) => `"${escapeAppleScriptString(item)}"`).join(', ')}}`;
}

function normalizeAttachmentList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

function parseAttachmentNames(value: string): string[] {
  return value
    .split(/\s*;\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const MAIL_BODY_PLACEHOLDER_PATTERN = /(?:\uFFFC|\u200B|\u200C|\u200D|\u2060|\uFEFF)/g;
const MAX_EXTRACTED_MAIL_BODY_LENGTH = 50_000;
const EMPTY_MAIL_BODY_NOTICE = '邮件正文是图片/附件，未能提取出文本。';

function stripMailBodyPlaceholders(value: string): string {
  return value.replace(MAIL_BODY_PLACEHOLDER_PATTERN, '');
}

function hasVisibleMailBodyText(value: string): boolean {
  return stripMailBodyPlaceholders(value).trim().length > 0;
}

interface MimePart {
  headers: Record<string, string>;
  body: string;
}

function parseMimePart(raw: string): MimePart {
  const separator = raw.match(/\r?\n\r?\n/);
  if (separator?.index === undefined) return { headers: {}, body: raw };

  const headerText = raw.slice(0, separator.index);
  const headers: Record<string, string> = {};
  let currentHeader = '';
  for (const line of headerText.split(/\r?\n/)) {
    if (/^\s/.test(line) && currentHeader) {
      headers[currentHeader] = `${headers[currentHeader]} ${line.trim()}`;
      continue;
    }
    const match = line.match(/^([^:\s]+):\s*(.*)$/);
    if (!match) continue;
    currentHeader = match[1].toLowerCase();
    headers[currentHeader] = match[2];
  }

  return Object.keys(headers).length > 0
    ? { headers, body: raw.slice(separator.index + separator[0].length) }
    : { headers: {}, body: raw };
}

function mimeBoundary(contentType: string): string | undefined {
  const match = contentType.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
  return match?.[1] || match?.[2];
}

function collectMimeTextParts(raw: string, parts: MimePart[]): void {
  const part = parseMimePart(raw);
  const contentType = part.headers['content-type'] || '';
  if (/^multipart\//i.test(contentType)) {
    const boundary = mimeBoundary(contentType);
    if (!boundary) return;
    for (const segment of part.body.split(`--${boundary}`)) {
      const child = segment.replace(/^\r?\n/, '');
      if (!child || child.startsWith('--')) continue;
      collectMimeTextParts(child, parts);
    }
    return;
  }
  if (/^text\/(?:plain|html)\b/i.test(contentType)) parts.push(part);
}

function mimeCharset(contentType: string): string {
  const match = contentType.match(/charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
  const charset = (match?.[1] || match?.[2] || 'utf-8').trim().toLowerCase();
  return /^(?:gbk|gb2312|gb18030|cp936)$/.test(charset) ? 'gb18030' : charset;
}

function decodeMimeBytes(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return '';
  }
}

function decodeQuotedPrintable(value: string, charset: string): string {
  const withoutSoftBreaks = value.replace(/=[\r\n]+/g, '');
  const bytes: number[] = [];
  for (let index = 0; index < withoutSoftBreaks.length;) {
    const encoded = withoutSoftBreaks.slice(index).match(/^=([0-9a-f]{2})/i);
    if (encoded) {
      bytes.push(Number.parseInt(encoded[1], 16));
      index += 3;
    } else {
      const character = withoutSoftBreaks[index];
      bytes.push(...Buffer.from(character));
      index += 1;
    }
  }
  return decodeMimeBytes(Buffer.from(bytes), charset);
}

function decodeMimeBody(value: string, transferEncoding: string, charset: string): string {
  if (/quoted-printable/i.test(transferEncoding)) return decodeQuotedPrintable(value, charset);
  if (!/base64/i.test(transferEncoding)) return value;

  const compact = value.replace(/\s+/g, '');
  if (!compact || compact.length % 4 === 1 || !/^[a-z0-9+/]*={0,2}$/i.test(compact)) return '';
  return decodeMimeBytes(Buffer.from(compact, 'base64'), charset);
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    const codePoint = name.toLowerCase().startsWith('#x')
      ? Number.parseInt(name.slice(2), 16)
      : name.startsWith('#') ? Number.parseInt(name.slice(1), 10) : undefined;
    if (codePoint !== undefined && Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF) {
      return String.fromCodePoint(codePoint);
    }
    return named[name.toLowerCase()] ?? entity;
  });
}

function visibleMimeText(value: string, contentType: string): string {
  const withoutMarkup = /^text\/html\b/i.test(contentType)
    ? value
      .replace(/<\s*(?:script|style)[^>]*>[\s\S]*?<\s*\/\s*(?:script|style)\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
    : value;
  return stripMailBodyPlaceholders(decodeHtmlEntities(withoutMarkup)).replace(/\s+/g, ' ').trim();
}

function looksLikeMimeNoise(value: string): boolean {
  if (/^(?:content-(?:type|transfer-encoding|disposition)|mime-version|boundary):/im.test(value)) return true;
  const compact = value.replace(/\s+/g, '');
  if (compact.length < 8 || !/^[a-z0-9+/]+={0,2}$/i.test(compact)) return false;
  return compact.includes('=') || (compact.length >= 32 && /[0-9+/]/.test(compact));
}

function extractMailSourceText(source: string): string {
  const textParts: MimePart[] = [];
  collectMimeTextParts(source, textParts);
  const orderedParts = [
    ...textParts.filter((part) => /^text\/plain\b/i.test(part.headers['content-type'] || '')),
    ...textParts.filter((part) => /^text\/html\b/i.test(part.headers['content-type'] || '')),
  ];

  for (const part of orderedParts) {
    const decoded = decodeMimeBody(
      part.body,
      part.headers['content-transfer-encoding'] || '',
      mimeCharset(part.headers['content-type'] || ''),
    );
    const visible = visibleMimeText(decoded, part.headers['content-type'] || '');
    if (visible && !looksLikeMimeNoise(visible)) return visible.slice(0, MAX_EXTRACTED_MAIL_BODY_LENGTH);
  }

  const root = parseMimePart(source);
  if (Object.keys(root.headers).length > 0) return '';
  const visible = visibleMimeText(source, 'text/plain');
  return visible && !looksLikeMimeNoise(visible)
    ? visible.slice(0, MAX_EXTRACTED_MAIL_BODY_LENGTH)
    : '';
}

function emptyMailBodyNotice(attachmentCount: number, attachments: string[]): string {
  if (attachmentCount <= 0 && attachments.length === 0) return EMPTY_MAIL_BODY_NOTICE;
  const count = attachmentCount > 0 ? attachmentCount : attachments.length;
  const names = attachments.length > 0 ? ` (${attachments.join(', ')})` : '';
  return `${EMPTY_MAIL_BODY_NOTICE} 附件：${count} 个${names}`;
}

async function readMessageSource(
  mailboxName: string,
  accountName: string,
  messageId: number,
): Promise<string> {
  const lines = [
    ...sharedAppleScriptHandlers(),
    'tell application "Mail"',
  ];
  if (accountName) {
    lines.push(`set targetMailbox to mailbox "${escapeAppleScriptString(mailboxName)}" of account "${escapeAppleScriptString(accountName)}"`);
  } else {
    lines.push(`set targetMailbox to mailbox "${escapeAppleScriptString(mailboxName)}"`);
  }
  lines.push(
    `set msgRef to first message of targetMailbox whose id is ${Math.floor(messageId)}`,
    'return source of msgRef',
    'end tell',
  );
  try {
    return await runAppleScript(lines);
  } catch {
    return '';
  }
}

async function listAccounts(): Promise<MailAccountItem[]> {
  const output = await runAppleScript([
    ...sharedAppleScriptHandlers(),
    'tell application "Mail"',
    'set outputLines to {}',
    'repeat with acc in every account',
    'set end of outputLines to my sanitizeText(name of acc)',
    'end repeat',
    'return my joinLines(outputLines)',
    'end tell',
  ]);

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => ({ name }));
}

async function probeMailAccess(): Promise<MailAccountItem[]> {
  if (process.platform !== 'darwin') {
    mailReadiness = 'unavailable';
    mailProbeCheckedAt = Date.now();
    mailProbeError = 'Mail connector 仅在 macOS 可用。';
    throw new Error(mailProbeError);
  }

  try {
    const accounts = await listAccounts();
    mailReadiness = 'ready';
    mailProbeCheckedAt = Date.now();
    mailProbeError = undefined;
    mailProbeListEmpty = accounts.length === 0;
    return accounts;
  } catch (error) {
    mailReadiness = 'failed';
    mailProbeCheckedAt = Date.now();
    mailProbeError = errorMessage(error);
    throw error;
  }
}

async function listMailboxes(payload: Record<string, unknown>): Promise<MailboxItem[]> {
  const accountName = typeof payload.account === 'string' ? payload.account.trim() : '';
  const lines = [
    ...sharedAppleScriptHandlers(),
    'tell application "Mail"',
    'set outputLines to {}',
  ];

  if (accountName) {
    lines.push(`set targetAccounts to {account "${escapeAppleScriptString(accountName)}"}`);
  } else {
    lines.push('set targetAccounts to every account');
  }

  lines.push(
    'repeat with acc in targetAccounts',
    'repeat with box in every mailbox of acc',
    'set end of outputLines to (my sanitizeText(name of acc)) & "|" & (my sanitizeText(name of box))',
    'end repeat',
    'end repeat',
    'return my joinLines(outputLines)',
    'end tell'
  );

  const output = await runAppleScript(lines);
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [account, name] = parseLine(line);
      return { account, name };
    });
}

async function listMessages(payload: Record<string, unknown>): Promise<MailMessageSummary[]> {
  const mailboxName = typeof payload.mailbox === 'string' ? payload.mailbox.trim() : '';
  const accountName = typeof payload.account === 'string' ? payload.account.trim() : '';
  const query = typeof payload.query === 'string' ? payload.query.trim().toLowerCase() : '';
  const limit = typeof payload.limit === 'number' ? payload.limit : 10;
  const scanLimit = typeof payload.scan_limit === 'number'
    ? payload.scan_limit
    : Math.max(limit * (query ? 10 : 2), 25);

  if (!mailboxName) {
    throw new Error('mailbox is required for list_messages');
  }

  const lines = [
    ...sharedAppleScriptHandlers(),
    'tell application "Mail"',
  ];

  if (accountName) {
    lines.push(`set targetMailbox to mailbox "${escapeAppleScriptString(mailboxName)}" of account "${escapeAppleScriptString(accountName)}"`);
  } else {
    lines.push(`set targetMailbox to mailbox "${escapeAppleScriptString(mailboxName)}"`);
  }

  lines.push(
    'set msgRefs to messages of targetMailbox',
    'set msgCount to count of msgRefs',
    'set outputLines to {}',
    `set scanLimit to ${Math.max(1, Math.floor(scanLimit))}`,
    'repeat with idx from 1 to msgCount',
    'if idx > scanLimit then exit repeat',
    'set msgRef to item idx of msgRefs',
    'set msgLine to (id of msgRef as text) & "|" & (my sanitizeText(subject of msgRef)) & "|" & (my sanitizeText(sender of msgRef)) & "|" & (my isoDateText(date received of msgRef)) & "|" & (read status of msgRef as text)',
    'set end of outputLines to msgLine',
    'end repeat',
    'return my joinLines(outputLines)',
    'end tell'
  );

  const output = await runAppleScript(lines);
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [idRaw, subject, sender, receivedRaw, readRaw] = parseLine(line);
      return {
        id: Number(idRaw),
        account: accountName || undefined,
        mailbox: mailboxName,
        subject,
        sender,
        receivedAtMs: parseAppleScriptDate(receivedRaw),
        read: readRaw === 'true',
      } satisfies MailMessageSummary;
    })
    .filter((item) => !query || item.subject.toLowerCase().includes(query) || item.sender.toLowerCase().includes(query))
    .slice(0, limit);
}

async function readMessage(payload: Record<string, unknown>): Promise<MailMessageDetail> {
  const mailboxName = typeof payload.mailbox === 'string' ? payload.mailbox.trim() : '';
  const accountName = typeof payload.account === 'string' ? payload.account.trim() : '';
  const messageId = typeof payload.message_id === 'number' ? payload.message_id : NaN;

  if (!mailboxName) {
    throw new Error('mailbox is required for read_message');
  }
  if (!Number.isFinite(messageId)) {
    throw new Error('message_id is required for read_message');
  }

  const lines = [
    ...sharedAppleScriptHandlers(),
    'tell application "Mail"',
  ];

  if (accountName) {
    lines.push(`set targetMailbox to mailbox "${escapeAppleScriptString(mailboxName)}" of account "${escapeAppleScriptString(accountName)}"`);
  } else {
    lines.push(`set targetMailbox to mailbox "${escapeAppleScriptString(mailboxName)}"`);
  }

  lines.push(
    `set msgRef to first message of targetMailbox whose id is ${Math.floor(messageId)}`,
    'set attachmentNames to {}',
    'try',
    'repeat with attachmentItem in mail attachments of msgRef',
    'set end of attachmentNames to my sanitizeText(name of attachmentItem)',
    'end repeat',
    'end try',
    'set {oldTID, AppleScript\'s text item delimiters} to {AppleScript\'s text item delimiters, "; "}',
    'set attachmentText to attachmentNames as text',
    'set AppleScript\'s text item delimiters to oldTID',
    'return (id of msgRef as text) & "|" & (my sanitizeText(subject of msgRef)) & "|" & (my sanitizeText(sender of msgRef)) & "|" & (my isoDateText(date received of msgRef)) & "|" & (read status of msgRef as text) & "|" & (my sanitizeText(content of msgRef)) & "|" & (count of attachmentNames as text) & "|" & (my sanitizeText(attachmentText))',
    'end tell'
  );

  const output = await runAppleScript(lines);
  const [idRaw, subject, sender, receivedRaw, readRaw, content, attachmentCountRaw, attachmentNamesRaw] = parseLine(output);
  const attachmentCount = Number(attachmentCountRaw);
  const attachments = parseAttachmentNames(attachmentNamesRaw || '');
  const parsedAttachmentCount = Number.isFinite(attachmentCount) ? attachmentCount : attachments.length;
  let body = stripMailBodyPlaceholders(content);
  if (!hasVisibleMailBodyText(body)) {
    const source = await readMessageSource(mailboxName, accountName, messageId);
    body = extractMailSourceText(source) || emptyMailBodyNotice(parsedAttachmentCount, attachments);
  }
  return {
    id: Number(idRaw),
    account: accountName || undefined,
    mailbox: mailboxName,
    subject,
    sender,
    receivedAtMs: parseAppleScriptDate(receivedRaw),
    read: readRaw === 'true',
    content: body,
    attachmentCount: parsedAttachmentCount,
    attachments,
  };
}

async function draftMessage(payload: Record<string, unknown>): Promise<MailDraftItem> {
  const subject = typeof payload.subject === 'string' ? payload.subject.trim() : '';
  const content = typeof payload.content === 'string' ? payload.content : '';
  const to = normalizeAddressList(payload.to);
  const cc = normalizeAddressList(payload.cc);
  const bcc = normalizeAddressList(payload.bcc);
  const attachments = normalizeAttachmentList(payload.attachments)
    .filter((item) => fs.existsSync(item));

  if (!subject) {
    throw new Error('subject is required for draft_message');
  }
  if (to.length === 0) {
    throw new Error('to is required for draft_message');
  }

  const lines = [
    ...sharedAppleScriptHandlers(),
    `set toAddresses to ${appleScriptAddressList(to)}`,
    `set ccAddresses to ${appleScriptAddressList(cc)}`,
    `set bccAddresses to ${appleScriptAddressList(bcc)}`,
    `set attachmentPaths to ${appleScriptAddressList(attachments)}`,
    'tell application "Mail"',
    `set newMessage to make new outgoing message with properties {visible:false, subject:"${escapeAppleScriptString(subject)}", content:"${escapeAppleScriptString(content)}"}`,
    'tell newMessage',
    'repeat with addr in toAddresses',
    'make new to recipient at end of to recipients with properties {address:addr}',
    'end repeat',
    'repeat with addr in ccAddresses',
    'make new cc recipient at end of cc recipients with properties {address:addr}',
    'end repeat',
    'repeat with addr in bccAddresses',
    'make new bcc recipient at end of bcc recipients with properties {address:addr}',
    'end repeat',
    'repeat with attachmentPath in attachmentPaths',
    'make new attachment with properties {file name:(POSIX file attachmentPath as alias)} at after the last paragraph',
    'end repeat',
    'save',
    'end tell',
    'return my sanitizeText(subject of newMessage)',
    'end tell',
  ];

  const output = await runAppleScript(lines);
  return {
    subject: output || subject,
    to,
    cc,
    bcc,
    attachments,
    saved: true,
  };
}

async function sendMessage(payload: Record<string, unknown>): Promise<MailSentItem> {
  const subject = typeof payload.subject === 'string' ? payload.subject.trim() : '';
  const content = typeof payload.content === 'string' ? payload.content : '';
  const to = normalizeAddressList(payload.to);
  const cc = normalizeAddressList(payload.cc);
  const bcc = normalizeAddressList(payload.bcc);
  const attachments = normalizeAttachmentList(payload.attachments)
    .filter((item) => fs.existsSync(item));

  if (!subject) {
    throw new Error('subject is required for send_message');
  }
  if (to.length === 0) {
    throw new Error('to is required for send_message');
  }

  await runAppleScript([
    ...sharedAppleScriptHandlers(),
    `set toAddresses to ${appleScriptAddressList(to)}`,
    `set ccAddresses to ${appleScriptAddressList(cc)}`,
    `set bccAddresses to ${appleScriptAddressList(bcc)}`,
    `set attachmentPaths to ${appleScriptAddressList(attachments)}`,
    'tell application "Mail"',
    `set newMessage to make new outgoing message with properties {visible:false, subject:"${escapeAppleScriptString(subject)}", content:"${escapeAppleScriptString(content)}"}`,
    'tell newMessage',
    'repeat with addr in toAddresses',
    'make new to recipient at end of to recipients with properties {address:addr}',
    'end repeat',
    'repeat with addr in ccAddresses',
    'make new cc recipient at end of cc recipients with properties {address:addr}',
    'end repeat',
    'repeat with addr in bccAddresses',
    'make new bcc recipient at end of bcc recipients with properties {address:addr}',
    'end repeat',
    'repeat with attachmentPath in attachmentPaths',
    'make new attachment with properties {file name:(POSIX file attachmentPath as alias)} at after the last paragraph',
    'end repeat',
    'send',
    'end tell',
    'end tell',
  ]);

  return {
    subject,
    to,
    cc,
    bcc,
    attachments,
    saved: false,
    sent: true,
  };
}

export const mailConnector: Connector = {
  id: 'mail',
  label: 'Mail',
  capabilities: ['get_status', 'list_accounts', 'list_mailboxes', 'list_messages', 'read_message', 'draft_message', 'send_message'],
  getCachedStatus(): ConnectorStatus {
    return buildMailStatus(this.capabilities);
  },
  async getStatus(): Promise<ConnectorStatus> {
    return buildMailStatus(this.capabilities);
  },
  async execute(action: string, payload: Record<string, unknown>): Promise<ConnectorExecutionResult> {
    switch (action) {
      case 'get_status':
        return { data: await this.getStatus() };
      case 'probe_access': {
        const accounts = await probeMailAccess();
        return {
          data: await this.getStatus(),
          summary: accounts.length > 0
            ? `Mail 授权/可用性检查通过，可访问 ${accounts.length} 个账户`
            : 'Mail 授权/可用性检查通过，但没有找到可访问的邮件账户',
        };
      }
      case 'repair_permissions': {
        resetMailConnectorReadiness();
        const accounts = await probeMailAccess();
        return {
          data: await this.getStatus(),
          summary: accounts.length > 0
            ? `Mail 权限修复检查通过，可访问 ${accounts.length} 个账户`
            : 'Mail 权限修复检查通过，但没有找到可访问的邮件账户',
        };
      }
      case 'disconnect':
      case 'remove':
        resetMailConnectorReadiness();
        return {
          data: await this.getStatus(),
          summary: action === 'disconnect' ? 'Mail connector 已断开。' : 'Mail connector 已移除。',
        };
      case 'list_accounts': {
        const accounts = await listAccounts();
        return {
          data: accounts,
          summary: accounts.length > 0 ? `找到 ${accounts.length} 个邮件账户` : '没有找到可访问的邮件账户',
        };
      }
      case 'list_mailboxes': {
        const mailboxes = await listMailboxes(payload);
        return {
          data: mailboxes,
          summary: mailboxes.length > 0 ? `找到 ${mailboxes.length} 个邮箱` : '没有找到可访问的邮箱',
        };
      }
      case 'list_messages': {
        const messages = await listMessages(payload);
        return {
          data: messages,
          summary: messages.length > 0 ? `找到 ${messages.length} 封邮件` : '没有找到匹配的邮件',
        };
      }
      case 'read_message': {
        const message = await readMessage(payload);
        return {
          data: message,
          summary: `读取邮件：${message.subject}`,
        };
      }
      case 'draft_message': {
        const draft = await draftMessage(payload);
        return {
          data: draft,
          summary: `已创建邮件草稿：${draft.subject}`,
        };
      }
      case 'send_message': {
        const message = await sendMessage(payload);
        return {
          data: message,
          summary: `已发送邮件：${message.subject}`,
        };
      }
      default:
        throw new Error(`Unsupported mail action: ${action}`);
    }
  },
};
