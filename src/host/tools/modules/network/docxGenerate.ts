// ============================================================================
// docx_generate (P1 Wave 4 D2b — network/document_generation: native ToolModule)
//
// 把 legacy DocxGenerateTool 的 Markdown→docx 渲染管线整体搬到 native：
// 标题 / 列表 / 粗体斜体 / 代码 / 引用 / 表格 + 4 主题（professional/academic/minimal/creative）。
//
// 行为保真：legacy 输出文案、emoji、metadata.attachment 形状 1:1 复刻（评测集依赖）。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import { resolveInputPath } from '../../utils/resolveInputPath';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
} from 'docx';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { formatFileSize } from '../../utils/fileSize';
import { createFileArtifact } from '../../artifacts/artifactMeta';
import { docxGenerateSchema as schema } from './docxGenerate.schema';

type DocxTheme = 'professional' | 'academic' | 'minimal' | 'creative';

interface DocxGenerateParams {
  title: string;
  content: string;
  theme?: DocxTheme;
  output_path?: string;
  author?: string;
}

interface ThemeConfig {
  titleSize: number;
  headingSize: number;
  textSize: number;
  titleColor: string;
  headingColor: string;
  textColor: string;
  fontFamily: string;
}

const themeConfigs: Record<DocxTheme, ThemeConfig> = {
  professional: {
    titleSize: 36,
    headingSize: 24,
    textSize: 12,
    titleColor: '1a365d',
    headingColor: '2c5282',
    textColor: '2d3748',
    fontFamily: 'Arial',
  },
  academic: {
    titleSize: 32,
    headingSize: 20,
    textSize: 12,
    titleColor: '000000',
    headingColor: '333333',
    textColor: '000000',
    fontFamily: 'Times New Roman',
  },
  minimal: {
    titleSize: 28,
    headingSize: 18,
    textSize: 11,
    titleColor: '1f2937',
    headingColor: '374151',
    textColor: '4b5563',
    fontFamily: 'Helvetica',
  },
  creative: {
    titleSize: 40,
    headingSize: 26,
    textSize: 12,
    titleColor: '7c3aed',
    headingColor: '6d28d9',
    textColor: '1f2937',
    fontFamily: 'Georgia',
  },
};

function parseMarkdownToDocElements(content: string, theme: ThemeConfig): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const lines = content.split('\n');

  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let inTable = false;
  let tableRows: string[][] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: codeBlockContent.join('\n'),
                font: 'Consolas',
                size: 20,
                color: '1f2937',
              }),
            ],
            shading: { fill: 'f3f4f6' },
            spacing: { before: 200, after: 200 },
          }),
        );
        codeBlockContent = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      if (!inTable) {
        inTable = true;
        tableRows = [];
      }
      if (!trimmed.match(/^\|[\s-|]+\|$/)) {
        const cells = trimmed.split('|').filter((c) => c.trim()).map((c) => c.trim());
        tableRows.push(cells);
      }
      continue;
    } else if (inTable) {
      if (tableRows.length > 0) {
        paragraphs.push(...createTable(tableRows, theme));
      }
      tableRows = [];
      inTable = false;
    }

    if (!trimmed) {
      paragraphs.push(new Paragraph({ text: '' }));
      continue;
    }

    if (trimmed.startsWith('# ')) {
      paragraphs.push(
        new Paragraph({
          children: createFormattedRuns(trimmed.replace(/^#\s*/, ''), theme, {
            bold: true,
            size: theme.headingSize * 2,
            color: theme.headingColor,
          }),
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 400, after: 200 },
        }),
      );
      continue;
    }

    if (trimmed.startsWith('## ')) {
      paragraphs.push(
        new Paragraph({
          children: createFormattedRuns(trimmed.replace(/^##\s*/, ''), theme, {
            bold: true,
            size: theme.headingSize * 2 - 4,
            color: theme.headingColor,
          }),
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 300, after: 150 },
        }),
      );
      continue;
    }

    if (trimmed.startsWith('### ')) {
      paragraphs.push(
        new Paragraph({
          children: createFormattedRuns(trimmed.replace(/^###\s*/, ''), theme, {
            bold: true,
            size: theme.headingSize * 2 - 8,
            color: theme.headingColor,
          }),
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 200, after: 100 },
        }),
      );
      continue;
    }

    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      paragraphs.push(
        new Paragraph({
          children: createFormattedRuns(trimmed.replace(/^[-*]\s*/, ''), theme),
          bullet: { level: 0 },
          spacing: { before: 50, after: 50 },
        }),
      );
      continue;
    }

    if (trimmed.match(/^\d+\.\s/)) {
      paragraphs.push(
        new Paragraph({
          children: createFormattedRuns(trimmed.replace(/^\d+\.\s*/, ''), theme),
          numbering: { reference: 'default-numbering', level: 0 },
          spacing: { before: 50, after: 50 },
        }),
      );
      continue;
    }

    if (trimmed.startsWith('> ')) {
      paragraphs.push(
        new Paragraph({
          children: createFormattedRuns(trimmed.replace(/^>\s*/, ''), theme, {
            italics: true,
            color: '6b7280',
          }),
          indent: { left: 720 },
          shading: { fill: 'f9fafb' },
          spacing: { before: 100, after: 100 },
        }),
      );
      continue;
    }

    paragraphs.push(createFormattedParagraph(trimmed, theme));
  }

  if (inTable && tableRows.length > 0) {
    paragraphs.push(...createTable(tableRows, theme));
  }

  return paragraphs;
}

interface InlineRunDefaults {
  bold?: boolean;
  italics?: boolean;
  size?: number;
  color?: string;
}

function createFormattedRuns(
  text: string,
  theme: ThemeConfig,
  defaults: InlineRunDefaults = {},
): TextRun[] {
  const runs: TextRun[] = [];
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);

  for (const part of parts) {
    if (!part) continue;
    const size = defaults.size ?? theme.textSize * 2;
    const color = defaults.color ?? theme.textColor;

    if (part.startsWith('**') && part.endsWith('**')) {
      runs.push(new TextRun({
        text: part.slice(2, -2),
        bold: true,
        italics: defaults.italics,
        size,
        color,
        font: theme.fontFamily,
      }));
    } else if (part.startsWith('*') && part.endsWith('*')) {
      runs.push(new TextRun({
        text: part.slice(1, -1),
        bold: defaults.bold,
        italics: true,
        size,
        color,
        font: theme.fontFamily,
      }));
    } else if (part.startsWith('`') && part.endsWith('`')) {
      runs.push(new TextRun({
        text: part.slice(1, -1),
        bold: defaults.bold,
        italics: defaults.italics,
        font: 'Consolas',
        size: defaults.size ?? size - 2,
        color: defaults.color ?? 'dc2626',
        shading: { fill: 'f3f4f6' },
      }));
    } else {
      runs.push(new TextRun({
        text: part,
        bold: defaults.bold,
        italics: defaults.italics,
        size,
        color,
        font: theme.fontFamily,
      }));
    }
  }
  return runs;
}

function createFormattedParagraph(text: string, theme: ThemeConfig): Paragraph {
  return new Paragraph({
    children: createFormattedRuns(text, theme),
    spacing: { before: 100, after: 100 },
  });
}

function createTable(rows: string[][], theme: ThemeConfig): Paragraph[] {
  if (rows.length === 0) return [];

  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map((row, rowIndex) =>
      new TableRow({
        children: row.map(
          (cell) =>
            new TableCell({
              children: [
                new Paragraph({
                  children: createFormattedRuns(cell, theme, { bold: rowIndex === 0 }),
                }),
              ],
              shading: rowIndex === 0 ? { fill: 'f3f4f6' } : undefined,
              borders: {
                top: { style: BorderStyle.SINGLE, size: 1, color: 'e5e7eb' },
                bottom: { style: BorderStyle.SINGLE, size: 1, color: 'e5e7eb' },
                left: { style: BorderStyle.SINGLE, size: 1, color: 'e5e7eb' },
                right: { style: BorderStyle.SINGLE, size: 1, color: 'e5e7eb' },
              },
            }),
        ),
      }),
    ),
  });

  return [
    new Paragraph({ text: '' }),
    // @ts-expect-error Table is valid in sections.children
    table,
    new Paragraph({ text: '' }),
  ];
}

async function scanDocxForResidualMarkdown(filePath: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const document = zip.file('word/document.xml');
  if (!document) throw new Error('word/document.xml is missing after generation');
  const xml = await document.async('string');
  const hits: string[] = [];
  if (/\*\*[^*\r\n]+\*\*/.test(xml)) hits.push('paired **bold** markers');
  if (/<w:t(?:\s[^>]*)?>\s*(?:#{1,3}|[-*]|\d+\.|&gt;)\s+/.test(xml)) {
    hits.push('leading list/heading markers');
  }
  return hits;
}

export async function executeDocxGenerate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const params = args as unknown as DocxGenerateParams;
  const { title, content } = params;

  if (typeof title !== 'string' || title.length === 0) {
    return { ok: false, error: 'title is required and must be a string', code: 'INVALID_ARGS' };
  }
  if (typeof content !== 'string') {
    return { ok: false, error: 'content is required and must be a string', code: 'INVALID_ARGS' };
  }

  const theme: DocxTheme = (params.theme ?? 'professional') as DocxTheme;
  const author = params.author ?? 'Agent Neo';
  const output_path = params.output_path;

  try {
    const themeConfig = themeConfigs[theme] || themeConfigs.professional;

    const timestamp = Date.now();
    const fileName = `document-${timestamp}.docx`;
    const finalPath = resolveInputPath(output_path ?? fileName, ctx.workingDir);
    const outputDir = path.dirname(finalPath);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const contentParagraphs = parseMarkdownToDocElements(content, themeConfig);

    const doc = new Document({
      creator: author,
      title,
      description: 'Generated by Agent Neo',
      styles: {
        default: {
          document: {
            run: {
              font: themeConfig.fontFamily,
              size: themeConfig.textSize * 2,
            },
          },
        },
      },
      numbering: {
        config: [
          {
            reference: 'default-numbering',
            levels: [
              {
                level: 0,
                format: 'decimal',
                text: '%1.',
                alignment: AlignmentType.LEFT,
              },
            ],
          },
        ],
      },
      sections: [
        {
          children: [
            new Paragraph({
              children: createFormattedRuns(title, themeConfig, {
                bold: true,
                size: themeConfig.titleSize * 2,
                color: themeConfig.titleColor,
              }),
              alignment: AlignmentType.CENTER,
              spacing: { before: 400, after: 400 },
            }),
            ...contentParagraphs,
          ],
        },
      ],
    });

    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(finalPath, buffer);

    const residualMarkers = await scanDocxForResidualMarkdown(finalPath);
    if (residualMarkers.length > 0) {
      return {
        ok: false,
        error: `DOCX_MARKDOWN_RESIDUE: generated word/document.xml contains ${residualMarkers.join(', ')}. Regenerate with plain text or supported inline Markdown; do not deliver this file.`,
        code: 'DOCX_MARKDOWN_RESIDUE',
      };
    }
    ctx.logger.debug('docx_generate Markdown residue scan passed', { path: finalPath });

    const stats = fs.statSync(finalPath);

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('docx_generate done', { path: finalPath, size: stats.size });

    return {
      ok: true,
      output: `✅ Word 文档已生成！

📄 文件路径: ${finalPath}
🎨 主题风格: ${theme}
📦 文件大小: ${formatFileSize(stats.size)}

点击上方文件路径可直接打开。`,
      meta: {
        artifact: await createFileArtifact(finalPath, schema.name, ctx, {
          kind: 'document',
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sizeBytes: stats.size,
          metadata: {
            title,
            theme,
            author,
          },
        }),
        filePath: finalPath,
        fileName: path.basename(finalPath),
        fileSize: stats.size,
        theme,
        attachment: {
          id: `docx-${timestamp}`,
          type: 'file',
          category: 'document',
          name: path.basename(finalPath),
          path: finalPath,
          size: stats.size,
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Word 文档生成失败: ${message}` };
  }
}

class DocxGenerateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeDocxGenerate(args, ctx, canUseTool, onProgress);
  }
}

export const docxGenerateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new DocxGenerateHandler();
  },
};
