import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMath from 'remark-math';
import type { Nodes, Root } from 'mdast';
import { remarkCurrencyDollarGuard } from '../../../src/renderer/components/features/chat/MessageBubble/remarkCurrencyDollarGuard';
import { updateStreamingMarkdownBlockState } from '../../../src/renderer/components/features/chat/MessageBubble/streamingMarkdownBlocks';
import { dedupeCodeCopyLinks } from '../../../src/renderer/components/features/chat/MessageBubble/dedupeCodeCopyLinks';

function parse(source: string, guarded = true): Root {
  const processor = unified().use(remarkParse).use(remarkMath);
  if (guarded) processor.use(remarkCurrencyDollarGuard);
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
