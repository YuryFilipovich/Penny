/** One-time cleanup of data retained by older Penny versions. Never stores receipts. */
export async function clearLegacyReceiptStorage(): Promise<void> {
  let failed = false;
  try { localStorage.removeItem('alfred-receipts'); localStorage.removeItem('alfred-draft'); }
  catch { failed = true; }
  try {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('alfred-receipts');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Close older Penny tabs to remove their saved PDFs.'));
    });
  } catch { failed = true; }
  if (failed) throw new Error('Older saved data could not be cleared. Close other Penny tabs and clear this site’s browser data.');
}
