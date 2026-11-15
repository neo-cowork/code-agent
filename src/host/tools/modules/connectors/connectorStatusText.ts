// Shared plain-language status text for native Mail / Calendar / Reminders get_status.
// Structured meta.status stays untouched for programmatic callers; text output gives
// one plain-language fact plus a model-directed instruction so models never relay
// internal "X connector: unavailable|connected|disconnected" or "Capabilities:" dumps.

type StatusConnectorId = 'mail' | 'calendar' | 'reminders';

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

// The real UI entry: "Connectors" (English UI) / "连接器" (Chinese UI).
const CONNECTORS_PAGE_HINT = 'the Connectors page (named "连接器" in the Chinese interface)';

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

export function formatConnectorStatusOutput(
  connectorId: StatusConnectorId,
  status: {
    connected: boolean;
    detail?: string;
    capabilities: string[];
    unavailable?: boolean;
  },
): string {
  const copy = CONNECTOR_COPY[connectorId];
  if (status.unavailable) {
    return `${copy.title} is not connected on this computer, so ${copy.dataNoun} cannot be read. Tell the user in plain words, in their own language, that ${copy.userTarget} is not connected yet and can be connected on ${CONNECTORS_PAGE_HINT}. Do not quote this line.`;
  }

  const trimmedDetail = status.detail?.trim() ?? '';
  const detailSentence = trimmedDetail ? ` ${ensureSentenceEnd(trimmedDetail)}` : '';

  if (!status.connected) {
    return `${copy.title} is not connected right now, so ${copy.dataNoun} cannot be read.${detailSentence} Tell the user in plain words, in their own language, that ${copy.userTarget} is not ready yet and can be checked or authorized on ${CONNECTORS_PAGE_HINT}. Do not quote this line.`;
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

  return `${copy.title} is connected.${detailSentence}${capabilitiesSentence} Relay this status in plain words in the user's own language, without quoting this line.`;
}
