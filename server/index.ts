import { DailyQuota, QuotaError } from './daily-quota.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExtractionError, extractReceipt, type Config, type ExtractionResult, type Progress } from './extraction.ts';

import { createGrocyImporter, GrocyError, type GrocyConfig, type GrocyResult } from './grocy.ts';

export function loadGrocyConfig(env = process.env): GrocyConfig {
  return {url:env.GROCY_URL || '',apiKey:env.GROCY_API_KEY || ''};
}
async function readConfirmation(request: IncomingMessage) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new GrocyError('Send a JSON receipt.',415);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) throw new GrocyError('Receipt data is too large.',413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new GrocyError('Invalid receipt JSON.',400); }
}

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const root = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
type Extractor = (pdf: Buffer, config: Config, progress: Progress, signal: AbortSignal) => Promise<ExtractionResult>;
export function loadConfig(env = process.env): Config {
  const threshold = Number(env.JEV_CONFIDENCE_THRESHOLD || '.75');
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('JEV_CONFIDENCE_THRESHOLD must be between 0 and 1.');
  return { openaiKey: env.OPENAI_API_KEY || '', jevKey: env.JEV_API_KEY || env.TYPESAFE_API_KEY || '', openaiModel: env.OPENAI_MODEL || 'gpt-4.1', jevModel: env.JEV_MODEL || 'jev-latest', classificationThreshold: threshold };
}
function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}
async function readPdf(request: IncomingMessage) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/pdf') throw new ExtractionError('Upload a PDF receipt.', 415);
  if (Number(request.headers['content-length']) > MAX_PDF_BYTES) throw new ExtractionError('Choose a PDF smaller than 20 MB.', 413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_PDF_BYTES) throw new ExtractionError('Choose a PDF smaller than 20 MB.', 413);
    chunks.push(chunk);
  }
  const pdf = Buffer.concat(chunks);
  if (!pdf.length || !pdf.subarray(0,1024).includes(Buffer.from('%PDF-'))) throw new ExtractionError('This file is not a valid PDF.', 422);
  return pdf;
}
export function createPennyServer(config: Config, options: { quota?: DailyQuota; extractor?: Extractor; origins?: string[]; serveStatic?: boolean; staticRoot?: string; grocy?: GrocyConfig; importer?: (receipt: unknown) => Promise<GrocyResult> } = {}) {
  const quota = options.quota || new DailyQuota();
  const grocy = options.grocy || {url:'',apiKey:''};
  const importer = options.importer || createGrocyImporter(grocy);
  let confirmations = 0;
  const extractor = options.extractor || extractReceipt;
  const staticRoot = resolve(options.staticRoot || root);
  const origins = new Set(options.origins || ['http://localhost:5173','http://127.0.0.1:5173','http://localhost:8787','http://127.0.0.1:8787']);
  const hosts = new Set([...origins].map(origin => new URL(origin).host));
  let active = 0;
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options','nosniff');
    const host = request.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) && !hosts.has(host)) { json(response,403,{error:'This host is not allowed.'}); return; }
    if (request.headers.origin && !origins.has(request.headers.origin)) { json(response,403,{error:'This origin is not allowed.'}); return; }
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname === '/api/usage' && request.method === 'GET') {
      try { json(response,200,await quota.status()); } catch { json(response,503,{error:'The daily scan counter is unavailable.'}); }
      return;
    }
    if (url.pathname === '/api/health' && request.method === 'GET') { json(response,200,{ready:Boolean(config.openaiKey && config.jevKey),grocyReady:Boolean(grocy.url && grocy.apiKey)}); return; }
    if (url.pathname === '/api/receipts/extract' && request.method === 'POST') {
      if (active >= 2) { json(response,429,{error:'Penny is already scanning two receipts. Try again shortly.'}); return; }
      active++;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(),180_000);
      request.once('aborted',() => abort.abort());
      response.once('close',() => { if (!response.writableEnded) abort.abort(); });
      const send = (event: unknown) => { if (!response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(event)}\n`); };
      try {
        if (!config.openaiKey || !config.jevKey) throw new ExtractionError('Add OPENAI_API_KEY and JEV_API_KEY to the server .env file, then restart Penny.',503);
        const pdf = await readPdf(request);
        await quota.consume();
        response.writeHead(200,{'Content-Type':'application/x-ndjson','Cache-Control':'no-store','X-Accel-Buffering':'no'});
        const result = await extractor(pdf,config,(stage,progress) => send({type:'progress',stage,progress}),abort.signal);
        if (!abort.signal.aborted) send({type:'result',result});
        else send({type:'error',message:'The scan timed out. Please retry.'});
      } catch (error) {
        const known = error instanceof ExtractionError || error instanceof QuotaError;
        if (error instanceof QuotaError && error.usage) response.setHeader('Retry-After', String(Math.max(1, Math.ceil((Date.parse(error.usage.resetAt) - Date.now()) / 1000))));
        const message = known ? error.message : 'The receipt could not be processed. Please retry.';
        if (!response.headersSent) json(response,known ? error.status : 500,{error:message,...(error instanceof QuotaError && error.usage ? {usage:error.usage} : {})});
        else send({type:'error',message});
      } finally { clearTimeout(timer); active--; if (!response.writableEnded) response.end(); }
      return;
    }
    if (url.pathname === '/api/receipts/confirm' && request.method === 'POST') {
      if (confirmations >= 2) { json(response,429,{error:'An import is already running. Try again shortly.',count:0,total:0,uncertain:false}); return; }
      confirmations++;
      try {
        // Complete the import even if the browser disconnects during a stock write.
        const result = await importer(await readConfirmation(request));
        json(response,200,result);
      } catch (error) {
        const failure = error instanceof GrocyError ? error : new GrocyError('Confirmation failed. Keep this page open and retry to check its import status.',500,true);
        json(response,failure.status,{error:failure.message,count:failure.count,total:failure.total,uncertain:failure.uncertain});
      } finally { confirmations--; }
      return;
    }
    if (url.pathname.startsWith('/api/')) { json(response,404,{error:'Endpoint not found.'}); return; }
    if (options.serveStatic && request.method === 'GET') {
      try {
        let pathname: string;
        try { pathname = decodeURIComponent(url.pathname); } catch { json(response,400,{error:'Invalid path.'}); return; }
        const path = resolve(staticRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
        if (!path.startsWith(staticRoot + sep)) { json(response,403,{error:'Invalid path.'}); return; }
        const data = await readFile(path);
        const types: Record<string,string> = { '.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml' };
        response.writeHead(200,{'Content-Type':types[extname(path)] || 'application/octet-stream','Cache-Control':pathname.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache'});
        response.end(data);
      } catch { json(response,404,{error:'File not found. Run npm run build first.'}); }
      return;
    }
    json(response,404,{error:'Endpoint not found.'});
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Optional env loading lets deployed environments provide secrets directly.
  try { process.loadEnvFile('.env'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port.');
  const defaults = ['http://localhost:5173','http://127.0.0.1:5173',`http://localhost:${port}`,`http://127.0.0.1:${port}`];
  const origins = process.env.APP_ORIGINS ? process.env.APP_ORIGINS.split(',').map(value => {
    const origin = new URL(value.trim());
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== value.trim()) throw new Error('APP_ORIGINS must contain HTTP(S) origins without paths.');
    return origin.origin;
  }) : defaults;
  const host = process.env.HOST || '127.0.0.1';
  const quota = new DailyQuota({limit:Number(process.env.DAILY_RECEIPT_LIMIT || 10),timezone:process.env.RECEIPT_TIMEZONE || 'Europe/Warsaw',file:process.env.DAILY_USAGE_FILE || 'usage/daily-usage.json'});
  const server = createPennyServer(loadConfig(),{serveStatic:true,origins,quota,grocy:loadGrocyConfig()});
  server.listen(port,host,() => console.log(`Penny backend listening on ${host}:${port}`));
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
}
