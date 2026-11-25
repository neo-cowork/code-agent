import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Nodes, Root } from 'mdast';
import { remarkCurrencyDollarGuard } from '../../../src/renderer/components/features/chat/MessageBubble/remarkCurrencyDollarGuard';
import { remarkMathPandoc } from '../../../src/renderer/components/features/chat/MessageBubble/remarkMathPandoc';
import { remarkTrimCjkAutolink } from '../../../src/renderer/components/features/chat/MessageBubble/remarkTrimCjkAutolink';
import { updateStreamingMarkdownBlockState } from '../../../src/renderer/components/features/chat/MessageBubble/streamingMarkdownBlocks';
import { dedupeCodeCopyLinks } from '../../../src/renderer/components/features/chat/MessageBubble/dedupeCodeCopyLinks';

function parse(source: string, guarded = true): Root {
  const processor = unified().use(remarkParse).use(remarkMath)
    .use(remarkCurrencyDollarGuard, guarded);
  return processor.runSync(processor.parse(source), { value: source });
}

function leaves(node: Nodes): Nodes[] {
  return 'children' in node ? node.children.flatMap(leaves) : [node];
}

describe('remarkCurrencyDollarGuard', () => {
  it.each([
    '收入 $15,550，日均 $3,110',
    'Revenue $15,550, average $3,110/day; West $4,750',
    '$6,400 到 $4,750', 'West $4,750',
    '$ x$', '$x $', '$ x $', '$x$2', '$\tx$', '$x\n$',
    'cost $5 and $x$', '🙂 $20,000 and $30,000',
  ])('preserves invalid single-dollar delimiters verbatim: %s', (source) => {
    const nodes = leaves(parse(source));
    expect(nodes.every(node => node.type === 'text')).toBe(true);
    expect(nodes.map(node => 'value' in node ? node.value : '').join('')).toBe(source);
  });

  it.each([
    '$x^2$', '$\\bar{x}$', '$5$', 'a $$ E=mc^2 $$2 b',
    '$$\nE=mc^2\n$$', '`$5 and $6`', '```text\n$5 and $6\n```',
    '\\$5 and \\$6',
  ])('leaves valid math, multiple dollars and code untouched: %s', (source) => {
    expect(parse(source)).toEqual(parse(source, false));
  });

  it('guards nested paragraphs and retains their exact source offsets', () => {
    const source = '> 收入 $15,550，日均 $3,110';
    const original = leaves(parse(source, false)).find(node => node.type === 'inlineMath')!;
    const guarded = leaves(parse(source)).find(node => node.position?.start.offset === original.position?.start.offset)!;
    expect(guarded).toEqual({
      type: 'text', position: original.position,
      value: source.slice(original.position!.start.offset, original.position!.end.offset),
    });
  });

  it('does not change block splitting or code-copy dedupe for the sales sentence', () => {
    const sentence = 'Revenue $15,550, average $3,110/day; West $4,750';
    const source = `${sentence}\n\nNext paragraph`;
    const boundaries = (tree: Root) => tree.children.map(node => [node.type, node.position]);
    expect(boundaries(parse(source))).toEqual(boundaries(parse(source, false)));
    const state = updateStreamingMarkdownBlockState(null, source);
    expect(state.blocks.map(block => block.content)).toEqual([`${sentence}\n\n`, 'Next paragraph']);
    expect(state.blocks.map(block => block.sourceOffset)).toEqual([0, sentence.length + 2]);
    expect(updateStreamingMarkdownBlockState(null, sentence).blocks[0].content).toBe(sentence);
    const codeCopy = `${sentence}\n\n[copy](!copy)\n\n\`\`\`text\ncopy\n\`\`\``;
    expect(dedupeCodeCopyLinks(codeCopy)).toBe(`${sentence}\n\n${' '.repeat('[copy](!copy)'.length)}\n\n\`\`\`text\ncopy\n\`\`\``);
  });
});

function parseWithPandoc(source: string): Root {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkTrimCjkAutolink)
    .use(remarkMathPandoc)
    .use(remarkCurrencyDollarGuard);
  return processor.runSync(processor.parse(source), { value: source });
}

function collectTypes(node: Nodes): string[] {
  const types: string[] = [node.type];
  if ('children' in node) {
    for (const child of node.children) {
      types.push(...collectTypes(child));
    }
  }
  return types;
}

describe('remarkMathPandoc', () => {
  const TICKET_SENTENCE = '合计 **$124.68**（明细 $124.68 + 销售税 $0.00，已刷卡支付）。';

  it.each([
    { source: '**$5**', expectStrong: true, strongText: '$5' },
    { source: TICKET_SENTENCE, expectStrong: true, strongText: '$124.68' },
    { source: '$5 和 $10', expectStrong: false, strongText: null },
    { source: '**$1,234.50**', expectStrong: true, strongText: '$1,234.50' },
  ])('preserves bold around currency dollars without literal **: $source', ({ source, expectStrong, strongText }) => {
    const tree = parseWithPandoc(source);
    const types = collectTypes(tree);
    expect(types).not.toContain('inlineMath');
    const text = leaves(tree).map(n => ('value' in n ? n.value : '')).join('');
    expect(text).not.toContain('**');
    if (expectStrong) {
      expect(types).toContain('strong');
      const paragraph = tree.children[0];
      expect(paragraph && 'children' in paragraph).toBe(true);
      const strongNode = paragraph && 'children' in paragraph
        ? paragraph.children.find(c => c.type === 'strong')
        : undefined;
      expect(strongNode).toBeDefined();
      const strongVal = strongNode ? leaves(strongNode).map(n => ('value' in n ? n.value : '')).join('') : '';
      expect(strongVal).toBe(strongText);
    } else {
      expect(types).not.toContain('strong');
    }
  });

  it.each([
    '$x^2$',
    '$\\bar{x}$',
    '$5$',
    '$$\nE=mc^2\n$$',
    'a $$ E=mc^2 $$2 b',
  ])('keeps valid math identical to unguarded remarkMath: %s', (source) => {
    const pandocTree = unified().use(remarkParse).use(remarkMathPandoc).runSync(
      unified().use(remarkParse).use(remarkMathPandoc).parse(source),
      { value: source },
    );
    expect(pandocTree).toEqual(parse(source, false));
  });

  it('agrees across MarkdownCore, streamingMarkdownBlocks, and dedupeCodeCopyLinks chains', () => {
    const markdownCoreTree = parseWithPandoc(TICKET_SENTENCE);
    const streamingParser = unified().use(remarkParse).use(remarkGfm).use(remarkMathPandoc);
    const streamingTree = streamingParser.runSync(streamingParser.parse(TICKET_SENTENCE), { value: TICKET_SENTENCE });
    const dedupeParser = unified().use(remarkParse).use(remarkGfm).use(remarkMathPandoc);
    const dedupeTree = dedupeParser.runSync(dedupeParser.parse(TICKET_SENTENCE), { value: TICKET_SENTENCE });

    for (const tree of [markdownCoreTree, streamingTree, dedupeTree]) {
      const types = collectTypes(tree);
      expect(types).toContain('strong');
      expect(types).not.toContain('inlineMath');
    }
    expect(collectTypes(streamingTree)).toEqual(collectTypes(markdownCoreTree));
    expect(collectTypes(dedupeTree)).toEqual(collectTypes(markdownCoreTree));

    const blockState = updateStreamingMarkdownBlockState(null, TICKET_SENTENCE);
    expect(blockState.blocks.length).toBeGreaterThan(0);
    const reParsed = parseWithPandoc(blockState.blocks.map(b => b.content).join(''));
    expect(collectTypes(reParsed)).toContain('strong');
    expect(collectTypes(reParsed)).not.toContain('inlineMath');

    // Half-streamed prefix must not throw
    expect(() => updateStreamingMarkdownBlockState(null, '合计 **$124.68**（明细 $')).not.toThrow();
    expect(dedupeCodeCopyLinks(TICKET_SENTENCE)).toBe(TICKET_SENTENCE);
  });
});
