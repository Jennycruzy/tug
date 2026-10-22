/**
 * Token bucket measured in request weight per minute. The clock and sleep are injected so the
 * pacing logic is testable without real time.
 */
export class WeightBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.tokens = perMinute;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    const add = ((t - this.last) / 60_000) * this.perMinute;
    this.tokens = Math.min(this.perMinute, this.tokens + add);
    this.last = t;
  }

  /** Waits until `weight` tokens are available, then spends them. */
  async take(weight: number): Promise<void> {
    if (weight > this.perMinute) throw new Error(`weight ${weight} exceeds bucket size ${this.perMinute}`);
    for (;;) {
      this.refill();
      if (this.tokens >= weight) {
        this.tokens -= weight;
        return;
      }
      const missing = weight - this.tokens;
      await this.sleep(Math.ceil((missing / this.perMinute) * 60_000));
    }
  }
}
