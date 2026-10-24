import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createGrocyImporter, GrocyError, grocyApiUrl, unitFactor, validateGrocyReceipt, type GrocyReceipt } from '../server/grocy.ts';
import { createPennyServer } from '../server/index.ts';

const receipt = (): GrocyReceipt => ({id:'receipt-1',fingerprint:'a'.repeat(64),store:'Market',receiptDate:'2026-10-10',currency:'PLN',products:[{id:'milk',name:'Milk',quantity:2,unit:'L',price:10,expiry:'2026-10-20',location:'Fridge',productGroup:'Dairy & Eggs',uncertain:false}]});
function fakeGrocy() {
  const objects: Record<string,any[]> = {products:[],locations:[{id:1,name:'Fridge'}],product_groups:[{id:2,name:'Dairy & Eggs'}],quantity_units:[{id:3,name:'L',name_plural:'liters'},{id:4,name:'g',name_plural:'grams'}],shopping_locations:[],stock_log:[]};
  const calls: {path:string;method:string;body:any}[] = [];
  let failStock = 0; let lostResponse = false; let currency = 'PLN'; let nextId = 20;
  const fetcher = (async (input: any, init: any) => {
    const url = new URL(String(input)); const path = url.pathname.replace('/api/',''); const method = init.method;
    assert.equal(init.headers['GROCY-API-KEY'],'secret-test-key'); assert.equal(url.searchParams.has('GROCY-API-KEY'),false); assert.equal(init.redirect,'error');
    const body = init.body ? JSON.parse(init.body) : undefined; calls.push({path,method,body});
    if (path === 'system/config') return Response.json({CURRENCY:currency});
    if (path.startsWith('objects/')) {
      const [,entity,id] = path.split('/');
      if (method === 'GET') return Response.json(objects[entity].filter(row=>!url.search || (url.searchParams.get('query[]')?.startsWith('note~') ? row.note?.startsWith(url.searchParams.get('query[]')!.slice(5,-1)) : row.note === url.searchParams.get('query[]')?.slice(5))));
      if (method === 'POST') { const created = nextId++; objects[entity].push({id:created,...body}); return Response.json({created_object_id:String(created)}); }
      if (method === 'PUT') { Object.assign(objects[entity].find(row=>String(row.id) === id),body); return new Response(null,{status:204}); }
    }
    if (path.startsWith('stock/products/')) {
      const productId = Number(path.split('/')[2]);
      if (failStock && calls.filter(call=>call.path.startsWith('stock/') && call.method === 'POST').length === failStock) return Response.json({error:'internal secret'}, {status:400});
      objects.stock_log.push({product_id:productId,transaction_type:'purchase',note:body.note,...body});
      if (lostResponse) { lostResponse = false; throw new Error('Socket disappeared after write'); }
      return Response.json({id:100});
    }
    throw new Error(`Unexpected request ${path}`);
  }) as typeof fetch;
  return {objects,calls,fetcher,failAt:(n:number)=>failStock=n,loseNext:()=>lostResponse=true,currency:(code:string)=>currency=code};
}
async function setup(t: any) {
  const fake = fakeGrocy(); const config = {url:'https://grocy.test',apiKey:'secret-test-key'};
  return {...fake,config,importer:createGrocyImporter(config,fake.fetcher)};
}
test('Grocy URLs support subpaths and unit conversion never assumes pieces equal liters',()=>{
  assert.equal(grocyApiUrl('https://grocy.test/sub/api/'),'https://grocy.test/sub/api/');
  assert.throws(()=>grocyApiUrl('https://secret@grocy.test'),GrocyError);
  assert.equal(unitFactor('kg','grams'),1000); assert.equal(unitFactor('ml','L'),.001); assert.equal(unitFactor('szt.','Pieces'),1); assert.equal(unitFactor('pcs','L'),undefined);
  assert.throws(()=>validateGrocyReceipt({...receipt(),products:[{...receipt().products[0],expiry:''}]}),/expiration/);
  assert.throws(()=>validateGrocyReceipt({...receipt(),products:[{...receipt().products[0],expiry:'2026-02-30'}]}),/expiration/);
});
test('confirmation creates missing objects and sends per-unit prices, classifications and expiration',async t=>{
  const s=await setup(t); const result=await s.importer(receipt()); assert.equal(result.count,1);
  const created=s.objects.products[0]; assert.equal(created.qu_id_stock,3); assert.equal(created.product_group_id,2); assert.equal(created.location_id,1);
  const stock=s.objects.stock_log[0]; assert.equal(stock.amount,2); assert.equal(stock.price,5); assert.equal(stock.best_before_date,'2026-10-20'); assert.equal(stock.location_id,1); assert.equal(stock.shopping_location_id,s.objects.shopping_locations[0].id); assert.match(stock.note,/Receipt 2026-10-10/);
});
test('existing stock units convert quantities and line prices; product master group is updated',async t=>{
  const s=await setup(t);s.objects.products.push({id:8,name:' Milk ',qu_id_stock:4,product_group_id:99});
  const r=receipt();r.products[0].unit='kg';r.products[0].quantity=.5;r.products[0].price=6;
  await s.importer(r); assert.equal(s.objects.products.length,1); assert.equal(s.objects.products[0].product_group_id,2); assert.equal(s.objects.stock_log[0].amount,500); assert.equal(s.objects.stock_log[0].price,.012);
});
test('all products are preflighted before any writes and incompatible units or currency are blocked',async t=>{
  const s=await setup(t);const r=receipt();r.products.push({...r.products[0],id:'other',name:'Bread',location:'Missing'});
  await assert.rejects(s.importer(r),/does not exist/); assert.equal(s.calls.filter(c=>c.method !== 'GET').length,0);
  s.objects.products.push({id:8,name:'Milk',qu_id_stock:4});await assert.rejects(s.importer(receipt()),/cannot safely convert/);
  s.currency('EUR');await assert.rejects(s.importer(receipt()),/currency/);assert.equal(s.objects.stock_log.length,0);
});
test('repeated product rows reuse the new product with compatible stock units',async t=>{
  const s=await setup(t);const r=receipt();r.products.push({...r.products[0],id:'second',unit:'ml',quantity:500,price:3});
  await s.importer(r);assert.equal(s.objects.products.length,1);assert.equal(s.objects.stock_log.length,2);assert.equal(s.objects.stock_log[1].amount,.5);assert.equal(s.objects.stock_log[1].price,6);
});
test('concurrent confirmations and process restart check Grocy’s log without duplicate stock',async t=>{
  const s=await setup(t); await Promise.all([s.importer(receipt()),s.importer(receipt())]);assert.equal(s.objects.stock_log.length,1);
  const restarted=createGrocyImporter(s.config,s.fetcher);const reads=s.calls.length; await restarted({...receipt(),id:'new-browser-id',products:receipt().products.map(p=>({...p,id:'new-row-id'}))});assert.equal(s.calls.length,reads+1);
  const changed=receipt();changed.products[0].price=11;await assert.rejects(restarted(changed),/already.*import/);assert.equal(s.objects.stock_log.length,1);
});
test('partial failures resume only unfinished rows after restart',async t=>{
  const s=await setup(t);const r=receipt();r.products.push({...r.products[0],id:'bread',name:'Bread'});s.failAt(2);
  await assert.rejects(s.importer(r),(error: any)=>error.count === 1 && error.uncertain === false);assert.equal(s.objects.stock_log.length,1);
  s.failAt(0); const restarted=createGrocyImporter(s.config,s.fetcher);assert.equal((await restarted(r)).count,2);assert.equal(s.objects.stock_log.length,2);assert.equal(s.objects.products.length,2);
});
test('lost stock responses reconcile from exact stock-log markers without replaying purchases',async t=>{
  const s=await setup(t);s.loseNext();await assert.rejects(s.importer(receipt()),(e:any)=>e.uncertain && e.count === 0);assert.equal(s.objects.stock_log.length,1);
  const restarted=createGrocyImporter(s.config,s.fetcher);assert.equal((await restarted(receipt())).count,1);assert.equal(s.calls.filter(c=>c.path.startsWith('stock/')).length,1);
});
test('unresolved ambiguous writes stay blocked and provider errors never reveal response bodies',async t=>{
  const s=await setup(t);s.loseNext();await assert.rejects(s.importer(receipt()),/did not acknowledge/);s.objects.stock_log=[];
  await assert.rejects(s.importer(receipt()),(e:any)=>e.uncertain && /still unconfirmed/.test(e.message));assert.equal(s.calls.filter(c=>c.path.startsWith('stock/')).length,1);
});
test('HTTP confirmation endpoint works without AI credentials and rejects malformed input and origins',async t=>{
  const server=createPennyServer({openaiKey:'',jevKey:'',openaiModel:'test',jevModel:'test',classificationThreshold:.75},{importer:async value=>{const r=validateGrocyReceipt(value);return {count:r.products.length,total:r.products.length,productIds:{milk:1},confirmedAt:'2026-10-10T12:00:00Z'};}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.close();server.closeAllConnections();});const address=server.address() as {port:number};const url=`http://127.0.0.1:${address.port}/api/receipts/confirm`;
  let response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(receipt())});assert.equal(response.status,200);assert.equal((await response.json()).count,1);
  response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'invalid'});assert.equal(response.status,400);
  response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.test'},body:JSON.stringify(receipt())});assert.equal(response.status,403);
});
