import { describe, expect, it } from 'vitest';
import { bashSchema } from '../../../../../src/host/tools/modules/shell/bash.schema';

describe('Bash schema description', () => {
  it('steers several named deletions into one rm and a path-exact check', () => {
    expect(bashSchema.description).toContain('put every path into ONE `rm` command');
    expect(bashSchema.description).toContain('never kept files');
  });
});
