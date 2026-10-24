import { fileURLToPath } from 'node:url';
import type { SourceLocation } from '../src/review-model.ts';

export type PdfLine = { id: string; text: string; location: SourceLocation };
export const normalizeText = (text: string) => text.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Use the PDF's text geometry; never ask a language model to invent a bounding box. */
export async function readPdfLines(pdf: Uint8Array): Promise<PdfLine[]> {
  const { getDocument, Util } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(pdf), standardFontDataUrl: fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)) });
  const lines: PdfLine[] = [];
  try {
    const document = await task.promise;
    if (document.numPages > 30) throw new Error('Use a receipt with no more than 30 pages.');
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const rows: { text: string; x: number; y: number; width: number; height: number }[][] = [];
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const t = Util.transform(viewport.transform, item.transform);
        const height = Math.hypot(t[2], t[3]) || item.height || 10;
        const vertical = Math.abs(t[1]) > Math.abs(t[0]);
        // Rotated text is readable by OpenAI, but without a reliable rectangle we omit its source link.
        if (vertical) continue;
        const word = { text: item.str, x: t[4], y: t[5] - height, width: item.width, height };
        let row = rows.find(row => Math.abs(row[0].y - word.y) < Math.max(2, height * .3));
        if (!row) { row = []; rows.push(row); }
        row.push(word);
      }
      rows.sort((a, b) => a[0].y - b[0].y);
      for (const row of rows) {
        row.sort((a, b) => a.x - b.x);
        const text = row.map(word => word.text).join(' ');
        const x = Math.max(0, Math.min(...row.map(word => word.x)) - 2);
        const y = Math.max(0, Math.min(...row.map(word => word.y)) - 2);
        const right = Math.min(viewport.width, Math.max(...row.map(word => word.x + word.width)) + 2);
        const bottom = Math.min(viewport.height, Math.max(...row.map(word => word.y + word.height)) + 2);
        if (right <= x || bottom <= y) continue;
        lines.push({ id: `p${pageNumber}-l${lines.length + 1}`, text, location: { page: pageNumber, x: x / viewport.width, y: y / viewport.height, width: (right - x) / viewport.width, height: (bottom - y) / viewport.height, text } });
      }
      page.cleanup();
    }
    return lines;
  } finally { await task.destroy(); }
}

export function resolveSource(lineId: string | null, rawName: string, lines: PdfLine[]): SourceLocation | undefined {
  const name = normalizeText(rawName);
  if (name.length < 3) return;
  const matches = lines.filter(line => normalizeText(line.text).includes(name));
  const exact = matches.find(line => line.id === lineId);
  // Repeated receipt names need an explicit line ID to disambiguate.
  return exact?.location || (matches.length === 1 ? matches[0].location : undefined);
}
