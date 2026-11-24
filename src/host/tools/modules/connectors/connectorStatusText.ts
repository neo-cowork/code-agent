// Shared plain-language status text for native Mail / Calendar / Reminders get_status.
// Structured meta.status stays untouched for programmatic callers; text output gives
// one plain-language fact plus a model-directed instruction so models never relay
// internal "X connector: unavailable|connected|disconnected" or "Capabilities:" dumps.

import type { NativeConnectorDetailCode } from '../../../../shared/ipc/types';

type StatusConnectorId = 'mail' | 'calendar' | 'reminders';

// Model-directed English facts per stable detailCode. The host no longer writes
// user-facing prose into detail/error, so the model gets its cause + fix hint here.
const DETAIL_CODE_GUIDANCE: Record<NativeConnectorDetailCode, string> = {
  platform_unsupported: 'This only works on a Mac.',
  unchecked: 'Access has not been checked yet.',
  ready: 'Access is allowed.',
  automation_not_authorized: 'macOS has not allowed Neo to control this app. The user can allow it in System Settings > Privacy & Security > Automation, then check again.',
  not_found: 'The app could not find the expected account, calendar or list.',
  timeout: 'The app did not respond in time. Ask the user to make sure the app is open and not blocked by a dialog, then try again.',
  read_failed: 'Reading from the app failed. Try again shortly.',
  probe_failed: 'The access check failed for an unknown reason. Try again shortly.',
  calendar_undecided: 'Calendar access has not been decided yet. The user needs to allow it when macOS asks, or in System Settings > Privacy & Security > Calendars.',
  calendar_denied: 'Calendar access was refused. The user can allow it in System Settings > Privacy & Security > Calendars.',
  calendar_write_only: 'Calendar access is write-only. The user must change it to Full Access in System Settings > Privacy & Security > Calendars so events can be read.',
  calendar_restricted: 'Calendar access is restricted by the system (for example by a device management profile). The user cannot fix this from the Connectors page; an administrator must lift the restriction.',
  calendar_desktop_only: 'Calendar access is only available in the desktop app, not in this runtime.',
  photos_failed: 'Reading the Photos library failed. Try again shortly.',
  photos_unavailable: 'The Photos library is not available on this computer.',
};

// Codes whose fix lives in macOS System Settings rather than on the Connectors page.
const SYSTEM_SETTINGS_FIX_CODES: ReadonlySet<NativeConnectorDetailCode> = new Set([
  'automation_not_authorized', 'calendar_undecided', 'calendar_denied', 'calendar_write_only',
]);

/** Model-facing fact for a status: legacy detail wins, else the detailCode guidance. */
export function describeStatusDetail(status: { detail?: string; error?: string; detailCode?: NativeConnectorDetailCode }): string {
  const text = (status.error ?? status.detail ?? '').trim();
  if (text) return text;
  return status.detailCode ? DETAIL_CODE_GUIDANCE[status.detailCode] : '';
}

interface ConnectorCopy {
  title: string;
  dataNoun: string;
  userTarget: string;
  /** Plural noun for the "never claim emptiness" sentence on read actions. */
  emptyClaim: string;
}

export type ConnectorUnavailableAction = 'read' | 'send' | 'create' | 'change';

const UNAVAILABLE_ACTION_PHRASE: Record<ConnectorUnavailableAction, (copy: ConnectorCopy) => string> = {
  read: (c) => `${c.dataNoun} cannot be read`,
  send: (c) => `${c.dataNoun} cannot be sent`,
  create: (c) => `${c.dataNoun} cannot be created`,
  change: (c) => `${c.dataNoun} cannot be changed`,
};

// The real UI entry: Connectors tab of the Capability Hub (renderer capabilityHub.ts).
const CONNECTORS_PAGE_HINT = 'the Connectors page (the Connectors tab inside the Capability Hub; in the Chinese interface 能力中心 > 连接器)';

const CONNECTOR_COPY: Record<StatusConnectorId, ConnectorCopy> = {
  mail: {
    title: 'Mail',
    dataNoun: 'email',
    userTarget: 'email',
    emptyClaim: 'emails',
  },
  calendar: {
    title: 'Calendar',
    dataNoun: 'calendar events',
    userTarget: 'Calendar',
    emptyClaim: 'events',
  },
  reminders: {
    title: 'Reminders',
    dataNoun: 'reminders',
    userTarget: 'Reminders',
    emptyClaim: 'reminders',
  },
};

function ensureSentenceEnd(text: string): string {
  return /[.!?。！？]$/.test(text) ? text : `${text}.`;
}

function formatReadableList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

// Model-visible error text for a tool call whose connector is missing from the registry.
// Callers keep their own `ok:false` + `code: 'NOT_INITIALIZED'` shape.
export function formatConnectorUnavailableMessage(
  connectorId: StatusConnectorId,
  action: ConnectorUnavailableAction = 'read',
): string {
  const copy = CONNECTOR_COPY[connectorId];
  const readGuard = action === 'read'
    ? ` Do not answer this question from other sources (for example meeting records or files), and never state that there are no ${copy.emptyClaim}.`
    : '';
  return `${copy.title} is not connected on this computer, so ${UNAVAILABLE_ACTION_PHRASE[action](copy)}. Tell the user in plain words, in their own language, that ${copy.userTarget} is not connected yet and can be connected on ${CONNECTORS_PAGE_HINT}.${readGuard} Do not quote this line.`;
}

export interface ConnectorStatusText {
  /** Facts only — safe to show in the tool card and artifact preview. */
  output: string;
  /** Model-directed instruction; travels in meta.modelGuidance, never in output. */
  guidance: string;
}

export function formatConnectorStatus(
  connectorId: StatusConnectorId,
  status: {
    connected: boolean;
    detail?: string;
    detailCode?: NativeConnectorDetailCode;
    capabilities: string[];
    unavailable?: boolean;
  },
): ConnectorStatusText {
  const copy = CONNECTOR_COPY[connectorId];
  if (status.unavailable) {
    return {
      output: `${copy.title} is not connected on this computer, so ${copy.dataNoun} cannot be read.`,
      guidance: `Tell the user in plain words, in their own language, that ${copy.userTarget} is not connected yet and can be connected on ${CONNECTORS_PAGE_HINT}. Do not quote this line.`,
    };
  }

  const trimmedDetail = describeStatusDetail(status);
  const detailSentence = trimmedDetail ? ` ${ensureSentenceEnd(trimmedDetail)}` : '';

  if (!status.connected) {
    const output = `${copy.title} is not connected right now, so ${copy.dataNoun} cannot be read.${detailSentence}`;
    if (status.detailCode === 'calendar_restricted') {
      return {
        output,
        guidance: `Tell the user in plain words, in their own language, that ${copy.userTarget} is blocked by a system restriction and there is nothing they can change themselves. Do not send them to the Connectors page or System Settings. Do not quote this line.`,
      };
    }
    if (status.detailCode && SYSTEM_SETTINGS_FIX_CODES.has(status.detailCode)) {
      return {
        output,
        guidance: `Tell the user in plain words, in their own language, that ${copy.userTarget} is not ready yet and what to change in System Settings as described above; once changed, it can be re-checked on ${CONNECTORS_PAGE_HINT}. Do not quote this line.`,
      };
    }
    return {
      output,
      guidance: `Tell the user in plain words, in their own language, that ${copy.userTarget} is not ready yet and can be checked or authorized on ${CONNECTORS_PAGE_HINT}. Do not quote this line.`,
    };
  }

  const actionCapabilities = status.capabilities.filter((cap) => Boolean(cap) && cap !== 'get_status');
  const rawCapabilities = actionCapabilities.length > 0
    ? actionCapabilities
    : status.capabilities.filter(Boolean);
  const readableCapabilities = rawCapabilities
    .map((cap) => cap.trim().replace(/_/g, ' '))
    .filter(Boolean);
  const capabilitiesSentence = readableCapabilities.length > 0
    ? ` It supports ${formatReadableList(readableCapabilities)}.`
    : '';

  return {
    output: `${copy.title} is connected.${detailSentence}${capabilitiesSentence}`,
    guidance: "Relay this status in plain words in the user's own language, without quoting the status line.",
  };
}
