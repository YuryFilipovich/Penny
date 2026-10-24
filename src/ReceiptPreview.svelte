<script lang="ts">
  import type { SourceLocation } from './review-model';
  import PdfViewer from './PdfViewer.svelte';
  import { FileText, ExternalLink, Minus, Plus } from 'lucide-svelte';
  type ReceiptLine = { id: string; name: string; quantity: number; unit: string; price: number };
  let { fileUrl, fileName, source, lines, scanning = false, progress = 0, activeId = null, sourceLocation, jumpRequest = 0 }: {
    fileUrl: string; fileName: string; source: 'sample' | 'upload'; lines: ReceiptLine[];
    scanning?: boolean; progress?: number; activeId?: string | null; sourceLocation?: SourceLocation; jumpRequest?: number;
  } = $props();
  let zoom = $state(100);
  let surface = $state<HTMLDivElement>();
  $effect(() => {
    if (!activeId || scanning || source !== 'sample' || !surface) return;
    const line = Array.from(surface.querySelectorAll<HTMLElement>('[data-source-id]')).find(element => element.dataset.sourceId === activeId);
    if (!line) return;
    const bounds = surface.getBoundingClientRect();
    const row = line.getBoundingClientRect();
    if (row.top < bounds.top || row.bottom > bounds.bottom) {
      surface.scrollTo({ top: surface.scrollTop + row.top - bounds.top - (bounds.height - row.height) / 2, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    }
  });
</script>

<section class="receipt-viewer" class:is-scanning={scanning} aria-label="Original receipt">
  <div class="viewer-heading"><FileText size={16}/><div><strong>Original receipt</strong><span title={fileName}>{fileName}</span></div>{#if fileUrl}<a href={fileUrl} target="_blank" rel="noopener noreferrer" class="viewer-open" aria-label="Open original PDF in a new tab" title="Open original PDF"><ExternalLink size={15}/></a>{:else if source === 'sample'}<div class="viewer-zoom"><button disabled={zoom === 80} aria-label="Zoom out receipt" onclick={() => zoom = Math.max(80, zoom - 20)}><Minus size={13}/></button><span>{zoom}%</span><button disabled={zoom === 160} aria-label="Zoom in receipt" onclick={() => zoom = Math.min(160, zoom + 20)}><Plus size={13}/></button></div>{/if}</div>
  <div class="viewer-surface" bind:this={surface}>
    {#if fileUrl}<PdfViewer url={fileUrl} {sourceLocation} {jumpRequest}/>
    {:else if source === 'sample'}
      <div class="receipt-paper-wrap"><div class="comparison-paper" style={`--receipt-zoom: ${zoom / 100}`}>
        <h3>WHOLE FOODS MARKET</h3><p>95 Kensington High Street<br/>London, W8 5SA</p><div class="paper-date">09/10/2026 <span>12:42</span></div><hr/>
        {#each lines as line}<div class="receipt-source-line" class:source-active={activeId === line.id} class:source-detected={scanning && progress > 25 + Number(line.id) * 6} data-source-id={line.id}><div><span>{line.name}</span><small>{line.quantity} {line.unit}</small></div><b>{line.price.toFixed(2)}</b></div>{/each}
        <hr/><div class="comparison-total"><strong>TOTAL</strong><strong>25.92</strong></div><p class="paper-payment">CARD PAYMENT</p><div class="paper-barcode"></div><small class="paper-reference">SAMPLE RECEIPT · 008429</small>
      </div></div>
    {:else}<div class="pdf-unavailable"><FileText size={26}/><p>Original PDF unavailable on this device.</p></div>{/if}
    {#if scanning}<div class="scanner-overlay" aria-hidden="true"><div class="scanner-sweep"></div><span class="scanner-corner top-left"></span><span class="scanner-corner top-right"></span><span class="scanner-corner bottom-left"></span><span class="scanner-corner bottom-right"></span></div>{/if}
  </div>
  <div class="viewer-caption">{scanning ? 'Scanning document' : fileUrl ? 'Zoom or navigate pages to compare the original details.' : source === 'sample' ? 'Select a product field to highlight its source line.' : 'Reviewed details are still available in the table.'}</div>
</section>
