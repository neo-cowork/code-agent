import { describe, expect, it } from 'vitest';
import type { MessageAttachment } from '../../../../src/shared/contract';
import { buildMultimodalContent } from '../../../../src/host/agent/messageHandling/converter';

// Exercises production processFolderAttachment through its public caller.
function render(files: MessageAttachment['files'], path?: string) {
  return buildMultimodalContent('what is this contract about?', [{
    id: 'folder-test', type: 'file', category: 'folder', name: 'contract-bundle',
    size: 4096, mimeType: 'inode/directory', data: 'Folder attachment summary', files, path,
  }]).map((part) => part.text ?? '').join('\n');
}

describe('processFolderAttachment', () => {
  it('prints the per-file absolute path and actual bytes, never binary content', () => {
    const text = render([{
      path: 'contract-bundle/scan-contract.pdf', size: 2048, type: 'pdf', binary: true,
      absolutePath: '/tmp/uploads/id/contract-bundle/scan-contract.pdf',
      content: '%PDF old persisted garbage',
    }], '/tmp/unrelated-root');
    expect(text).toContain('2.0 KB; pdf; binary, open with a tool');
    expect(text).toContain('→ `/tmp/uploads/id/contract-bundle/scan-contract.pdf`');
    expect(text).not.toContain('%PDF');
    expect(text).not.toContain('/tmp/unrelated-root/contract-bundle');
  });

  it.each([undefined, '', 'contract-bundle/scan-contract.pdf'])('missing/relative path %s asks for reattachment', (absolutePath) => {
    const text = render([{
      path: 'contract-bundle/scan-contract.pdf', size: 2048, type: 'pdf', binary: true, absolutePath,
    }]);
    expect(text).toContain('Folder path unresolved');
    expect(text).toContain('no readable path, cannot read; ask the user to re-attach');
    expect(text).not.toContain('→ `contract-bundle/scan-contract.pdf`');
    expect(text).toContain('never guess its nature');
  });

  it('does not synthesize a path from a folder root for old metadata', () => {
    const text = render([{ path: 'contract-bundle/notes.txt', content: '中文', size: 6 }], '/tmp/folder');
    expect(text).toContain('(0.0 KB) → no readable path');
    expect(text).not.toContain('→ `/tmp/folder');
    expect(text).not.toContain('binary, open with a tool');
  });

  it('accepts an actual Windows drive or UNC path', () => {
    for (const absolutePath of ['C:\\uploads\\contract.pdf', '\\\\server\\uploads\\contract.pdf']) {
      expect(render([{ path: 'contract.pdf', size: 0, binary: true, absolutePath }])).toContain(`→ \`${absolutePath}\``);
    }
  });
});
