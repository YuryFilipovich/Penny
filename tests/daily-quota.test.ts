import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { request } from 'node:http';
import { DailyQuota } from '../server/daily-quota.ts';
import { createPennyServer } from '../server/index.ts';

const config = { openaiKey:'fake', jevKey:'fake', openaiModel:'fake', jevModel:'fake', classificationThreshold:.75 };
test('five concurrent reservations persist across restart and reset at Warsaw midnight', async () => {
  const directory = await mkdtemp(join(tmpdir(),'penny-quota-'));
  const file = join(directory,'usage.json');
  let time = new Date('2026-10-10T21:59:00Z');
  try {
    const quota = new DailyQuota({file,limit:5,now:()=>time});
    const results = await Promise.allSettled(Array.from({length:8},()=>quota.consume()));
    assert.equal(results.filter(result=>result.status==='fulfilled').length,5);
    assert.equal(results.filter(result=>result.status==='rejected' && result.reason.status===429).length,3);
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')), {date:'2026-10-10',used:5});
    const restarted = new DailyQuota({file,limit:5,now:()=>time});
    assert.equal((await restarted.status()).remaining,0);
    await assert.rejects(restarted.consume(), {status:429});
    assert.equal((await restarted.status()).resetAt,'2026-10-10T22:00:00.000Z');
    time = new Date('2026-10-10T22:00:00Z');
    assert.equal((await restarted.status()).remaining,5);
    assert.equal((await restarted.consume()).used,1);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test('reset follows both daylight-saving transitions in Warsaw', async () => {
  for (const [now,reset] of [ ['2026-03-28T23:00:00Z','2026-03-29T22:00:00.000Z'], ['2026-10-24T22:00:00Z','2026-10-25T23:00:00.000Z'] ]) {
    const quota = new DailyQuota({now:()=>new Date(now)});
    assert.equal((await quota.status()).resetAt,reset);
  }
});
test('a corrupt or unwritable counter fails closed before any scan starts', async () => {
  const directory = await mkdtemp(join(tmpdir(),'penny-quota-'));
  try {
    const file=join(directory,'usage.json'); await writeFile(file,'not JSON');
    await assert.rejects(new DailyQuota({file}).consume(), {status:503});
    await assert.rejects(new DailyQuota({file:join(file,'impossible.json')}).consume(), {status:503});
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test('LAN host/origin, configurable ten-scan default and failures are enforced by HTTP endpoints', async () => {
  let calls = 0;
  const quota = new DailyQuota();
  const server = createPennyServer(config,{quota,origins:['http://192.168.50.10','http://192.168.50.10:18787'],extractor:async()=>{calls++;throw new Error('Mock provider failure');}});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address = server.address(); if (!address || typeof address==='string') throw new Error('No port');
  const url=`http://127.0.0.1:${address.port}`;
  const headers={'Host':'192.168.50.10','Origin':'http://192.168.50.10','Content-Type':'application/pdf'};
  try {
    // Native fetch normalizes Host; use HTTP directly to exercise proxy host headers.
    const hostStatus = (host: string) => new Promise<number>(resolve => {
      const req=request(url+'/api/health',{headers:{Host:host}},response=>{response.resume();resolve(response.statusCode!);});
      req.end();
    });
    assert.equal(await hostStatus('192.168.50.10'),200);
    assert.equal(await hostStatus('192.168.50.10:18787'),200);
    assert.equal(await hostStatus('foreign.example'),403);
    assert.equal((await fetch(url+'/api/receipts/extract',{method:'POST',headers:{...headers,Origin:'https://foreign.example'},body:'%PDF-1.4'})).status,403);
    assert.equal((await fetch(url+'/api/receipts/extract',{method:'POST',headers,body:'invalid'})).status,422);
    assert.equal((await quota.status()).used,0);
    for (let index=0;index<10;index++) {
      const response=await fetch(url+'/api/receipts/extract',{method:'POST',headers,body:'%PDF-1.4'});
      assert.equal(response.status,200); assert.match(await response.text(), /"type":"error"/);
    }
    const response=await fetch(url+'/api/receipts/extract',{method:'POST',headers,body:'%PDF-1.4'});
    assert.equal(response.status,429); assert.ok(Number(response.headers.get('Retry-After'))>0);
    assert.equal((await response.json()).usage.remaining,0); assert.equal(calls,10);
    const usage=await fetch(url+'/api/usage',{headers}); assert.equal(usage.headers.get('cache-control'),'no-store');
    assert.equal((await usage.json()).used,10);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
test('missing provider configuration does not consume quota', async () => {
  const quota = new DailyQuota();
  const server=createPennyServer({...config,openaiKey:''},{quota});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address=server.address(); if (!address || typeof address==='string') throw new Error('No port');
  try {
    const response=await fetch(`http://127.0.0.1:${address.port}/api/receipts/extract`,{method:'POST',headers:{'Content-Type':'application/pdf'},body:'%PDF-1.4'});
    assert.equal(response.status,503); assert.equal((await quota.status()).used,0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
