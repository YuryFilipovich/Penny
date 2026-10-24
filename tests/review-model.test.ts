import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewHistory, fingerprintPdf, validSourceLocation } from '../src/review-model.ts';

test('history restores deletions and metadata without retaining mutable references', () => {
  const history = new ReviewHistory<{ products: { name: string }[]; currency: string }>();
  const original = { products: [{ name: 'Milk' }], currency: 'PLN' };
  history.checkpoint(original);
  original.products[0].name = 'Edited';
  const recovered = history.undo({ products: [], currency: 'EUR' });
  assert.deepEqual(recovered, { products: [{ name: 'Milk' }], currency: 'PLN' });
  assert.deepEqual(history.redo(recovered!), { products: [], currency: 'EUR' });
});

test('a new edit after undo clears the redo branch and history remains bounded', () => {
  const history = new ReviewHistory<number>(3);
  for (let value = 0; value < 6; value++) history.checkpoint(value);
  assert.deepEqual(history.past, [3,4,5]);
  assert.equal(history.undo(6), 5);
  history.checkpoint(9);
  assert.equal(history.redo(10), undefined);
});

test('fingerprints detect renamed duplicates and distinguish changed bytes', async () => {
  const first = new Blob(['%PDF-1.4\nreceipt data']);
  const renamed = new Blob(['%PDF-1.4\nreceipt data']);
  const changed = new Blob(['%PDF-1.4\nother receipt']);
  assert.equal(await fingerprintPdf(first), await fingerprintPdf(renamed));
  assert.notEqual(await fingerprintPdf(first), await fingerprintPdf(changed));
});

test('source locations require a real page and an in-page normalized rectangle', () => {
  const valid = { page: 2, x: .1, y: .2, width: .7, height: .05 };
  assert.deepEqual(validSourceLocation(valid), valid);
  for (const value of [{ ...valid, page: 0 }, { ...valid, x: -.1 }, { ...valid, width: 1 }, { ...valid, height: 0 }, { ...valid, y: NaN }]) assert.equal(validSourceLocation(value), undefined);
});


test('plain HTTP fingerprint and IDs do not require secure-context crypto APIs', async () => {
  const { createId } = await import('../src/review-model.ts');
  const { createHash } = await import('node:crypto');
  const pdf=new Blob(['%PDF-1.4\nreceipt data']);
  assert.equal(await fingerprintPdf(pdf), createHash('sha256').update(Buffer.from(await pdf.arrayBuffer())).digest('hex'));
  // A LAN browser exposes getRandomValues but no subtle or randomUUID.
  const httpCrypto={getRandomValues:globalThis.crypto.getRandomValues.bind(globalThis.crypto)};
  const first=createId(httpCrypto),second=createId(httpCrypto);
  assert.match(first,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first,second);
});
