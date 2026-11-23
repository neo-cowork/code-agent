// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import { buildArtifactOwnershipItems } from '../../../src/renderer/utils/artifactOwnership';
import { FileArtifactCard } from '../../../src/renderer/components/features/chat/MessageBubble/FileArtifactCard';

describe('Bash-scripted docx file card', () => {
  afterEach(() => cleanup());

  it('builds a deliverable file item from Bash metadata and renders the .docx name', () => {
    const turn = {
      turnNumber: 1,
      turnId: 'turn-bash-docx',
      status: 'completed',
      startTime: 1,
      endTime: 2,
      nodes: [{
        id: 'tool-bash',
        type: 'tool_call',
        content: '',
        timestamp: 1,
        toolCall: {
          id: 'tool-bash',
          name: 'Bash',
          args: {},
          result: 'ok',
          success: true,
          metadata: {
            artifact: { artifactId: 'a-out', kind: 'process-output', sourceTool: 'Bash', name: 'Bash output' },
            artifacts: [{
              artifactId: 'a-docx',
              kind: 'document',
              role: 'deliverable',
              sourceTool: 'Bash',
              name: '会议纪要.docx',
              path: '/work/task/会议纪要.docx',
              mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              sizeBytes: 10639,
            }],
          },
        },
      }],
    } satisfies TraceTurn;
    const items = buildArtifactOwnershipItems(turn);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'file', role: 'deliverable', label: '会议纪要.docx', path: '/work/task/会议纪要.docx' });

    render(<FileArtifactCard items={items} />);
    expect(screen.getByText('会议纪要.docx')).toBeTruthy();
  });
});
