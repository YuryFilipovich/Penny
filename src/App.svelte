<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { ReceiptText, ChevronDown, Upload, FileText, X, Check, Plus, ArrowRight, ChevronRight, LoaderCircle, Eye, EyeOff, ScanLine, ShieldCheck, Undo2, Redo2, Crosshair, AlertTriangle } from 'lucide-svelte';
  import ReceiptPreview from './ReceiptPreview.svelte';
  import { extractPdf } from './extraction-client';
  import { clearLegacyReceiptStorage } from './receipt-storage';

  import { storageLocations, productGroups, ReviewHistory, fingerprintPdf, createId, validSourceLocation, type Product, type ReviewState, type GrocySync } from './review-model';
  const sample: (Product & { quantity: number; price: number })[] = [
    { id: '1', name: 'Organic whole milk', quantity: 1, unit: 'L', price: 2.49, expiry: '', uncertain: false },
    { id: '2', name: 'Sourdough bread', quantity: 1, unit: 'pcs', price: 3.80, expiry: '', uncertain: false },
    { id: '3', name: 'Avocados', quantity: 2, unit: 'pcs', price: 2.98, expiry: '', uncertain: false },
    { id: '4', name: 'Free-range eggs', quantity: 6, unit: 'pcs', price: 3.29, expiry: '', uncertain: false },
    { id: '5', name: 'Cherry tomatoes', quantity: 0.25, unit: 'kg', price: 2.19, expiry: '', uncertain: true },
    { id: '6', name: 'Greek yogurt', quantity: 0.5, unit: 'kg', price: 2.79, expiry: '', uncertain: false },
    { id: '7', name: 'Bananas', quantity: 1.2, unit: 'kg', price: 1.89, expiry: '', uncertain: false },
    { id: '8', name: 'Extra virgin olive oil', quantity: 0.5, unit: 'L', price: 6.49, expiry: '', uncertain: false }
  ];
  let products = $state<Product[]>([]);
  let loaded = $state(false);
  let hydrated = $state(false);
  let dailyUsage = $state<{limit:number; used:number; remaining:number; resetAt:string; timezone:string} | undefined>();
  const quotaReached = $derived(dailyUsage?.remaining === 0);
  async function refreshUsage() {
    try { const response = await fetch('/api/usage'); if (response.ok) dailyUsage = await response.json(); } catch { /* The server still enforces the limit. */ }
  }
  let checking = $state(false);
  let fingerprint = $state<string | undefined>();
  let undoCount = $state(0);
  let redoCount = $state(0);
  let jumpRequest = $state(0);
  const history = new ReviewHistory<ReviewState>();
  let editBaseline: ReviewState | undefined;
  let editRecorded = false;
  let editTarget: EventTarget | null = null;
  let priorReview: ReviewState | undefined;
  let scanning = $state(false);
  let scanError = $state('');
  let aiExtracted = $state(false);
  let extractionWarnings = $state<string[]>([]);
  let receiptTotal = $state<number | null>(null);
  let scanAbort: AbortController | undefined;
  let saving = $state(false);
  let grocySync = $state<GrocySync | undefined>();
  let confirmError = $state('');
  const syncLocked = $derived(grocySync?.status === 'confirmed' || (grocySync?.count || 0) > 0 || !!grocySync?.uncertain);
  const editingDisabled = $derived(saving || syncLocked);
  let progress = $state(0);
  let fileName = $state('');
  let fileUrl = $state('');
  let currentPdf = $state<Blob | undefined>();
  let source = $state<'sample' | 'upload'>('sample');
  let receiptId = $state<string | null>(null);
  let showOriginal = $state(true);
  let activeProductId = $state<string | null>(null);
  let expandedProductId = $state<string | null>(null);
  let dragging = $state(false);
  let store = $state('');
  let receiptDate = $state('');
  let currency = $state('PLN');
  let toast = $state('');
  let fileInput = $state<HTMLInputElement>();
  let usageTimer: ReturnType<typeof setInterval>;
  let scanTimer: ReturnType<typeof setInterval>;
  let toastTimer: ReturnType<typeof setTimeout>;
  const activeSource = $derived(validSourceLocation(products.find(product => product.id === activeProductId)?.sourceLocation));
  const total = $derived(products.reduce((sum, product) => sum + Number(product.price || 0), 0));
  const needsReview = $derived(products.filter(product => product.uncertain).length);
  const symbol = $derived(new Intl.NumberFormat('pl-PL', { style: 'currency', currency }).formatToParts(0).find(part => part.type === 'currency')?.value);
  const units = ['pcs', 'kg', 'g', 'L', 'ml', 'pack'];

  function money(value: number, code = currency) {
    return new Intl.NumberFormat('pl-PL', { style: 'currency', currency: code }).format(value);
  }
  function notify(message: string) {
    toast = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast = '', 4000);
  }
  function reviewSnapshot(): ReviewState {
    return { products: structuredClone($state.snapshot(products)), store, receiptDate, currency, aiExtracted, extractionWarnings: [...extractionWarnings], receiptTotal };
  }
  function updateHistoryCounts() { undoCount = history.past.length; redoCount = history.future.length; }
  function beginEdit(event: FocusEvent) {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
      editBaseline = reviewSnapshot(); editRecorded = false; editTarget = event.target;
    }
  }
  function recordEdit(event: Event) {
    if (event.target !== editTarget) { editBaseline = priorReview || reviewSnapshot(); editRecorded = false; editTarget = event.target; }
    if (!editRecorded) { history.checkpoint(editBaseline || reviewSnapshot()); updateHistoryCounts(); editRecorded = true; }
  }
  function checkpoint() { history.checkpoint(reviewSnapshot()); updateHistoryCounts(); editBaseline = undefined; editRecorded = false; editTarget = null; }
  function applyReview(value: ReviewState) { products = value.products; store = value.store; receiptDate = value.receiptDate; currency = value.currency; aiExtracted = value.aiExtracted || false; extractionWarnings = value.extractionWarnings || []; receiptTotal = value.receiptTotal ?? null; editBaseline = reviewSnapshot(); editRecorded = false; }
  function undo() { const previous = history.undo(reviewSnapshot()); if (previous) { applyReview(previous); updateHistoryCounts(); } }
  function redo() { const next = history.redo(reviewSnapshot()); if (next) { applyReview(next); updateHistoryCounts(); } }
  function activateProduct(product: Product, open = false) { activeProductId = product.id; jumpRequest++; if (open) showOriginal = true; }
  function keyboardHistory(event: KeyboardEvent) {
    if (!loaded || scanning || editingDisabled || checking || !(event.ctrlKey || event.metaKey)) return;
    if (event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
    else if (event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
  }
  $effect(() => { priorReview = loaded ? reviewSnapshot() : undefined; });
  onMount(() => {
    hydrated = true;
    void refreshUsage();
    usageTimer = setInterval(() => void refreshUsage(), 60_000);
    void clearLegacyReceiptStorage().catch(error => notify(error.message));
  });
  onDestroy(() => {
    clearInterval(scanTimer);
    clearInterval(usageTimer);
    scanAbort?.abort();
    clearTimeout(toastTimer);
    if (fileUrl) URL.revokeObjectURL(fileUrl);
  });
  function setPdf(pdf?: Blob) {
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    currentPdf = pdf;
    fileUrl = pdf ? URL.createObjectURL(pdf) : '';
  }
  function runDemoScan() {
    loaded = false; progress = 0; scanning = true;
    scanTimer = setInterval(() => {
      progress = Math.min(100, progress + 2);
      if (progress === 100) {
        clearInterval(scanTimer);
        products = structuredClone(sample); store = 'Whole Foods Market'; receiptDate = '2026-10-09'; currency = 'PLN';
        scanning = false; loaded = true;
      }
    }, 130);
  }
  async function runExtraction(pdf?: Blob) {
    if (quotaReached) { scanError = 'Daily scan limit reached. Scans reset at midnight in Warsaw.'; void refreshUsage(); return; }
    if (!pdf) { scanError = 'The original PDF is unavailable. Upload it again to scan.'; return; }
    scanAbort?.abort();
    const controller = new AbortController(); scanAbort = controller;
    scanError = ''; progress = 0; scanning = true; loaded = false;
    try {
      const result = await extractPdf(pdf, value => progress = value, controller.signal);
      products = result.products.map(product => ({ ...product, quantity: product.quantity ?? undefined, price: product.price ?? undefined }));
      store = result.store; receiptDate = result.receiptDate; currency = result.currency;
      aiExtracted = true; extractionWarnings = result.warnings; receiptTotal = result.receiptTotal;
      progress = 100; loaded = true;
    } catch (error) { scanError = error instanceof Error ? error.message : 'The receipt could not be processed. Please retry.'; }
    finally { scanning = false; void refreshUsage(); }
  }
  async function startScan(file?: File) {
    if (scanning || saving || checking || !hydrated) return;
    if (file && quotaReached) { notify('Daily scan limit reached. Scans reset at midnight in Warsaw.'); return; }
    if (file && (!file.name.toLowerCase().endsWith('.pdf') || (file.type && file.type !== 'application/pdf'))) { notify('Choose a PDF receipt.'); return; }
    if (file && (file.size === 0 || file.size > 20 * 1024 * 1024)) { notify('Choose a non-empty PDF smaller than 20 MB.'); return; }
    checking = true;
    try {
      const hash = file ? await fingerprintPdf(file) : undefined;
      if (loaded && fingerprint === hash && file) { notify('This PDF is already open in your review.'); return; }
      setPdf(file); fingerprint = hash; receiptId = createId();
      grocySync = undefined; confirmError = '';
      source = file ? 'upload' : 'sample'; fileName = file?.name || 'weekend-groceries.pdf';
      showOriginal = true; activeProductId = null;
      products = []; store = ''; receiptDate = ''; currency = 'PLN'; scanError = ''; aiExtracted = false; extractionWarnings = []; receiptTotal = null; expandedProductId = null;
      history.clear(); updateHistoryCounts(); editBaseline = undefined; editRecorded = false; editTarget = null;
      if (file) void runExtraction(file); else runDemoScan();
    } catch { notify('This PDF could not be opened. Please try again.'); }
    finally { checking = false; }
  }
  function fileChanged(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files?.[0]) startScan(input.files[0]);
    input.value = '';
  }
  function dropFile(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    if (event.dataTransfer?.files[0]) startScan(event.dataTransfer.files[0]);
  }
  async function chooseFile() {
    await tick();
    fileInput?.click();
  }
  async function addProduct() {
    checkpoint();
    products = [...products, { id: createId(), name: '', quantity: 1, unit: '', price: 0, expiry: '', uncertain: false }];
    await tick();
    document.getElementById(`product-${products.at(-1)?.id}`)?.focus();
  }
  async function confirmReceipt() {
    if (saving || checking || grocySync?.status === 'confirmed' || source !== 'upload' || !aiExtracted) return;
    if (!products.length) { notify('Add at least one product.'); return; }
    if (!store.trim() || !receiptDate) { notify('Enter the store and receipt date.'); return; }
    if (products.some(product => !product.name.trim() || !product.unit.trim() || typeof product.quantity !== 'number' || !Number.isFinite(product.quantity) || product.quantity <= 0 || typeof product.price !== 'number' || !Number.isFinite(product.price) || product.price < 0)) {
      notify('Check each product’s name, quantity, unit, and price.'); return;
    }
    const incomplete = products.find(product => !product.expiry || !product.location || !product.productGroup);
    if (incomplete) { expandedProductId = incomplete.id; confirmError = `Complete the expiration date, storage location, and group for ${incomplete.name}. Choose “Does not expire” when appropriate.`; return; }
    saving = true; confirmError = '';
    receiptId ||= createId();
    const priorSync = grocySync ? $state.snapshot(grocySync) : undefined;
    grocySync = {status:'partial',count:grocySync?.count || 0,total:products.length,uncertain:true};
    try {
      const response = await fetch('/api/receipts/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:receiptId,fingerprint,store:store.trim(),receiptDate,currency,products:$state.snapshot(products)})});
      const result = await response.json();
      if (!response.ok) {
        grocySync = result.count > 0 || result.uncertain ? {status:'partial',count:result.count || 0,total:products.length,uncertain:result.uncertain} : priorSync;
        confirmError = result.error || 'Grocy confirmation failed. Try again.'; return;
      }
      grocySync = {status:'confirmed',count:result.count,total:result.total,confirmedAt:result.confirmedAt};
      notify('Products added to Grocy.');
    } catch { confirmError = 'Connection interrupted. Keep this page open and retry to check the import status.'; }
    finally { saving = false; }
  }
</script>

<svelte:window onkeydown={keyboardHistory}/>
<div class="app-shell">
  <header class="app-header">
    <a href="/" class="brand" onclick={(event) => { event.preventDefault(); }}><span class="brand-mark"><ReceiptText size={20} strokeWidth={1.7}/></span>Penny</a>

  </header>

  <main>
    <input disabled={saving} bind:this={fileInput} type="file" accept="application/pdf,.pdf" onchange={fileChanged} hidden/>
      <div class="page-heading">
        <div><div class="eyebrow">RECEIPTS, SIMPLIFIED</div><h1>{scanning ? 'Scanning receipt' : loaded ? (grocySync?.status === 'confirmed' ? 'Receipt confirmed' : 'Review receipt') : scanError ? 'Receipt scan' : 'Upload a receipt'}</h1><p>{scanning ? 'Reading the document and organizing its details.' : loaded ? (grocySync?.status === 'confirmed' ? 'Products are in Grocy. This review stays available until you close or refresh the page.' : 'Compare the products with the original and make any corrections.') : scanError ? 'Your original receipt remains available in this page so you can retry the scan.' : 'Turn a grocery receipt into a clear, editable product list.'}</p></div>
        {#if loaded}<button class="secondary-button" disabled={saving || checking} onclick={chooseFile}><Upload size={15}/>New receipt</button>{/if}
      </div>

      {#if checking}<p class="checking-file" role="status"><LoaderCircle size={14} class="spin"/>Checking receipt…</p>{/if}
      {#if scanning}
        <div class="scan-workspace">
          <ReceiptPreview {fileUrl} {fileName} {source} lines={sample} {scanning} {progress}/>
          <section class="scan-details" aria-label="Scanning progress">
            <span class="scan-status-icon"><ScanLine size={24} strokeWidth={1.5}/></span>
            <div class="eyebrow">DOCUMENT PROCESSING</div>
            <h2 aria-live="polite">{progress < 25 ? 'Reading the document' : progress < 70 ? 'Identifying products' : progress < 90 ? 'Suggesting locations and groups' : 'Preparing your review'}</h2>
            <p>The original stays visible throughout the scan.</p>
            <div class="scan-progress-label"><span>Scan progress</span><strong>{progress}%</strong></div>
            <div class="progress-track" role="progressbar" aria-label="Receipt scan progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><div style={`width: ${progress}%`}></div></div>
            <ol class="scan-stages">
              {#each ['Read document', 'Extract products & prices', 'Suggest locations & groups', 'Check receipt totals'] as stage, index}
                <li class:stage-complete={progress >= [25,70,90,100][index]} class:stage-current={progress >= [0,25,70,90][index] && progress < [25,70,90,100][index]}><span>{#if progress >= [25,70,90,100][index]}<Check size={13}/>{:else if progress >= [0,25,70,90][index]}<LoaderCircle size={13} class="spin"/>{:else}<span class="stage-dot"></span>{/if}</span>{stage}</li>
              {/each}
            </ol>
            <div class="scan-disclaimer"><ShieldCheck size={15}/><p>{source === 'sample' ? 'Sample scan. No receipt is sent to AI providers.' : 'OpenAI reads the receipt. Jev suggests locations and groups. You can review every detail.'}</p></div>
            {#if source === 'upload'}<button class="text-button cancel-scan" onclick={() => scanAbort?.abort()}>Cancel scan</button>{/if}
          </section>
        </div>
      {:else if scanError}
        <div class="scan-workspace"><ReceiptPreview {fileUrl} {fileName} {source} lines={sample}/><section class="scan-details"><span class="scan-status-icon"><AlertTriangle size={24}/></span><h2>Scan needs attention</h2><p role="alert">{scanError}</p><div class="scan-error-actions"><button class="primary-button" disabled={!currentPdf || quotaReached} onclick={() => runExtraction(currentPdf)}>Retry scan<ArrowRight size={15}/></button><button class="secondary-button" onclick={chooseFile}>Choose another PDF</button></div></section></div>
      {:else if !loaded}
        <section class:dragging class="upload-card" aria-label="Upload a PDF receipt" ondragover={(event) => { event.preventDefault(); dragging = true; }} ondragleave={() => dragging = false} ondrop={dropFile}>
          {#if dailyUsage}<p class="daily-usage" role="status">{dailyUsage.used} of {dailyUsage.limit} scans used today{quotaReached ? " · Resets at midnight in Warsaw" : ""}</p>{/if}
          <span class="upload-mark"><Upload size={29} strokeWidth={1.4}/></span>
          <h2>Drop your receipt here</h2><p>PDF files up to 20 MB</p>
          <button class="primary-button" disabled={checking || !hydrated || quotaReached} onclick={chooseFile}>Choose PDF<ArrowRight size={16}/></button>
          <div class="sample-link">or <button disabled={checking || !hydrated} onclick={() => startScan()}>try a sample receipt</button></div>
        </section>
        <p class="demo-disclosure">Uploaded PDFs are sent to OpenAI for reading. Jev suggests locations and groups. Penny keeps no receipt history. Refreshing clears the review.</p>
      {:else}
        <div class="review-meta" onfocusin={beginEdit} oninput={recordEdit}>
          <div class="store-field"><label for="store">Store</label><input disabled={editingDisabled} id="store" bind:value={store}/></div>
          <div><label for="receipt-date">Receipt date</label><input disabled={editingDisabled} id="receipt-date" type="date" bind:value={receiptDate}/></div>
          <div class="currency-field"><label for="currency">Currency</label><select disabled={editingDisabled} id="currency" bind:value={currency}><option value="PLN">PLN</option><option value="EUR">EUR</option><option value="GBP">GBP</option><option value="USD">USD</option></select></div>
          <button class="original-toggle" aria-expanded={showOriginal} onclick={() => showOriginal = !showOriginal}>{#if showOriginal}<EyeOff size={16}/>Hide receipt{:else}<Eye size={16}/>Show receipt{/if}</button>
        </div>
        {#if extractionWarnings.length}<div class="extraction-notice" role="status"><AlertTriangle size={16}/><div>{#each extractionWarnings as warning}<p>{warning}</p>{/each}{#if receiptTotal !== null}<p>Printed receipt total: {money(receiptTotal)}</p>{/if}</div></div>{/if}
        {#if confirmError || grocySync}<div class="extraction-notice" class:sync-confirmed={grocySync?.status === 'confirmed'} role="status">{#if grocySync?.status === 'confirmed'}<Check size={16}/>{:else}<AlertTriangle size={16}/>{/if}<div>{#if grocySync}<p>{grocySync.count} of {grocySync.total} products confirmed in Grocy.{' '}{#if grocySync.status === 'confirmed'} Stock corrections can be made in Grocy.{:else if syncLocked} Keep this review unchanged and retry to resume safely.{/if}</p>{/if}{#if confirmError}<p>{confirmError}</p>{/if}</div></div>{/if}
        <div class="review-layout" class:with-original={showOriginal}>
          <section class="products-card">
            <div class="table-heading"><div><h2>Products <span>{products.length}</span></h2>{#if needsReview}<span class="review-status"><span></span>{needsReview} {needsReview === 1 ? 'detail' : 'details'} to verify</span>{/if}</div><div class="table-edit-actions"><button class="history-button" aria-label="Undo last edit" title="Undo (Ctrl/⌘ Z)" disabled={!undoCount || editingDisabled} onclick={undo}><Undo2 size={15}/></button><button class="history-button" aria-label="Redo last edit" title="Redo (Ctrl/⌘ Shift Z)" disabled={!redoCount || editingDisabled} onclick={redo}><Redo2 size={15}/></button><button class="text-button" disabled={editingDisabled} onclick={addProduct}><Plus size={15}/>Add product</button></div></div>
            <datalist id="quantity-units">{#each units as unit}<option value={unit}></option>{/each}</datalist>
            <div class="table-scroll" onfocusin={beginEdit} oninput={recordEdit}><table class="review-table"><thead><tr><th>Product</th><th>Quantity</th><th>Unit</th><th>Line price</th><th><span class="sr-only">Details</span></th></tr></thead><tbody>
              {#each products as product (product.id)}
                <tr class:needs-review={product.uncertain} class:active-product={showOriginal && activeProductId === product.id} onfocusin={() => activateProduct(product)}>
                  <td><div class="product-name"><input disabled={editingDisabled} id={`product-${product.id}`} aria-label={`Product name for ${product.name || 'new product'}`} placeholder="Product name" bind:value={product.name} onchange={() => product.uncertain = false}/>{#if product.uncertain}<button class="verify-button" disabled={editingDisabled} title="Verify product details" aria-label={`Confirm ${product.name}`} onclick={() => { checkpoint(); product.uncertain = false; }}><Check size={13}/></button>{/if}{#if validSourceLocation(product.sourceLocation)}<button class="source-jump" aria-label={`Jump to source for ${product.name}`} title="Jump to original PDF location" onclick={() => activateProduct(product, true)}><Crosshair size={14}/></button>{/if}</div>
                  </td>
                  <td><input disabled={editingDisabled} class="quantity-input" aria-label={`Quantity for ${product.name || 'new product'}`} type="number" min="0.01" step="any" bind:value={product.quantity}/></td>
                  <td><input disabled={editingDisabled} class="unit-input" aria-label={`Unit for ${product.name || 'new product'}`} list="quantity-units" placeholder="Unit" bind:value={product.unit}/></td>
                  <td><div class="price-input"><span>{symbol}</span><input disabled={editingDisabled} aria-label={`Line price for ${product.name || 'new product'}`} type="number" min="0" step="0.01" bind:value={product.price}/></div></td>
                  <td><button class="row-details-toggle" disabled={saving} aria-label={`Details for ${product.name || 'new product'}`} aria-expanded={expandedProductId === product.id} aria-controls={`details-${product.id}`} onclick={() => expandedProductId = expandedProductId === product.id ? null : product.id}>Details<ChevronDown size={13} class={expandedProductId === product.id ? 'rotated' : ''}/></button></td>
                </tr>
                {#if expandedProductId === product.id}
                  <tr class="product-detail-row"><td colspan="5"><div id={`details-${product.id}`} class="expanded-product-details" onfocusin={() => activateProduct(product)}>
                    <label><span>Expiration date</span><input disabled={editingDisabled || product.expiry === '2999-12-31'} class="date-input" type="date" aria-label={`Expiration date for ${product.name || 'new product'}`} bind:value={product.expiry}/><span class="no-expiry"><input disabled={editingDisabled} type="checkbox" aria-label={`Does not expire: ${product.name}`} checked={product.expiry === '2999-12-31'} onchange={(event) => { recordEdit(event); product.expiry = event.currentTarget.checked ? '2999-12-31' : ''; }}/>Does not expire</span></label>
                    <label><span>Storage location</span><select disabled={editingDisabled} aria-label={`Storage location for ${product.name || 'new product'}`} value={product.location || ''} onchange={(event) => { recordEdit(event); product.location = event.currentTarget.value; }}><option value="">Unassigned</option>{#each storageLocations as location}<option value={location}>{location}</option>{/each}</select></label>
                    <label><span>Product group</span><select disabled={editingDisabled} aria-label={`Product group for ${product.name || 'new product'}`} value={product.productGroup || ''} onchange={(event) => { recordEdit(event); product.productGroup = event.currentTarget.value; }}><option value="">Unassigned</option>{#each productGroups as group}<option value={group}>{group}</option>{/each}</select></label>
                    <button class="detail-remove" disabled={editingDisabled} aria-label={`Remove ${product.name || 'new product'}`} onclick={() => { checkpoint(); products = products.filter(item => item.id !== product.id); expandedProductId = null; }}><X size={14}/>Remove</button>
                  </div></td></tr>
                {/if}
              {/each}
              {#if !products.length}<tr><td colspan="5" class="empty-table">No products. Add a product to continue.</td></tr>{/if}
            </tbody></table></div>
            <div class="review-bottom"><span>Receipt total <strong>{money(total)}</strong></span>{#if source === 'upload' && aiExtracted}<button class="primary-button" disabled={saving || !products.length || grocySync?.status === 'confirmed'} onclick={confirmReceipt}>{#if saving}<LoaderCircle size={15} class="spin"/>Confirming…{:else}{grocySync?.status === 'confirmed' ? 'Confirmed in Grocy' : grocySync ? 'Retry confirmation' : 'Confirm & send to Grocy'}<Check size={15}/>{/if}</button>{/if}</div>
          </section>
          {#if showOriginal}
            <aside class="comparison-pane"><ReceiptPreview {fileUrl} {fileName} {source} lines={sample} activeId={activeProductId} sourceLocation={activeSource} {jumpRequest}/></aside>
          {/if}
        </div>
        <div class="review-footnotes"><p class="demo-disclosure">{grocySync?.status === 'confirmed' ? 'Confirmed · Nothing saved in Penny' : aiExtracted ? 'AI suggestions · Check against the original before confirming' : 'Preview receipt · Sample data'}</p><span class="draft-status">Temporary review · Refresh clears this page</span></div>
      {/if}
  </main>
</div>
{#if toast}<div class="toast" role="status"><Check size={16}/>{toast}<button aria-label="Dismiss notification" onclick={() => toast = ''}><X size={15}/></button></div>{/if}
