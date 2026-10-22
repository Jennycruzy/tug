/**
 * Request-weight limiter over a sliding 60-second window: a request goes out only if the weight sent in
 * the last 60 s plus its own stays within `perMinute`, so no 60 s window ever exceeds the budget (a plain
 * token bucket that starts full lets close to two minutes' weight through in the first minute). The clock
 * and sleep are injected so the pacing logic is testable without real time.
 */
export class WeightBucket {
  private readonly sent: Array<{ t: number; w: number }> = [];
  private used = 0;

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private expire(t: number): void {
    while (this.sent.length > 0 && this.sent[0]!.t <= t - 60_000) this.used -= this.sent.shift()!.w;
  }

  /** Waits until sending `weight` keeps the last 60 s within the budget, then records it as sent. */
  async take(weight: number): Promise<void> {
    if (weight > this.perMinute) throw new Error(`weight ${weight} exceeds the budget of ${this.perMinute} per minute`);
    for (;;) {
      const t = this.now();
      this.expire(t);
      if (this.used + weight <= this.perMinute) {
        this.sent.push({ t, w: weight });
        this.used += weight;
        return;
      }
      // Sleep until enough of the oldest weight leaves the window.
      let freed = 0;
      let i = 0;
      while (freed < this.used + weight - this.perMinute) freed += this.sent[i++]!.w;
      await this.sleep(Math.max(1, this.sent[i - 1]!.t + 60_000 - t + 1));
    }
  }
}
