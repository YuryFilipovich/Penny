import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export type Usage = { limit: number; used: number; remaining: number; timezone: string; resetAt: string };
export class QuotaError extends Error {
  status: number;
  usage?: Usage;
  constructor(message: string, status: number, usage?: Usage) { super(message); this.status = status; this.usage = usage; }
}

// One server process owns this counter. Only its date and count are persisted.
export class DailyQuota {
  private tail: Promise<unknown> = Promise.resolve();
  private memory = { date: '', used: 0 };
  private formatter: Intl.DateTimeFormat;
  private limit: number;
  private timezone: string;
  private file?: string;
  private now: () => Date;
  constructor(options: { limit?: number; timezone?: string; file?: string; now?: () => Date } = {}) {
    this.limit = options.limit ?? 10; this.timezone = options.timezone ?? 'Europe/Warsaw';
    this.file = options.file; this.now = options.now ?? (() => new Date());
    if (!Number.isInteger(this.limit) || this.limit < 1) throw new Error('DAILY_RECEIPT_LIMIT must be a positive integer.');
    this.formatter = new Intl.DateTimeFormat('en-CA', { timeZone: this.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  }
  private date(time: Date) {
    const parts = this.formatter.formatToParts(time);
    return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
  }
  private resetAt(now: Date, date: string) {
    // Find the next local midnight, including 23/25-hour daylight-saving days.
    let low = now.getTime(), high = low + 36 * 60 * 60 * 1000;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (this.date(new Date(middle)) === date) low = middle; else high = middle;
    }
    return new Date(high).toISOString();
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation); this.tail = next.catch(() => {}); return next;
  }
  private async read() {
    if (!this.file) return this.memory;
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      if (!value || typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) || !Number.isSafeInteger(value.used) || value.used < 0) throw new Error('Invalid counter');
      return { date: value.date as string, used: value.used as number };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { date: '', used: 0 };
      throw new QuotaError('The daily scan counter is unavailable. Try again after the server is checked.', 503);
    }
  }
  private async usage(consume: boolean) {
    const now = this.now(), date = this.date(now);
    const saved = await this.read();
    const used = saved.date === date ? saved.used : 0;
    const usage = { limit: this.limit, used, remaining: Math.max(0, this.limit - used), timezone: this.timezone, resetAt: this.resetAt(now, date) };
    if (!consume) return usage;
    if (used >= this.limit) throw new QuotaError('Daily scan limit reached. Scans reset at midnight in Warsaw.', 429, usage);
    const next = { date, used: used + 1 };
    if (this.file) {
      try {
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        await writeFile(this.file + '.tmp', JSON.stringify(next) + '\n', { mode: 0o600, flush: true });
        await rename(this.file + '.tmp', this.file);
      } catch { throw new QuotaError('The daily scan counter could not be saved. No scan was started.', 503); }
    }
    this.memory = next;
    return { ...usage, used: next.used, remaining: this.limit - next.used };
  }
  status() { return this.serialize(() => this.usage(false)); }
  consume() { return this.serialize(() => this.usage(true)); }
}
