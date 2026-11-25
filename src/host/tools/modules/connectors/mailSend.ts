// ============================================================================
// MailSend (P0-6.3 Batch 4 — connectors: native ToolModule rewrite)
//
// 旧版: src/host/tools/connectors/mailSend.ts (legacy Tool + wrapLegacyTool)
// ============================================================================

import { getHostUiLocale } from '../../../config/hostUiLocale';
import { getHostConnectorCopy } from '../../../../shared/i18n/hostConnectorCopy';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { getConnectorRegistry } from '../../../connectors';
import { formatConnectorUnavailableMessage } from './connectorStatusText';
import { createFailedReceiptArtifact, createVirtualArtifact } from '../../artifacts/artifactMeta';
import { appleScriptFailureForDisplay, describeAppleScriptWriteFailure } from './appleScriptWriteFailure';
import { shouldLogMailFailureDetail } from '../../outboundGuard';
import { mailSendSchema as schema } from './mailSend.schema';

async function executeMailSend(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  if (typeof args.subject !== 'string' || args.subject.length === 0) {
    return { ok: false, error: 'subject must be a non-empty string', code: 'INVALID_ARGS' };
  }
  if (!Array.isArray(args.to) || args.to.length === 0) {
    return { ok: false, error: 'to must be a non-empty array of strings', code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const connector = getConnectorRegistry().get('mail');
  if (!connector) {
    return { ok: false, error: formatConnectorUnavailableMessage('mail', 'send'), code: 'NOT_INITIALIZED' };
  }

  const locale = getHostUiLocale();
  const { separator, mail: copy, appleScriptFailure } = getHostConnectorCopy(locale);
  try {
    const result = await connector.execute('send_message', args);
    const sent = result.data as {
      subject: string;
      to: string[];
      cc: string[];
      bcc: string[];
      attachments: string[];
      sent: boolean;
    };
    ctx.logger.debug('mail_send', { subject: sent.subject, toCount: sent.to.length });
    const output = [
      `${copy.sent}${separator}${sent.subject}`,
      `To: ${sent.to.join(', ')}`,
      sent.cc.length > 0 ? `CC: ${sent.cc.join(', ')}` : null,
      sent.bcc.length > 0 ? `BCC: ${sent.bcc.join(', ')}` : null,
      sent.attachments.length > 0 ? `Attachments: ${sent.attachments.join(', ')}` : null,
    ].filter(Boolean).join('\n');

    return {
      ok: true,
      output,
      meta: {
        action: 'send_message',
        connector: 'mail',
        sent: sent.sent,
        subject: sent.subject,
        to: sent.to,
        cc: sent.cc,
        bcc: sent.bcc,
        attachments: sent.attachments,
        toCount: sent.to.length,
        artifact: createVirtualArtifact({
          sourceTool: schema.name,
          kind: 'text',
          role: 'receipt',
          sessionId: ctx.sessionId,
          name: `${copy.sent}${separator}${sent.subject}`,
          mimeType: 'text/markdown',
          contentLength: output.length,
          preview: output.slice(0, 500),
          metadata: {
            connector: 'mail',
            action: 'send_message',
            subject: sent.subject,
            sent: sent.sent,
            toCount: sent.to.length,
            attachmentCount: sent.attachments.length,
          },
        }),
      },
    };
  } catch (error) {
    const failure = describeAppleScriptWriteFailure(
      'Mail',
      'Mail send failed',
      error,
      ctx.logger,
      schema.name,
      shouldLogMailFailureDetail(),
    );
    const to = (args.to as unknown[]).filter((item): item is string => typeof item === 'string');
    const title = String(args.subject);
    const failureName = title ? `${copy.sendFailed}${separator}${title}` : copy.sendFailed;
    const userMessage = locale === 'en' ? appleScriptFailureForDisplay(error, 'Mail', appleScriptFailure) : undefined;
    const recipientLine = `To: ${to.join(', ')}`;
    return {
      ok: false,
      error: failure,
      ...(userMessage ? { userMessage } : {}),
      meta: {
        action: 'send_message',
        connector: 'mail',
        subject: args.subject,
        to,
        toCount: to.length,
        failureReason: failure,
        artifact: createFailedReceiptArtifact({
          sourceTool: schema.name,
          sessionId: ctx.sessionId,
          action: 'send_message',
          name: failureName,
          ...(userMessage ? { preview: [`${failureName}${separator}${userMessage}`, recipientLine].join('\n') } : {}),
          error: failure,
          metadata: { connector: 'mail', subject: args.subject, toCount: to.length },
          detailLines: [recipientLine],
        }),
      },
    };
  }
}

class MailSendHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeMailSend(args, ctx, canUseTool, onProgress);
  }
}

export const mailSendModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new MailSendHandler();
  },
};
