import type { RuntimeContext } from './runtimeContext';

/** Non-streaming, tool-free inference for nested tool generation. */
export function toolModelCallback(ctx: RuntimeContext): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    const response = await ctx.modelRouter.inference(
      [{ role: 'user', content: prompt }], [], ctx.modelConfig,
    );
    return typeof response.content === 'string' ? response.content : '';
  };
}
