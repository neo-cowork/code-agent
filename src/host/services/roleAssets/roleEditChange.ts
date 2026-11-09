interface RoleDefinition {
  description: string;
  tools: string[];
  systemPrompt: string;
}

/** Compare installed definitions. Prompt counts use a line-based longest common subsequence. */
export function diffRoleDefinition(before: RoleDefinition, after: RoleDefinition): {
  addedTools: string[];
  removedTools: string[];
  descriptionChanged: boolean;
  promptLinesAdded: number;
  promptLinesRemoved: number;
} {
  const tools = (names: string[]) => new Map(
    names.map((name) => name.trim()).filter(Boolean).map((name) => [name.toLowerCase(), name]),
  );
  const oldTools = tools(before.tools);
  const newTools = tools(after.tools);
  const lines = (prompt: string) => prompt.trim() ? prompt.trim().replace(/\r\n/g, '\n').split('\n') : [];
  const oldLines = lines(before.systemPrompt);
  const newLines = lines(after.systemPrompt);
  // One row keeps memory bounded by the new prompt's line count.
  const common = new Array<number>(newLines.length + 1).fill(0);
  for (const oldLine of oldLines) {
    let diagonal = 0;
    for (let j = 1; j <= newLines.length; j++) {
      const previous = common[j];
      common[j] = oldLine === newLines[j - 1]
        ? diagonal + 1
        : Math.max(common[j], common[j - 1]);
      diagonal = previous;
    }
  }
  const unchanged = common[newLines.length];
  return {
    addedTools: [...newTools].filter(([key]) => !oldTools.has(key)).map(([, name]) => name),
    removedTools: [...oldTools].filter(([key]) => !newTools.has(key)).map(([, name]) => name),
    descriptionChanged: before.description !== after.description,
    promptLinesAdded: newLines.length - unchanged,
    promptLinesRemoved: oldLines.length - unchanged,
  };
}
