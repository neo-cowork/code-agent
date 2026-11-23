import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { INTERACTION_TIMEOUTS } from '../../shared/constants/timeouts';
import type {
  OutboundDraftActionCode,
  OutboundDraftInboxItem,
} from '../../shared/contract/pendingApproval';
import { persistedToolCall } from '../runtime/ledgerToolExecution';
import { getAuthService } from '../services/auth';
import { getDatabase } from '../services/core/databaseService';
import type { InsertPendingApprovalInput, PendingApprovalRepository } from '../services/core/repositories/PendingApprovalRepository';
import { createLogger } from '../services/infra/logger';
import { isExternalSideEffectTool } from '../tools/externalSideEffect';
import { maskMailSendOutboundParams } from '../tools/outboundGuard';
import { hashLedgerFormArgs, parseParkedApprovalPayload } from './parkedApprovalSurvival';

const logger = createLogger('OutboundDraft');
const MAIL_SEND = 'mail_send';
const SEND_CLAIMED = 'OUTBOUND_DRAFT_SEND_CLAIMED';

type MailArgs = Record<string, unknown> & {
  subject: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  content?: string;
  attachments?: string[];
};

interface DraftPayload {
  tool: typeof MAIL_SEND;
  args: MailArgs;
  argsFingerprint: string;
  attachmentFingerprints: string[];
  attachmentBase: string;
  sessionId: string;
  scheduledTaskName?: string;
  createdAt: number;
  revision: string;
  needsReconfirm: boolean;
}

type PreparedOutboundDraft = InsertPendingApprovalInput & { payload: DraftPayload };

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim());
}

function isMailArgs(value: unknown): value is MailArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const args = value as Record<string, unknown>;
  return typeof args.subject === 'string' && !!args.subject.trim()
    && isStringList(args.to) && args.to.length > 0
    && [args.cc, args.bcc, args.attachments].every((list) => list === undefined || isStringList(list))
    && (args.content === undefined || typeof args.content === 'string');
}

function parseDraft(payloadJson: string): DraftPayload | null {
  try {
    const draft = JSON.parse(payloadJson) as Partial<DraftPayload> | null;
    if (draft?.tool !== MAIL_SEND || !isMailArgs(draft.args)
      || typeof draft.sessionId !== 'string' || typeof draft.revision !== 'string'
      || typeof draft.attachmentBase !== 'string' || !isStringList(draft.attachmentFingerprints)
      || typeof draft.argsFingerprint !== 'string' || typeof draft.needsReconfirm !== 'boolean'
      || (draft.scheduledTaskName !== undefined && typeof draft.scheduledTaskName !== 'string')) return null;
    return draft as DraftPayload;
  } catch {
    return null;
  }
}

async function attachmentFingerprints(args: MailArgs, base: string, staging?: string) {
  const digests: string[] = [];
  const stagedPaths: string[] = [];
  for (const [index, source] of (args.attachments ?? []).entries()) {
    const path = resolve(base, source.trim());
    // Never block on a named pipe, or read a device as an attachment.
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new Error('OUTBOUND_DRAFT_ATTACHMENT_NOT_FILE');
      const hash = createHash('sha256');
      const bytes = file.createReadStream({ autoClose: false });
      if (staging) {
        // Send the exact bytes we checked, even if the original changes while Mail opens it.
        const folder = join(staging, String(index));
        await mkdir(folder);
        const snapshot = join(folder, basename(path));
        await pipeline(bytes, new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            callback(null, chunk);
          },
        }), createWriteStream(snapshot, { mode: 0o600, flags: 'wx' }));
        stagedPaths.push(snapshot);
      } else {
        for await (const chunk of bytes) hash.update(chunk as Buffer);
      }
      digests.push(hash.digest('hex'));
    } finally {
      await file.close();
    }
  }
  return { digests, stagedPaths };
}

export async function prepareOutboundDraft(
  repo: PendingApprovalRepository,
  requestId: string,
  tool: string,
): Promise<PreparedOutboundDraft | undefined> {
  if (!isExternalSideEffectTool(tool) || tool !== MAIL_SEND) return;
  let failure = 'args_unavailable';
  try {
    const row = repo.getById(requestId);
    if (row?.kind !== 'tool_approval' || row.status !== 'pending') return;
    const payload = parseParkedApprovalPayload(row.payloadJson);
    const ref = payload?.argsRef;
    if (!ref || ref.sessionId !== payload.sessionId || payload.tool !== MAIL_SEND
      || payload.ledgerFaithful !== true) throw new Error(failure);
    const db = getDatabase();
    const call = persistedToolCall(db.getMessages(ref.sessionId), ref.toolCallId)?.toolCall;
    if (call?.name !== MAIL_SEND) throw new Error(failure);
    // The approval fingerprint is computed after the outbound mask. Keep only the approved shape.
    const args = maskMailSendOutboundParams(MAIL_SEND, call.arguments).params;
    const argsFingerprint = hashLedgerFormArgs(args);
    if (!isMailArgs(args) || argsFingerprint !== payload.argsFingerprint) throw new Error(failure);

    failure = 'attachment_unavailable';
    const attachmentBase = process.cwd();
    const { digests } = await attachmentFingerprints(args, attachmentBase);
    const createdAt = Date.now();
    const draft: DraftPayload = {
      tool: MAIL_SEND,
      args,
      argsFingerprint,
      attachmentFingerprints: digests,
      attachmentBase,
      sessionId: ref.sessionId,
      scheduledTaskName: payload.scheduledTaskName ?? db.getSession(ref.sessionId)?.origin?.name,
      createdAt,
      revision: randomUUID(),
      needsReconfirm: false,
    };
    return {
      id: randomUUID(),
      kind: 'outbound_draft',
      coordinatorId: ref.sessionId,
      agentId: null,
      agentName: null,
      submittedAt: createdAt,
      payload: draft,
    };
  } catch {
    logger.warn('Unattended mail draft could not be prepared', { requestId, reason: failure });
    return undefined;
  }
}

export function listOutboundDrafts(now = Date.now()): OutboundDraftInboxItem[] {
  const db = getDatabase();
  const repo = db.getPendingApprovalRepo();
  const userId = getAuthService().getCurrentUser()?.id ?? null;
  repo.expireOutboundDrafts(now - INTERACTION_TIMEOUTS.OUTBOUND_DRAFT_RETENTION, now);
  return repo.listByKindAndStatus('outbound_draft', 'pending').flatMap((row) => {
    if (!row.coordinatorId || !db.getSession(row.coordinatorId, { userId })) return [];
    const draft = parseDraft(row.payloadJson);
    if (draft?.sessionId !== row.coordinatorId) return [];
    const { args } = draft;
    return [{
      id: row.id,
      revision: draft.revision,
      scheduledTaskName: draft.scheduledTaskName,
      to: args.to,
      cc: args.cc ?? [],
      bcc: args.bcc ?? [],
      subject: args.subject,
      body: args.content ?? '',
      attachmentNames: (args.attachments ?? []).map((source) => basename(source.trim())),
      needsReconfirm: draft.needsReconfirm,
    }];
  });
}

export async function resolveOutboundDraft(
  id: string,
  action: 'send' | 'discard',
  revision?: string,
  now = Date.now(),
): Promise<OutboundDraftActionCode> {
  const db = getDatabase();
  const repo = db.getPendingApprovalRepo();
  const row = repo.getById(id);
  if (row?.kind !== 'outbound_draft' || !row.coordinatorId) return 'OUTBOUND_DRAFT_CLOSED';
  const userId = getAuthService().getCurrentUser()?.id ?? null;
  const session = db.getSession(row.coordinatorId, { userId });
  if (!session) return 'OUTBOUND_DRAFT_CLOSED';
  if (row.feedback === 'OUTBOUND_DRAFT_EXPIRED') return 'OUTBOUND_DRAFT_EXPIRED';
  if (row.status !== 'pending') return 'OUTBOUND_DRAFT_CLOSED';
  const close = (code: OutboundDraftActionCode) => (
    repo.transitionOutboundDraft(row, 'rejected', code, 'null', now) ? code : 'OUTBOUND_DRAFT_CLOSED'
  );
  if (now - row.submittedAt >= INTERACTION_TIMEOUTS.OUTBOUND_DRAFT_RETENTION) return close('OUTBOUND_DRAFT_EXPIRED');
  if (action === 'discard') return close('OUTBOUND_DRAFT_DISCARDED');

  const draft = parseDraft(row.payloadJson);
  if (!draft) return close('OUTBOUND_DRAFT_SEND_FAILED');
  if (draft.revision !== revision) return 'OUTBOUND_DRAFT_RECONFIRM';
  if (row.coordinatorId !== draft.sessionId) return close('OUTBOUND_DRAFT_SEND_FAILED');
  const claim = { ...row, status: 'approved' as const, feedback: `OUTBOUND_DRAFT_VERIFYING:${randomUUID()}` };
  if (!repo.transitionOutboundDraft(row, claim.status, claim.feedback, row.payloadJson, now)) {
    return 'OUTBOUND_DRAFT_CLOSED';
  }
  let staging: string | undefined;
  const reopen = (code: OutboundDraftActionCode, updated: DraftPayload) => (
    repo.transitionOutboundDraft(claim, 'pending', code, JSON.stringify({
      ...updated,
      revision: randomUUID(),
      needsReconfirm: true,
    }), now) ? code : 'OUTBOUND_DRAFT_CLOSED'
  );
  try {
    const args = maskMailSendOutboundParams(MAIL_SEND, draft.args).params as MailArgs;
    const argsFingerprint = hashLedgerFormArgs(args);
    let files;
    try {
      if (args.attachments?.length) staging = await mkdtemp(join(tmpdir(), 'neo-mail-'));
      files = await attachmentFingerprints(args, draft.attachmentBase, staging);
    } catch {
      return reopen('OUTBOUND_DRAFT_ATTACHMENT_UNAVAILABLE', draft);
    }
    const { digests, stagedPaths } = files;
    if (argsFingerprint !== draft.argsFingerprint || hashLedgerFormArgs(draft.args) !== draft.argsFingerprint
      || digests.length !== draft.attachmentFingerprints.length
      || digests.some((digest, index) => digest !== draft.attachmentFingerprints[index])) {
      return reopen('OUTBOUND_DRAFT_RECONFIRM', { ...draft, args, argsFingerprint, attachmentFingerprints: digests });
    }

    // A crash after this transition cannot cause another execution. Remove the draft body
    // before handing off to the connector. The tool ledger keeps the actual send outcome.
    const sendAt = Date.now();
    if (sendAt - row.submittedAt >= INTERACTION_TIMEOUTS.OUTBOUND_DRAFT_RETENTION) {
      return repo.transitionOutboundDraft(claim, 'rejected', 'OUTBOUND_DRAFT_EXPIRED', 'null', sendAt)
        ? 'OUTBOUND_DRAFT_EXPIRED' : 'OUTBOUND_DRAFT_CLOSED';
    }
    if (!repo.transitionOutboundDraft(claim, 'approved', SEND_CLAIMED, 'null', sendAt)) {
      return 'OUTBOUND_DRAFT_CLOSED';
    }
    let code: OutboundDraftActionCode = 'OUTBOUND_DRAFT_SEND_FAILED';
    try {
      const { ToolExecutor } = await import('../tools/toolExecutor');
      const executor = new ToolExecutor({
        forcePermissionHandler: true,
        requestPermission: async ({ tool }) => tool === MAIL_SEND
          ? { approved: true, approvalSource: 'user' }
          : { approved: false, denialSource: 'fail-closed' },
        workingDirectory: session.workingDirectory ?? draft.attachmentBase,
      });
      const result = await executor.execute(MAIL_SEND, {
        ...args,
        ...(args.attachments ? { attachments: stagedPaths } : {}),
      }, { sessionId: draft.sessionId, turnId: id, currentToolCallId: id });
      if (result.success) code = 'OUTBOUND_DRAFT_SENT';
    } catch {
      logger.warn('Outbound draft execution threw', { draftId: id });
    }
    repo.transitionOutboundDraft({ ...claim, feedback: SEND_CLAIMED, payloadJson: 'null' }, 'approved', code, 'null', Date.now());
    return code;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {
      logger.warn('Outbound draft attachment cleanup failed', { draftId: id });
    });
  }
}
