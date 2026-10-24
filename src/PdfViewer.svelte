<script lang="ts">
  import { validSourceLocation, type SourceLocation } from './review-model';
  import { onMount } from 'svelte';
  import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist';
  import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
  import { Minus, Plus, ChevronLeft, ChevronRight, LoaderCircle, FileWarning } from 'lucide-svelte';
  let { url, sourceLocation, jumpRequest = 0 }: { url: string; sourceLocation?: SourceLocation; jumpRequest?: number } = $props();
  const location = $derived(validSourceLocation(sourceLocation));
  let renderedPage = $state(0);
  let pageWidth = $state(0);
  let pageHeight = $state(0);
  let pdf = $state.raw<PDFDocumentProxy | null>(null);
  let canvas = $state<HTMLCanvasElement>();
  let viewportElement = $state<HTMLDivElement>();
  let width = $state(300);
  let pageNumber = $state(1);
  let zoom = $state(100);
  let loading = $state(true);
  let error = $state('');

  onMount(() => {
    if (!viewportElement) return;
    const observer = new ResizeObserver(entries => width = entries[0].contentRect.width);
    observer.observe(viewportElement);
    return () => observer.disconnect();
  });
  $effect(() => {
    const documentUrl = url;
    let task: PDFDocumentLoadingTask | undefined;
    let cancelled = false;
    pdf = null; renderedPage = 0;
    loading = true;
    error = '';
    pageNumber = 1;
    zoom = 100;
    import('pdfjs-dist').then(async ({ getDocument, GlobalWorkerOptions }) => {
      if (cancelled) return;
      GlobalWorkerOptions.workerSrc = workerUrl;
      task = getDocument({ url: documentUrl });
      const document = await task.promise;
      if (!cancelled) pdf = document;
    }).catch(() => {
      if (!cancelled) { error = 'This PDF could not be displayed. Open the original to inspect it.'; loading = false; }
    });
    return () => { cancelled = true; void task?.destroy(); };
  });
  $effect(() => {
    const document = pdf;
    const target = canvas;
    const requestedPage = pageNumber;
    const requestedZoom = zoom;
    const availableWidth = width;
    if (!document || !target || availableWidth <= 0) return;
    let cancelled = false;
    let render: RenderTask | undefined;
    loading = true;
    error = '';
    (async () => {
      try {
        const page = await document.getPage(requestedPage);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const scale = Math.max(0.1, (availableWidth - 28) / base.width) * requestedZoom / 100;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: scale * ratio });
        const buffer = window.document.createElement('canvas');
        buffer.width = Math.ceil(viewport.width);
        buffer.height = Math.ceil(viewport.height);
        render = page.render({ canvas: buffer, viewport });
        await render.promise;
        if (cancelled) return;
        target.width = buffer.width;
        target.height = buffer.height;
        target.style.width = `${viewport.width / ratio}px`;
        target.style.height = `${viewport.height / ratio}px`;
        target.getContext('2d')?.drawImage(buffer, 0, 0);
        pageWidth = viewport.width / ratio; pageHeight = viewport.height / ratio; renderedPage = requestedPage;
        loading = false;
      } catch (failure) {
        if (!cancelled) { error = 'This PDF page could not be displayed. Try opening the original.'; loading = false; }
      }
    })();
    return () => { cancelled = true; render?.cancel(); };
  });
  $effect(() => {
    if (jumpRequest >= 0 && location && pdf && location.page <= pdf.numPages) pageNumber = location.page;
  });
  $effect(() => {
    const requestedJump = jumpRequest;
    if (!location || loading || renderedPage !== location.page || !viewportElement || !pageWidth || !pageHeight) return;
    if (requestedJump >= 0) viewportElement.scrollTo({
      top: 14 + (location.y + location.height / 2) * pageHeight - viewportElement.clientHeight / 2,
      left: 14 + (location.x + location.width / 2) * pageWidth - viewportElement.clientWidth / 2,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
    });
  });
</script>

<div class="pdf-renderer">
  <div class="pdf-controls">
    <div><button aria-label="Previous receipt page" disabled={!pdf || pageNumber <= 1} onclick={() => pageNumber--}><ChevronLeft size={14}/></button><span>{pageNumber} / {pdf?.numPages || '—'}</span><button aria-label="Next receipt page" disabled={!pdf || pageNumber >= pdf.numPages} onclick={() => pageNumber++}><ChevronRight size={14}/></button></div>
    <div><button aria-label="Zoom out PDF" disabled={zoom <= 60 || !pdf} onclick={() => zoom = Math.max(60, zoom - 20)}><Minus size={13}/></button><button class="pdf-fit" aria-label="Fit PDF to width" onclick={() => zoom = 100}>{zoom}%</button><button aria-label="Zoom in PDF" disabled={zoom >= 200 || !pdf} onclick={() => zoom = Math.min(200, zoom + 20)}><Plus size={13}/></button></div>
  </div>
  <div class="pdf-canvas-viewport" bind:this={viewportElement} aria-busy={loading}>
    <div class="pdf-page" style={`width:${pageWidth || 1}px;height:${pageHeight || 1}px`}><canvas bind:this={canvas} aria-label={`Original receipt PDF, page ${pageNumber}`} class:canvas-loading={loading}></canvas>{#if location && !loading && location.page === renderedPage}<div class="pdf-source-highlight" data-source-highlight aria-label={`Source location on page ${location.page}`} style={`left:${location.x * 100}%;top:${location.y * 100}%;width:${location.width * 100}%;height:${location.height * 100}%`}><span>Source</span></div>{/if}</div>
    {#if loading && !error}<div class="pdf-loading" role="status"><LoaderCircle class="spin" size={21}/><span>Loading receipt</span></div>{/if}
    {#if error}<div class="pdf-error" role="status"><FileWarning size={25}/><p>{error}</p></div>{/if}
  </div>
  {#if location && pdf && location.page > pdf.numPages}<div class="source-unavailable" role="status">The source reference points to a page outside this PDF.</div>{/if}
</div>
