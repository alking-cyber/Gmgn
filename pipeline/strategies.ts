/**
 * Exit strategies for the backtest in evaluate.ts. Pure functions over a
 * price path (journal snapshots), so they can be unit-tested in selftest.ts.
 *
 * Fill rules (deliberately pessimistic):
 *   - A stop fills at the snapshot price that crossed it (price can gap through a stop).
 *   - A take-profit fills at its level (a resting limit order), never better.
 *   - The stop is checked before take-profits within the same snapshot.
 */

export interface ExitRule {
  /** Stop loss before the first target, as a multiple of entry (0.7 = -30%). */
  sl: number;
  /** Targets as multiples of entry, each selling `sell` of the position. */
  firstTp: number;
  firstSell: number; // fraction of the position sold at firstTp (1 = everything)
  /** After firstTp, a new target every `step` (e.g. 0.25 → +175%, +200%, ...), each selling `stepSell` of what is left. */
  step?: number;
  stepSell?: number;
  /** Stop for what is left after the first target is hit. */
  runnerStop?: "entry" | "ladder" | "trail";
  trailPct?: number; // for "trail": sell if price falls this far from its peak (0.3 = 30%)
}

export const STRATEGIES: Record<string, ExitRule | null> = {
  // null = buy and hold until the journal ends
  "hold (sampai jurnal habis)": null,
  "C: jual semua +25%, SL -25%": { sl: 0.75, firstTp: 1.25, firstSell: 1 },
  "D: jual semua +25%, SL -12%": { sl: 0.88, firstTp: 1.25, firstSell: 1 },
  "jual semua +50%, SL -30%": { sl: 0.7, firstTp: 1.5, firstSell: 1 },
  // A: sell 50% at +50%, then 25% of what is left at every further +25%, rest out at entry.
  "A: 50% @+50%, 25% sisa/+25%, stop modal": {
    sl: 0.75, firstTp: 1.5, firstSell: 0.5, step: 0.25, stepSell: 0.25, runnerStop: "entry",
  },
  "A + stop bertahap, SL -30%": {
    sl: 0.7, firstTp: 1.5, firstSell: 0.5, step: 0.25, stepSell: 0.25, runnerStop: "ladder",
  },
  "A + trailing 30%, SL -30%": {
    sl: 0.7, firstTp: 1.5, firstSell: 0.5, step: 0.25, stepSell: 0.25, runnerStop: "trail", trailPct: 0.3,
  },
};

/**
 * Returns the net return (0.25 = +25%) of one trade entered at prices[0],
 * with `costPerSide` (slippage + fee, e.g. 0.015) charged on entry and every exit.
 */
export function runExit(prices: number[], rule: ExitRule | null, costPerSide: number): number {
  const entry = prices[0];
  if (!(entry > 0)) return NaN;
  const net = (proceedsPerUnit: number) => (proceedsPerUnit * (1 - costPerSide)) / (1 + costPerSide) - 1;
  if (!rule) return net(prices[prices.length - 1] / entry);

  let pos = 1; // fraction of the position still held
  let cash = 0; // proceeds, in units of entry price
  let stop = rule.sl;
  let next = rule.firstTp;
  const hits: number[] = [];
  let peak = 1;

  for (let i = 1; i < prices.length && pos > 1e-9; i++) {
    const x = prices[i] / entry;
    if (x <= stop) {
      cash += pos * x; // gapped through the stop: fill at the observed price
      pos = 0;
      break;
    }
    while (pos > 1e-9 && x >= next) {
      const frac = hits.length === 0 ? rule.firstSell : (rule.stepSell ?? 1);
      const sell = pos * frac;
      cash += sell * next;
      pos -= sell;
      hits.push(next);
      if (!rule.step) break; // single-target rule: whatever is left rides with the runner stop
      next = +(next + rule.step).toFixed(6);
    }
    if (!rule.step && hits.length) next = Infinity;
    peak = Math.max(peak, x);
    if (hits.length) {
      if (rule.runnerStop === "entry") stop = Math.max(stop, 1);
      else if (rule.runnerStop === "ladder") stop = Math.max(stop, hits.length > 1 ? hits[hits.length - 2] : 1);
      else if (rule.runnerStop === "trail") stop = Math.max(stop, 1, peak * (1 - (rule.trailPct ?? 0.3)));
    }
  }
  cash += pos * (prices[prices.length - 1] / entry); // time stop at the end of the path
  return net(cash);
}
