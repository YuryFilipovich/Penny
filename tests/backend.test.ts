import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { extractReceipt, cleanProductName, acceptedChoice, parseExtraction, ExtractionError, type Config } from '../server/extraction.ts';
import { createPennyServer, loadConfig } from '../server/index.ts';
import { readPdfLines, resolveSource } from '../server/pdf-source.ts';
import { extractPdf } from '../src/extraction-client.ts';

const config: Config = { openaiKey:'test-openai', jevKey:'test-jev', openaiModel:'gpt-4.1', jevModel:'jev-latest', classificationThreshold:.75 };
const receipt = { store:'Test Market', receiptDate:'2026-10-10', currency:'PLN', receiptTotal:2.49, adjustments:0, products:[{name:'Whole milk 1 L',rawName:'Milk',quantity:1,unit:'pcs',price:2.49,sourceLineId:'p1-l2',uncertain:false}] };
const choice = (value: string, confidence = .95) => ({type:'choice',choice:value,confidence,probabilities:{[value]:.98,Unassigned:.02}});
const fixture = () => readFile(new URL('./fixtures/source.pdf',import.meta.url));
function fakeProviders(options: { jevFailure?: boolean; extraction?: unknown } = {}) {
  const calls: { url: string; body: any }[] = [];
  const fetcher = (async (url: any, init: any) => {
    const body = JSON.parse(init.body); calls.push({url:String(url),body});
    if (String(url).includes('openai.com')) return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(options.extraction || receipt)}]}]});
    if (options.jevFailure) return Response.json({error:'test-provider-secret'}, {status:401});
    return Response.json({answers:{location_0:choice('Fridge'),group_0:choice('Dairy & Eggs')}});
  }) as typeof fetch;
  return {fetcher,calls};
}

test('PDF source links use actual page text, and repeated names need explicit line IDs', async () => {
  const lines = await readPdfLines(await fixture());
  assert.equal(resolveSource('p1-l2','Milk',lines)?.page,1);
  assert.equal(resolveSource(null,'Payment details',lines)?.page,2);
  assert.equal(resolveSource('p1-l3','Nonexistent product',lines),undefined);
  const duplicates = [...lines, {...lines[1],id:'other-milk'}];
  assert.equal(resolveSource(null,'Milk',duplicates),undefined);
  assert.equal(resolveSource('p1-l2','Milk',duplicates)?.page,1);
});
test('pipeline sends a PDF to OpenAI and text-only bounded choices to Jev', async () => {
  const {fetcher,calls} = fakeProviders(); const stages: number[] = [];
  const result = await extractReceipt(await fixture(),config,(_,progress)=>stages.push(progress),new AbortController().signal,fetcher);
  assert.deepEqual(stages,[10,25,70,92]);
  assert.equal(calls[0].url,'https://api.openai.com/v1/responses');
  assert.equal(calls[0].body.store,false);
  assert.equal(calls[0].body.text.format.strict,true);
  assert.match(calls[0].body.input[0].content[0].file_data,/^data:application\/pdf;base64,/);
  assert.equal(calls[1].url,'https://api.typesafe.ai/v1/systemone');
  assert.equal(calls[1].body.questions.location_0.criteria.Freezer.includes('frozen'),true);
  assert.equal(calls[1].body.state.products[0].name,'Whole milk');
  assert.equal(JSON.stringify(calls[1].body).includes('file_data'),false);
  assert.equal(result.products[0].location,'Fridge'); assert.equal(result.products[0].productGroup,'Dairy & Eggs');
  assert.equal(result.products[0].quantity,1); assert.equal(result.products[0].unit,'pcs');
  assert.equal(result.products[0].sourceLocation?.page,1); assert.equal(result.products[0].expiry,'');
  assert.deepEqual(result.warnings,[]);
});
test('product names omit packaging and loose-sale markers without losing identifying variants', () => {
  for (const [raw, clean] of [
    ['Banany luz', 'Banany'], ['Pomidory luzem', 'Pomidory'],
    ['Jajka ściółkowe 10 szt.', 'Jajka ściółkowe'],
    ['Groszek mrożony 450 g', 'Groszek mrożony'],
    ['Mleko UHT 3,2% 1 l', 'Mleko UHT 3,2%'],
    ['Oliwa z oliwek (500 ml)', 'Oliwa z oliwek'],
    ['Cola zero 6 x 330 ml', 'Cola zero'], ['Cola zero 6x330ml', 'Cola zero'],
    ['Ryż basmati 1kg', 'Ryż basmati'], ['Eggs 10 pcs', 'Eggs'],
    ['7UP Zero', '7UP Zero'], ['Dr. Oetker kakao 100%', 'Dr. Oetker kakao 100%'],
    ['Witamina B12 1000 µg', 'Witamina B12 1000 µg'],
    ['450 g', '']
  ]) assert.equal(cleanProductName(raw), clean, raw);
});
test('clean names flow into classification and review while source text and purchase amounts stay intact', async () => {
  const extraction={...receipt,receiptTotal:4.98,products:[{...receipt.products[0],name:'Mleko UHT 3,2% 1 l',rawName:'Milk',quantity:2,unit:'pcs',price:4.98}]};
  const {fetcher,calls}=fakeProviders({extraction});
  const result=await extractReceipt(await fixture(),config,()=>{},new AbortController().signal,fetcher);
  assert.equal(result.products[0].name,'Mleko UHT 3,2%');
  assert.equal(result.products[0].quantity,2); assert.equal(result.products[0].unit,'pcs');
  assert.equal(result.products[0].price,4.98); assert.equal(result.products[0].sourceLocation?.page,1);
  assert.equal(calls[1].body.state.products[0].name,'Mleko UHT 3,2%');
  assert.equal(calls[1].body.state.products[0].rawName,'Milk');
  assert.deepEqual(result.warnings,[]);
});
test('missing quantities/prices remain empty, and receipt mismatches are surfaced',async () => {
  const {fetcher} = fakeProviders({extraction:{...receipt,receiptDate:'2026-02-30',receiptTotal:10,products:[{...receipt.products[0],quantity:null,unit:null,price:null}]}});
  const result = await extractReceipt(await fixture(),config,()=>{},new AbortController().signal,fetcher);
  assert.equal(result.products[0].quantity,undefined); assert.equal(result.products[0].unit,''); assert.equal(result.products[0].price,undefined);
  assert.equal(result.products[0].uncertain,true); assert.equal(result.receiptDate,'');
  assert.equal(result.warnings.length,2);
});
test('classification failure preserves extracted products without leaking provider errors',async () => {
  const {fetcher} = fakeProviders({jevFailure:true});
  const result = await extractReceipt(await fixture(),config,()=>{},new AbortController().signal,fetcher);
  assert.equal(result.products[0].price,2.49); assert.equal(result.products[0].location,''); assert.equal(result.products[0].uncertain,true);
  assert.equal(result.warnings.length,1); assert.equal(JSON.stringify(result).includes('test-provider-secret'),false);
});
test('malformed prices and out-of-list or low-confidence classifications are rejected',() => {
  assert.throws(()=>parseExtraction({...receipt,products:[{...receipt.products[0],price:'2,49'}]}),ExtractionError);
  assert.throws(()=>parseExtraction({...receipt,products:[{...receipt.products[0],quantity:-1}]}),ExtractionError);
  assert.deepEqual(acceptedChoice(choice('Anywhere'),['Fridge'],.75),{value:''});
  assert.deepEqual(acceptedChoice(choice('Fridge',.5),['Fridge'],.75),{value:''});
  assert.deepEqual(acceptedChoice({...choice('Fridge'),probabilities:{Fridge:.5}},['Fridge'],.75),{value:''});
  assert.equal(acceptedChoice(choice('Fridge'),['Fridge'],.75).value,'Fridge');
  assert.throws(()=>loadConfig({JEV_CONFIDENCE_THRESHOLD:'NaN'}));
});
test('no configured API keys makes zero provider calls',async () => {
  const {fetcher,calls} = fakeProviders();
  await assert.rejects(extractReceipt(await fixture(),{...config,openaiKey:''},()=>{},new AbortController().signal,fetcher),{status:503});
  assert.equal(calls.length,0);
});
test('HTTP upload limits, origin checks and NDJSON result work end to end',async () => {
  let calls = 0;
  const server = createPennyServer(config,{extractor:async (_pdf,_config,progress)=>{calls++;progress('reading',10);return {store:'Test',receiptDate:'2026-10-10',currency:'PLN',products:[],receiptTotal:null,warnings:[]};}});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(url+'/api/health')).status,200);
    assert.equal((await fetch(url+'/api/receipts/extract',{method:'POST',headers:{Origin:'https://untrusted.example','Content-Type':'application/pdf'},body:await fixture()})).status,403);
    assert.equal((await fetch(url+'/api/receipts/extract',{method:'POST',headers:{'Content-Type':'text/plain'},body:'not pdf'})).status,415);
    assert.equal((await fetch(url+'/api/receipts/extract',{method:'POST',headers:{'Content-Type':'application/pdf'},body:'not pdf'})).status,422);
    const response = await fetch(url+'/api/receipts/extract',{method:'POST',headers:{'Content-Type':'application/pdf'},body:await fixture()});
    const events = (await response.text()).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(events[0].type,'progress'); assert.equal(events[1].type,'result'); assert.equal(calls,1);
    const oversized = Buffer.alloc(20*1024*1024+1); oversized.write('%PDF-');
    assert.equal((await fetch(url+'/api/receipts/extract',{method:'POST',headers:{'Content-Type':'application/pdf'},body:oversized})).status,413);
    assert.equal(calls,1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
test('browser adapter handles NDJSON split across arbitrary network chunks',async () => {
  const original = globalThis.fetch;
  const encoder = new TextEncoder();
  const result = {products:[],store:'Test',receiptDate:'',currency:'PLN',warnings:[],receiptTotal:null};
  const data = JSON.stringify({type:'progress',progress:70})+'\n'+JSON.stringify({type:'result',result})+'\n';
  globalThis.fetch = (async () => new Response(new ReadableStream({start(controller){for(let index=0;index<data.length;index+=7)controller.enqueue(encoder.encode(data.slice(index,index+7)));controller.close();}}))) as typeof fetch;
  try {
    const progress: number[] = [];
    assert.deepEqual(await extractPdf(new Blob(['%PDF-']),value=>progress.push(value),new AbortController().signal),result);
    assert.deepEqual(progress,[70]);
  } finally {globalThis.fetch=original;}
});

test('production server serves the frontend and keeps files outside its static root private', async () => {
  const directory = await mkdtemp(join(tmpdir(),'penny-static-'));
  await writeFile(join(directory,'index.html'),'<title>Penny</title>');
  const server = createPennyServer(config,{serveStatic:true,staticRoot:directory+'/'});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(url+'/'); assert.equal(response.status,200); assert.match(await response.text(),/Penny/);
    assert.equal((await fetch(url+'/.env')).status,404);
    assert.equal((await fetch(url+'/..%2f..%2f.env')).status,403);
    assert.equal((await fetch(url+'/server/index.ts')).status,404);
  } finally {server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true});}
});
