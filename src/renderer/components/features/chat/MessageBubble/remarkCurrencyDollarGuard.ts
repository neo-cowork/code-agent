import type { Parent, Root, RootContent } from 'mdast';
import type { Plugin } from 'unified';

/** Apply Pandoc's dollar delimiter rules after remark-math, preserving source text. */
export const remarkCurrencyDollarGuard: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file.value);
  const visit = (parent: Parent): void => {
    parent.children.forEach((node, index) => {
      if (node.type === 'inlineMath') {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start === undefined || end === undefined) return;
        const original = source.slice(start, end);
        // Multiple-dollar inline math and display math keep their existing behavior.
        if (!original.startsWith('$') || original.startsWith('$$')) return;
        // Inspect the source: remark-math can trim one space from both value ends.
        if (/\s/.test(original[1] ?? '')
          || /\s/.test(original.at(-2) ?? '')
          || /[0-9]/.test(source[end] ?? '')) {
          parent.children[index] = {
            type: 'text', value: original, position: node.position,
          } satisfies RootContent;
        }
      } else if ('children' in node) {
        visit(node);
      }
    });
  };
  visit(tree);
};
