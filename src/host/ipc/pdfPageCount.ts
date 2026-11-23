/** pdftotext terminates each page, including blank pages, with a form feed. */
export function countPdfTextPages(text: string): number {
  const terminatedPages = (text.match(/\f/g) || []).length;
  const trailingText = text.slice(text.lastIndexOf('\f') + 1);
  return terminatedPages + (trailingText.trim() ? 1 : 0);
}
