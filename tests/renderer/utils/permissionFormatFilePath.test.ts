import { describe, it, expect } from 'vitest';
import { formatFilePath } from '../../../src/renderer/components/PermissionDialog/utils';

describe('formatFilePath upload/temp paths', () => {
  it.each([
    ['/var/folders/ab/cd/T/sales.csv', 'sales.csv'],
    ['/tmp/x/y/sales.csv', 'sales.csv'],
    ['/private/tmp/sales.csv', 'sales.csv'],
    ['/tmp/code-agent-uploads/abc/sales.csv', 'sales.csv'],
    ['/Users/me/Library/Application Support/x/uploads/123e4567-e89b-12d3-a456-426614174000/sales.csv', 'sales.csv'],
  ])('%s -> file name', (input, out) => {
    expect(formatFilePath(input)).toBe(out);
  });
  it('other paths unchanged', () => {
    expect(formatFilePath('/Users/me/Documents/sales.csv')).toBe('/Users/me/Documents/sales.csv');
  });
});
