import type { ToolResult } from '../../../shared/contract/tool';
import type { NormalizedToolArtifactMeta } from '../../../shared/contract/artifactBlob';
import { collectToolArtifactsFromMetadata } from '../../../shared/contract/artifactBlob';
import { isDeliverableArtifact } from '../../../shared/contract/artifactRoleRegistry';

/** 一组工具结果里已确认产生的文件交付物（按路径去重）。 */
export function collectDeliverableFileArtifacts(toolResults: readonly ToolResult[] = []): NormalizedToolArtifactMeta[] {
  const artifacts: NormalizedToolArtifactMeta[] = [];
  const seenPaths = new Set<string>();
  for (const result of toolResults) {
    for (const artifact of collectToolArtifactsFromMetadata(result.metadata)) {
      if (!artifact.path || !isDeliverableArtifact(artifact) || seenPaths.has(artifact.path)) continue;
      seenPaths.add(artifact.path);
      artifacts.push({ ...artifact, role: 'deliverable' });
    }
  }
  return artifacts;
}
