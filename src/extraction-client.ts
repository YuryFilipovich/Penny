import type { ExtractionResult } from './review-model.js';

export async function extractPdf(pdf: Blob, onProgress: (progress: number) => void, signal: AbortSignal): Promise<ExtractionResult> {
  let response: Response;
  try { response = await fetch('/api/receipts/extract', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: pdf, signal }); }
  catch { if (signal.aborted) throw new Error('Scan cancelled. You can retry when ready.'); throw new Error('Penny’s backend could not be reached. Start it with npm run server.'); }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || 'The receipt could not be processed. Please retry.');
  }
  if (!response.body) throw new Error('The scan response was empty. Please retry.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: ExtractionResult | undefined;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const records = buffer.split('\n');
      buffer = records.pop() || '';
      if (done && buffer.trim()) records.push(buffer);
      for (const record of records) {
        if (!record.trim()) continue;
        const event = JSON.parse(record);
        if (event.type === 'error') throw new Error(event.message || 'The scan failed. Please retry.');
        if (event.type === 'progress' && Number.isFinite(event.progress)) onProgress(Math.max(0,Math.min(99,event.progress)));
        if (event.type === 'result') result = event.result;
      }
      if (done) break;
    }
  } catch (error) {
    if (signal.aborted) throw new Error('Scan cancelled. You can retry when ready.');
    throw error;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (!result || !Array.isArray(result.products)) throw new Error('The scan ended before the receipt was ready. Please retry.');
  return result;
}
