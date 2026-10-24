import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const storageLocations = ['Coffee & Tea', 'Countertop', 'Freezer', 'Fridge', 'Household Supplies', 'Oils & Condiments', 'Pantry', 'Spice Rack'] as const;
export const productGroups = ['Bakery & Bread', 'Baking Ingredients', 'Beverages', 'Canned & Jarred Foods', 'Coffee & Tea', 'Dairy & Eggs', 'Fish & Seafood', 'Frozen Foods', 'Fruits & Berries', 'Grains, Rice & Pasta', 'Household Supplies', 'Meat & Poultry', 'Nuts & Dried Fruits', 'Oils, Sauces & Condiments', 'Snacks & Sweets', 'Spices & Seasonings', 'Vegetables'] as const;

/** Coordinates are fractions of the upright page shown by PDF.js, from its top-left. */
export type SourceLocation = { page: number; x: number; y: number; width: number; height: number; text?: string };
export type Product = { id: string; name: string; quantity: number | undefined; unit: string; price: number | undefined; expiry: string; uncertain: boolean; location?: string; productGroup?: string; sourceLocation?: SourceLocation };
export type ReviewState = { products: Product[]; store: string; receiptDate: string; currency: string; aiExtracted?: boolean; extractionWarnings?: string[]; receiptTotal?: number | null };
export type GrocySync = { status: 'partial' | 'confirmed'; count: number; total: number; uncertain?: boolean; confirmedAt?: string };

export function validSourceLocation(value?: SourceLocation): SourceLocation | undefined {
  if (!value || !Number.isInteger(value.page) || value.page < 1) return;
  if (![value.x, value.y, value.width, value.height].every(Number.isFinite)) return;
  if (value.x < 0 || value.y < 0 || value.width <= 0 || value.height <= 0 || value.x + value.width > 1.000001 || value.y + value.height > 1.000001) return;
  return value;
}

export class ReviewHistory<T> {
  past: T[] = [];
  future: T[] = [];
  private limit: number;
  constructor(limit = 30) { this.limit = limit; }
  checkpoint(value: T) { this.past = [...this.past.slice(-(this.limit - 1)), structuredClone(value)]; this.future = []; }
  undo(current: T): T | undefined {
    const previous = this.past.pop();
    if (previous === undefined) return;
    this.future.push(structuredClone(current));
    return structuredClone(previous);
  }
  redo(current: T): T | undefined {
    const next = this.future.pop();
    if (next === undefined) return;
    this.past.push(structuredClone(current));
    return structuredClone(next);
  }
  restore(past: T[], future: T[]) { this.past = structuredClone(past.slice(-this.limit)); this.future = structuredClone(future.slice(-this.limit)); }
  clear() { this.past = []; this.future = []; }
}

export async function fingerprintPdf(pdf: Blob): Promise<string> {
  return bytesToHex(sha256(new Uint8Array(await pdf.arrayBuffer())));
}

export type ExtractionResult = { products: Product[]; store: string; receiptDate: string; currency: string; receiptTotal: number | null; warnings: string[] };

// getRandomValues also works on ordinary HTTP LAN origins.
export function createId(random: Pick<Crypto, 'getRandomValues'> = globalThis.crypto): string {
  const bytes = random.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
