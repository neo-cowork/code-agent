import type { EnvBlockerClass } from '../../../shared/contract/envAssist';

/** A dispatched tool has no terminal result yet; never turn this into complete(false). */
export class EnvBlockedError extends Error {
  readonly class: EnvBlockerClass;
  constructor(
    blockerClass: EnvBlockerClass,
    readonly target: string,
    readonly toolCallId: string,
  ) {
    super('env_blocked');
    this.name = 'EnvBlockedError';
    this.class = blockerClass;
  }
}
