export const FONT_SIZE_PX = { small: 13, medium: 14, large: 16 } as const;

type FontSizeName = keyof typeof FONT_SIZE_PX;

export function getFontSizeName(px: unknown): FontSizeName | null {
  const sizes = Object.keys(FONT_SIZE_PX) as FontSizeName[];
  return sizes.find((size) => FONT_SIZE_PX[size] === px) ?? null;
}

export function applyFontSizeBase(px: unknown): void {
  const style = globalThis.document?.documentElement?.style;
  if (!style) return;

  if (px === FONT_SIZE_PX.small || px === FONT_SIZE_PX.large) {
    style.setProperty('--font-size-base', `${px}px`);
  } else {
    style.removeProperty('--font-size-base');
  }
}
