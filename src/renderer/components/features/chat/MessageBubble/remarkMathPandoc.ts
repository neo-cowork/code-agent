import remarkMath from 'remark-math';
import type { Options as RemarkMathOptions } from 'remark-math';
import type { Root } from 'mdast';
import type { Plugin } from 'unified';

type State = (code: number | null) => State | undefined;

interface TokenizeContext {
  now(): { line: number; column: number; offset: number };
  sliceSerialize(token: {
    start: { line: number; column: number; offset: number };
    end: { line: number; column: number; offset: number };
  }): string;
}

interface TextConstruct {
  tokenize?: (
    this: TokenizeContext,
    effects: unknown,
    ok: State,
    nok: State,
  ) => State;
}

interface MicromarkExtensionLike {
  text?: Record<number, TextConstruct | TextConstruct[] | null | undefined>;
}

function wrapDollarConstruct(construct: TextConstruct): TextConstruct {
  const original = construct.tokenize;
  if (!original) return construct;
  return {
    ...construct,
    tokenize(effects, ok, nok) {
      const start = this.now();
      const wrappedOk: State = (code) => {
        const slice = this.sliceSerialize({ start, end: this.now() });
        if (!slice.startsWith('$$')) {
          const followedByDigit = code !== null && code >= 48 && code <= 57;
          const spaceAfterOpener = /\s/.test(slice[1] ?? '');
          const spaceBeforeCloser = /\s/.test(slice.at(-2) ?? '');
          if (followedByDigit || spaceAfterOpener || spaceBeforeCloser) {
            return nok(code);
          }
        }
        return ok(code);
      };
      return original.call(this, effects, wrappedOk, nok);
    },
  };
}

/**
 * Wraps `remark-math` so a closing single `$` immediately followed by a digit
 * (Pandoc's currency rule) does not close an inline math span during lexing.
 */
export const remarkMathPandoc: Plugin<[RemarkMathOptions?], Root> = function (options) {
  remarkMath.call(this, options);
  const data = this.data() as { micromarkExtensions?: MicromarkExtensionLike[] };
  const extensions = data.micromarkExtensions;
  const lastExt = extensions?.at(-1);
  const dollarEntry = lastExt?.text?.[36];
  if (!extensions || !lastExt || !dollarEntry) return;

  const wrappedDollar = Array.isArray(dollarEntry)
    ? dollarEntry.map(wrapDollarConstruct)
    : wrapDollarConstruct(dollarEntry);

  extensions[extensions.length - 1] = {
    ...lastExt,
    text: {
      ...lastExt.text,
      36: wrappedDollar,
    },
  };
};
