type DecisionLabels = Record<'advance' | 'report' | 'suggest', string>;

/** Only the summary prefix is a status; quoted tags elsewhere remain user text. */
export function formatRoleHistoryLine(line: string, labels: DecisionLabels): string {
  return line.replace(
    /^((?:- )?\d{4}-\d{2}-\d{2}(?: \| .*? \| | )|)[ \t]*\[(advance|report|suggest)\](?=\s|$)/gm,
    (_match, prefix: string, decision: keyof DecisionLabels) => `${prefix}${labels[decision]}`,
  );
}
