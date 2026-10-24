import { createHash } from 'node:crypto';
import type { Product } from '../src/review-model.ts';

export type GrocyConfig = { url: string; apiKey: string };
export type GrocyReceipt = { id: string; fingerprint?: string; store: string; receiptDate: string; currency: string; products: Product[] };
export type GrocyResult = { count: number; total: number; productIds: Record<string, number>; confirmedAt: string };
export class GrocyError extends Error {
  status: number; uncertain: boolean; count = 0; total = 0;
  constructor(message: string, status = 502, uncertain = false) { super(message); this.status = status; this.uncertain = uncertain; }
}
type Entity = { id: number | string; name: string; name_plural?: string; qu_id_stock?: number | string; location_id?: number | string; product_group_id?: number | string; enable_tare_weight_handling?: number | string; no_own_stock?: number | string; active?: number | string };
type Row = { productId: number; state: 'pending' | 'inflight' | 'done'; note: string };
type ImportState = { payloadHash: string; done: boolean; confirmedAt?: string; rows: Record<string, Row> };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalized = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g,' ');
const validId = (value: unknown): number => { const id = Number(value); if (!Number.isInteger(id) || id < 1) throw new GrocyError('Grocy returned an invalid object ID.'); return id; };
export function grocyApiUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new GrocyError('Set a valid GROCY_URL in the server .env file.',503); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new GrocyError('GROCY_URL must be an HTTP(S) address without credentials, query, or fragment.',503);
  url.pathname = url.pathname.replace(/\/+$/,'').replace(/\/api$/,'') + '/api/';
  return url.href;
}
const aliases: Record<string,string> = Object.fromEntries([
  ['pcs',['pcs','pc','piece','pieces','szt','szt.','sztuka','sztuki']],
  ['kg',['kg','kilogram','kilograms','kilogramy']],
  ['g',['g','gram','grams','gramy']],
  ['l',['l','liter','liters','litre','litres','litr','litry']],
  ['ml',['ml','milliliter','milliliters','millilitre','millilitres']],
  ['pack',['pack','packs','package','packages','opak','opak.','opakowanie','opakowania']]
].flatMap(([canonical, labels]) => (labels as string[]).map(label => [label,canonical as string])));
export const canonicalUnit = (unit: string) => aliases[normalized(unit)] || normalized(unit);
export function unitFactor(from: string, to: string): number | undefined {
  const a = canonicalUnit(from), b = canonicalUnit(to);
  if (a === b) return 1;
  if ((a === 'kg' && b === 'g') || (a === 'l' && b === 'ml')) return 1000;
  if ((a === 'g' && b === 'kg') || (a === 'ml' && b === 'l')) return .001;
}
export function validateGrocyReceipt(value: unknown): GrocyReceipt {
  if (!value || typeof value !== 'object') throw new GrocyError('Invalid receipt.',400);
  const r = value as GrocyReceipt;
  const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.length <= 500;
  const date = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v;
  if (!text(r.id) || !text(r.store) || !text(r.receiptDate) || !date(r.receiptDate) || !['PLN','EUR','USD','GBP'].includes(r.currency) || (r.fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(r.fingerprint)) || !Array.isArray(r.products) || !r.products.length || r.products.length > 300) throw new GrocyError('Check the receipt’s store, date, currency, and products.',400);
  const ids = new Set<string>();
  for (const p of r.products) {
    if (!p || !text(p.id) || ids.has(p.id) || !text(p.name) || !text(p.unit) || typeof p.quantity !== 'number' || !Number.isFinite(p.quantity) || p.quantity <= 0 || p.quantity > 1e7 || typeof p.price !== 'number' || !Number.isFinite(p.price) || p.price < 0 || p.price > 1e7 || !text(p.location) || !text(p.productGroup) || typeof p.expiry !== 'string' || !date(p.expiry)) throw new GrocyError('Each product needs a name, quantity, unit, price, location, group, and expiration date before confirming.',400);
    ids.add(p.id);
  }
  return r;
}
function findNamed(entities: Entity[], name: string, kind: string) {
  const matches = entities.filter(entity => normalized(entity.name) === normalized(name));
  if (matches.length > 1) throw new GrocyError(`More than one Grocy ${kind} matches “${name}”. Resolve the duplicate in Grocy first.`,409);
  return matches[0];
}
export function createGrocyImporter(config: GrocyConfig, fetcher: typeof fetch = fetch) {
  // Serialize imports across receipts so simultaneous confirmations cannot race product creation.
  let tail: Promise<unknown> = Promise.resolve();
  // Temporary retry state only: no receipt data is written to disk.
  const sessions = new Map<string,{journal: ImportState; updatedAt: number}>();
  async function request(path: string, method = 'GET', body?: unknown): Promise<any> {
    const write = method !== 'GET';
    let response: Response;
    try { response = await fetcher(new URL(path,grocyApiUrl(config.url)),{method,redirect:'error',headers:{'GROCY-API-KEY':config.apiKey,'Content-Type':'application/json'},body:body === undefined ? undefined : JSON.stringify(body),signal:AbortSignal.timeout(30_000)}); }
    catch { throw new GrocyError(write ? 'Grocy did not acknowledge the write. Its status must be checked before retrying.' : 'Grocy could not be reached. Check its URL and try again.',504,write); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new GrocyError([401,403].includes(response.status) ? 'Grocy rejected its API key. Check GROCY_API_KEY.' : `Grocy rejected a ${write ? 'write' : 'read'} request (HTTP ${response.status}). Check the API permissions and product settings.`, response.status === 429 ? 429 : 502,write && response.status >= 500);
    }
    if (response.status === 204) return undefined;
    try { return await response.json(); } catch { throw new GrocyError('Grocy returned an unreadable response.',502,write); }
  }
  async function list(entity: string): Promise<Entity[]> {
    const data = await request(`objects/${entity}`);
    if (!Array.isArray(data)) throw new GrocyError(`Grocy’s ${entity} list could not be read.`);
    for (const row of data) { if (!row || typeof row.name !== 'string') throw new GrocyError(`Grocy’s ${entity} list was invalid.`); validId(row.id); }
    return data;
  }
  async function run(value: unknown): Promise<GrocyResult> {
    const receipt = validateGrocyReceipt(value);
    if (!config.url || !config.apiKey) throw new GrocyError('Add GROCY_URL and GROCY_API_KEY to the server .env file, then restart Penny.',503);
    const endpoint = grocyApiUrl(config.url);
    const key = hash({endpoint,receipt:receipt.fingerprint || receipt.id});
    const payloadHash = hash({store:receipt.store,receiptDate:receipt.receiptDate,currency:receipt.currency,products:receipt.products.map(p=>({name:p.name,quantity:p.quantity,unit:p.unit,price:p.price,expiry:p.expiry,location:p.location,productGroup:p.productGroup}))});
    for (const [sessionKey,session] of sessions) if (Date.now() - session.updatedAt > 15 * 60_000) sessions.delete(sessionKey);
    let cached = sessions.get(key);
    if (!cached) {
      if (sessions.size >= 256) throw new GrocyError('Too many temporary confirmations. Try again later.',429);
      cached = {journal:{payloadHash,done:false,rows:{}},updatedAt:Date.now()}; sessions.set(key,cached);
    }
    cached.updatedAt = Date.now();
    const journal = cached.journal;
    const count = () => Object.values(journal.rows).filter(row=>row.state === 'done').length;
    const result = (): GrocyResult => ({count:count(),total:receipt.products.length,productIds:Object.fromEntries(Object.entries(journal.rows).filter(([,row])=>row.state === 'done').map(([index,row])=>[receipt.products[Number(index)].id,row.productId])),confirmedAt:journal.confirmedAt || new Date().toISOString()});
    try {
      if (journal.payloadHash !== payloadHash && Object.keys(journal.rows).length) throw new GrocyError('This receipt has already started importing. Retry the original review; make changes to imported stock directly in Grocy.',409);
      if (journal.done) return result();
      // Grocy is the destination of confirmed stock; its own log can identify completed writes.
      const prefix = `Penny:${key}:`;
      const logs = await request(`objects/stock_log?${new URLSearchParams({'query[]':`note~${prefix}%`})}`);
      if (!Array.isArray(logs)) throw new GrocyError('Grocy’s stock log could not be checked. Confirmation stopped.');
      for (const log of logs) {
        if (typeof log.note !== 'string' || !log.note.startsWith(prefix) || log.transaction_type !== 'purchase') continue;
        const marker = log.note.slice(prefix.length).split(' | ')[0].split(':');
        if (marker.length !== 2 || marker[0] !== payloadHash) throw new GrocyError('This PDF has already been imported with different details. Check its stock in Grocy before continuing.',409);
        const index = Number(marker[1]);
        if (!Number.isInteger(index) || index < 0 || index >= receipt.products.length) throw new GrocyError('Grocy returned an invalid receipt marker. Check its stock before continuing.',409,true);
        journal.rows[String(index)] = {productId:validId(log.product_id),state:'done',note:log.note};
      }
      if (count() === receipt.products.length) { journal.done = true; journal.confirmedAt ||= new Date().toISOString(); return result(); }
      if (Object.values(journal.rows).some(row=>row.state === 'inflight')) throw new GrocyError('A previous stock write is still unconfirmed. Check Grocy before trying again; keep this page open.',409,true);
      const [products,locations,groups,units,stores,settings] = await Promise.all([list('products'),list('locations'),list('product_groups'),list('quantity_units'),list('shopping_locations'),request('system/config')]);
      if (settings?.CURRENCY !== receipt.currency) throw new GrocyError(`Receipt currency must match Grocy’s configured currency before import. Penny does not convert prices.`,409);
      // Validate every row before creating objects or adding any stock.
      const newProductUnits = new Map<string,string>();
      const planned = receipt.products.map((product,index) => {
        const existing = findNamed(products,product.name,'product');
        const location = findNamed(locations,product.location!,'location');
        const group = findNamed(groups,product.productGroup!,'product group');
        if (!location || !group) throw new GrocyError(`“${product.name}”: its location or group does not exist in Grocy. Check the selected names.`,409);
        if (existing && (Number(existing.enable_tare_weight_handling) === 1 || Number(existing.no_own_stock) === 1 || Number(existing.active) === 0)) throw new GrocyError(`“${product.name}” needs manual stock handling in Grocy.`,409);
        const stockUnit = existing ? units.find(unit=>Number(unit.id) === Number(existing.qu_id_stock)) : undefined;
        const exactUnit = findNamed(units,product.unit,'unit');
        const matches = exactUnit ? [exactUnit] : units.filter(unit=>[unit.name,unit.name_plural || ''].some(name=>canonicalUnit(name) === canonicalUnit(product.unit)));
        if (!existing && matches.length > 1) throw new GrocyError(`“${product.unit}” matches multiple Grocy units. Use an unambiguous unit name.`,409);
        const firstUnit = newProductUnits.get(normalized(product.name)) || matches[0]?.name || product.unit;
        if (!existing) newProductUnits.set(normalized(product.name),firstUnit);
        const factor = existing && stockUnit ? unitFactor(product.unit,stockUnit.name) : existing ? undefined : unitFactor(product.unit,firstUnit);
        if (factor === undefined) throw new GrocyError(`“${product.name}”: ${product.unit} cannot safely convert to its Grocy stock unit (${stockUnit?.name || 'unknown'}).`,409);
        return {product,index,existing,locationId:validId(location.id),groupId:validId(group.id),unit:matches[0],factor};
      });
      const store = findNamed(stores,receipt.store,'store');
      const storeId = store ? validId(store.id) : validId((await request('objects/shopping_locations','POST',{name:receipt.store})).created_object_id);
      for (const item of planned) {
        const {product,index,locationId,groupId,factor} = item;
        const existing = findNamed(products,product.name,'product');
        if (journal.rows[String(index)]?.state === 'done') continue;
        let productId = existing ? validId(existing.id) : journal.rows[String(index)]?.productId;
        if (!productId) {
          let unit = item.unit || findNamed(units,product.unit,'unit') || units.find(unit=>canonicalUnit(unit.name) === canonicalUnit(product.unit));
          if (!unit) {
            const id = validId((await request('objects/quantity_units','POST',{name:product.unit,name_plural:product.unit})).created_object_id);
            unit = {id,name:product.unit,name_plural:product.unit}; units.push(unit);
          }
          productId = validId((await request('objects/products','POST',{name:product.name,location_id:locationId,product_group_id:groupId,qu_id_stock:validId(unit.id),qu_id_purchase:validId(unit.id),qu_id_consume:validId(unit.id),qu_id_price:validId(unit.id),default_best_before_days:0})).created_object_id);
          products.push({id:productId,name:product.name,qu_id_stock:unit.id,product_group_id:groupId,location_id:locationId});
        } else if (existing && Number(existing.product_group_id) !== groupId) {
          await request(`objects/products/${productId}`,'PUT',{product_group_id:groupId});
          existing.product_group_id = groupId;
        }
        const note = `Penny:${key}:${payloadHash}:${index} | Receipt ${receipt.receiptDate}`;
        journal.payloadHash = payloadHash;
        journal.rows[String(index)] = {productId,state:'inflight',note};
        const amount = product.quantity! * factor;
        try {
          await request(`stock/products/${productId}/add`,'POST',{amount,price:product.price! / amount,best_before_date:product.expiry,transaction_type:'purchase',location_id:locationId,shopping_location_id:storeId,stock_label_type:1,note});
        } catch (error) {
          if (error instanceof GrocyError && !error.uncertain) { journal.rows[String(index)].state = 'pending'; }
          throw error;
        }
        journal.rows[String(index)].state = 'done';
      }
      journal.done = true; journal.confirmedAt = new Date().toISOString();
      return result();
    } catch (error) {
      const failure = error instanceof GrocyError ? error : new GrocyError('Confirmation was interrupted. Keep this page open and check its stock in Grocy before retrying.',500,true);
      failure.count = count(); failure.total = receipt.products.length; throw failure;
    }
  }
  return (value: unknown): Promise<GrocyResult> => {
    const next = tail.then(()=>run(value)); tail = next.catch(()=>{}); return next;
  };
}
