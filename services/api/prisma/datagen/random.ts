// Deterministic randomness for the data generator: the same seed gives the same data.
// sfc32 instead of faker for numbers: millions of draws, and faker's per-call checks add up.
import { v7 as uuidv7 } from 'uuid';

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    this.a = 0x9e3779b9;
    this.b = 0x243f6a88;
    this.c = 0xb7e15162;
    this.d = seed >>> 0;
    for (let i = 0; i < 15; i++) this.next();
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** Integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error('Rng.pick: empty list');
    return item;
  }

  bytes16(): Uint8Array {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i += 4) {
      const n = (this.next() * 4294967296) >>> 0;
      bytes[i] = n & 0xff;
      bytes[i + 1] = (n >>> 8) & 0xff;
      bytes[i + 2] = (n >>> 16) & 0xff;
      bytes[i + 3] = (n >>> 24) & 0xff;
    }
    return bytes;
  }

  /** UUIDv7 born at `at`: id order follows created_at order, as in production. */
  uuidAt(at: Date): string {
    return uuidv7({ msecs: at.getTime(), random: this.bytes16() });
  }
}

/** Zipf weights normalised to 1: rank k gets 1 / k^s. */
export function zipfShares(n: number, s = 1.1): number[] {
  const weights = Array.from({ length: n }, (_, i) => 1 / (i + 1) ** s);
  const sum = weights.reduce((acc, w) => acc + w, 0);
  return weights.map((w) => w / sum);
}

/** Draws an index proportionally to `weights` (binary search over the cumulative sum). */
export class WeightedSampler<T> {
  private readonly cumulative: number[] = [];
  private readonly total: number;

  constructor(
    private readonly values: readonly T[],
    weights: readonly number[],
  ) {
    let sum = 0;
    for (const w of weights) this.cumulative.push((sum += w));
    this.total = sum;
  }

  sample(rng: Rng): T {
    const target = rng.next() * this.total;
    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.cumulative[mid] ?? 0) > target) hi = mid;
      else lo = mid + 1;
    }
    const value = this.values[lo];
    if (value === undefined) throw new Error('WeightedSampler: empty');
    return value;
  }

  static of<T>(entries: readonly (readonly [T, number])[]): WeightedSampler<T> {
    return new WeightedSampler(
      entries.map(([v]) => v),
      entries.map(([, w]) => w),
    );
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
