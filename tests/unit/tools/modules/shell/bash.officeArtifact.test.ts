// Bash-scripted .docx must surface a file artifact (same shape as docx_generate) — N-FIX-DOCX ... FU1 ④
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';
import { bashModule } from '../../../../../src/host/tools/modules/shell/bash';
import { docxGenerateModule } from '../../../../../src/host/tools/modules/network/docxGenerate';
import { collectToolArtifactsFromMetadata } from '../../../../../src/shared/contract/artifactBlob';

vi.mock('../../../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: () => Promise.resolve(null),
}));

const allowAll: CanUseToolFn = async () => ({ allow: true });

function makeCtx(workingDir: string): ToolContext {
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    sessionId: 'office-session',
    workingDir,
    abortSignal: new AbortController().signal,
    logger,
    emit: () => void 0,
    policyEnforcer: null,
  } as unknown as ToolContext;
}

function hasPythonDocx(): boolean {
  try {
    execFileSync('python3', ['-c', 'import docx'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('Bash office-file artifacts', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'bash-office-')));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function runScript(command: string) {
    const handler = await bashModule.createHandler();
    return handler.execute({ command }, makeCtx(dir), allowAll);
  }

  // python-docx when available, otherwise the node `docx` package (recorded in evidence).
  function docxCommand(): string {
    if (hasPythonDocx()) {
      return `python3 -c "import docx; d=docx.Document(); d.add_paragraph('minutes'); d.save('minutes.docx')"`;
    }
    const script = join(dir, 'gen.cjs');
    writeFileSync(
      script,
      `const fs=require('fs');const d=require(${JSON.stringify(require.resolve('docx'))});
d.Packer.toBuffer(new d.Document({sections:[{children:[new d.Paragraph('minutes')]}]})).then(b=>fs.writeFileSync('minutes.docx',b));`,
    );
    return 'node gen.cjs';
  }

  it('attaches a deliverable document artifact for a docx written by the script, same shape as docx_generate', async () => {
    const result = await runScript(docxCommand());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const artifacts = collectToolArtifactsFromMetadata(result.meta as Record<string, unknown>);
    const docx = artifacts.find((a) => a.path?.endsWith('minutes.docx'));
    console.log('BASH_DOCX_ARTIFACT', JSON.stringify(docx));
    expect(docx).toMatchObject({ kind: 'document', role: 'deliverable', label: 'minutes.docx' });
    expect(docx?.path).toBe(join(dir, 'minutes.docx'));

    const gen = await (await docxGenerateModule.createHandler()).execute(
      { title: 'T', content: 'body', output_path: join(dir, 'gen.docx') },
      makeCtx(dir),
      allowAll,
    );
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;
    const genArtifact = collectToolArtifactsFromMetadata(gen.meta as Record<string, unknown>)[0];
    expect(docx?.mimeType).toBe(genArtifact.mimeType);
    expect(docx?.kind).toBe(genArtifact.kind);
    expect(docx?.sizeBytes).toBeGreaterThan(0);
    expect(docx?.sha256).toBeTruthy();
  });

  it('attaches a deliverable document artifact for a pptx written by the script', async () => {
    const script = join(dir, 'gen-pptx.cjs');
    writeFileSync(
      script,
      `const Pptx=require(${JSON.stringify(require.resolve('pptxgenjs'))});
void (async()=>{const p=new Pptx();p.addSlide().addText('Sales',{x:1,y:1,w:5,h:1,isTextBox:true});await p.writeFile({fileName:'sales.pptx'});})();`,
    );
    const result = await runScript('node gen-pptx.cjs');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const artifacts = collectToolArtifactsFromMetadata(result.meta as Record<string, unknown>);
    const pptx = artifacts.find((a) => a.path?.endsWith('sales.pptx'));
    console.log('BASH_PPTX_ARTIFACT', JSON.stringify(pptx));
    expect(pptx).toMatchObject({
      kind: 'document',
      role: 'deliverable',
      sourceTool: 'Bash',
      label: 'sales.pptx',
      path: join(dir, 'sales.pptx'),
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    expect(pptx?.sizeBytes).toBeGreaterThan(0);
    expect(pptx?.sha256).toBeTruthy();
  });

  it('ignores template docx files that a pip-installed Python package drops in the folder', async () => {
    const result = await runScript(
      `mkdir -p pylibs/docx/templates && touch pylibs/docx/__init__.py && echo x > pylibs/docx/templates/default.docx && echo y > real.docx`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = collectToolArtifactsFromMetadata(result.meta as Record<string, unknown>).map((a) => a.path);
    expect(paths.some((p) => p?.endsWith('real.docx'))).toBe(true);
    expect(paths.some((p) => p?.endsWith('default.docx'))).toBe(false);
  });

  it('does not report pre-existing unchanged office files or ones in node_modules', async () => {
    writeFileSync(join(dir, 'old.docx'), 'x');
    mkdirSync(join(dir, 'node_modules'));
    const result = await runScript(`echo hi > node_modules/n.docx`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = collectToolArtifactsFromMetadata(result.meta as Record<string, unknown>).map((a) => a.path);
    expect(paths.some((p) => p?.endsWith('.docx'))).toBe(false);
  });
});
