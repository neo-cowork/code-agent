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

function wrapDollarConstruct(construct: TextConstruct, rejected: WeakMap<object, Set<number>>): TextConstruct {
  const original = construct.tokenize;
  if (!original) return construct;
  return {
    ...construct,
    tokenize(effects, ok, nok) {
      // Keyed by the tokenizer, which lives for one block of text.
      const rejectedHere = rejected.get(this) ?? new Set<number>();
      rejected.set(this, rejectedHere);
      const openerOffset = this.now().offset;
      // micromark retries the rejected `$` as an opener; keep it plain text.
      if (rejectedHere.has(openerOffset)) return (code) => nok(code);
      const start = this.now();
      const wrappedOk: State = (code) => {
        const end = this.now();
        const slice = this.sliceSerialize({ start, end });
        if (!slice.startsWith('$$') && code !== null && code >= 48 && code <= 57) {
          rejectedHere.add(end.offset - 1);
          return nok(code);
        }
        return ok(code);
      };
      return original.call(this, effects, wrappedOk, nok);
    },
  };
}

/**
 * Wraps `remark-math` so a closing single `$` followed by a digit (Pandoc's
 * currency rule) does not close an inline math span during lexing. That `$`
 * stays plain text as an opener too: the next `$` pairs as it did before, so
 * the prose up to it is not turned into math.
 */
export const remarkMathPandoc: Plugin<[RemarkMathOptions?], Root> = function (options) {
  remarkMath.call(this, options);
  const data = this.data() as { micromarkExtensions?: MicromarkExtensionLike[] };
  const extensions = data.micromarkExtensions;
  const lastExt = extensions?.at(-1);
  const dollarEntry = lastExt?.text?.[36];
  if (!extensions || !lastExt || !dollarEntry) return;

  const rejected = new WeakMap<object, Set<number>>();
  const wrappedDollar = Array.isArray(dollarEntry)
    ? dollarEntry.map(construct => wrapDollarConstruct(construct, rejected))
    : wrapDollarConstruct(dollarEntry, rejected);

  extensions[extensions.length - 1] = {
    ...lastExt,
    text: {
      ...lastExt.text,
      36: wrappedDollar,
    },
  };
};
