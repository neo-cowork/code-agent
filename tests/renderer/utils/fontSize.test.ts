// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { applyFontSizeBase } from '../../../src/renderer/utils/fontSize';

const style = document.documentElement.style;
const property = '--font-size-base';

afterEach(() => { style.removeProperty(property); });

it.each([
  [13, '13px'],
  [16, '16px'],
  [14, ''],
  [99, ''],
  [undefined, ''],
  ['16', ''],
  [NaN, ''],
])('applies the font size %s as inline value %j', (px, expected) => {
  style.setProperty(property, '20px');
  expect(() => applyFontSizeBase(px)).not.toThrow();
  expect(style.getPropertyValue(property)).toBe(expected);
});
