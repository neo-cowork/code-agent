// Shared plain-language status text for native Mail / Calendar / Reminders get_status.
// Structured meta.status stays untouched for programmatic callers; text output gives
// one plain-language fact plus a model-directed instruction so models never relay
// internal "X connector: unavailable|connected|disconnected" or "Capabilities:" dumps.

type StatusConnectorId = 'mail' | 'calendar' | 'reminders';

interface ConnectorCopy {
  title: string;
  dataNoun: string;
  userTarget: string;
}

const CONNECTOR_COPY: Record<StatusConnectorId, ConnectorCopy> = {
  mail: {
    title: 'Mail',
    dataNoun: 'email',
    userTarget: 'email',
  },
  calendar: {
    title: 'Calendar',
    dataNoun: 'calendar events',
    userTarget: 'Calendar',
  },
  reminders: {
    title: 'Reminders',
    dataNoun: 'reminders',
    userTarget: 'Reminders',
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
    return `${copy.title} is not connected on this computer, so ${copy.dataNoun} cannot be read. Tell the user in plain words, in their own language, that ${copy.userTarget} is not connected yet and can be connected on the Connectors page. Do not quote this line.`;
  }

  const trimmedDetail = status.detail?.trim() ?? '';
  const detailSentence = trimmedDetail ? ` ${ensureSentenceEnd(trimmedDetail)}` : '';

  if (!status.connected) {
    return `${copy.title} is not connected right now, so ${copy.dataNoun} cannot be read.${detailSentence} Tell the user in plain words, in their own language, that ${copy.userTarget} is not ready yet and can be checked or authorized on the Connectors page. Do not quote this line.`;
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
