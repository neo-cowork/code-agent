export function approvalPreviewBasename(preview: string | undefined): string | undefined {
  const value = preview?.trim();
  if (!value || /[\r\n\0]/.test(value)) return undefined;
  const looksLikePath = /^(?:\/|~|\.{1,2}[\\/]|[A-Za-z]:[\\/])/.test(value) || /[\\/]/.test(value);
  if (!looksLikePath) return /\s/.test(value) ? undefined : value;
  return value.split(/[\\/]+/).filter(Boolean).pop() || undefined;
}
