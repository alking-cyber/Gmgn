/**
 * Paper trading: every alert opens a simulated position, the journal's price
 * polls close it. No orders are sent anywhere.
 *
 * Rules (config.paper):
 *   - size: positionPct of equity (cash + open positions at cost), capped by free cash;
 *     alerts arriving while maxOpen positions are open are skipped (and counted)
 *   - take-profit: sells everything at entry × takeProfit (a resting limit order, so it fills at the level)
 *   - stop-loss: sells everything at the first polled price at or below entry × stopLoss
 *     (fills at that observed price, which can be well below the stop when price gaps)
 *   - time stop: sells at the polled price after maxHoldMin
 *   - costPct is charged on entry and on exit (slippage + fees)
 *
 * Runner hold (config.paper.runner, when enabled): at the take-profit, sell (1 - keepPct) and keep
 * the rest so a runner can pay for the losers. Default: sell half at 2x (the stake comes back) and
 * hold the other half with no target; it exits only if price falls to stopX × entry (−30%), or after
 * maxHoldMin. Kept halves do not count toward maxOpen (they would block new trades for days).
 * Optional extras, off by default (each 0/false = off):
 *   - keep only when strong: holders up minHolderGrowth since the buy, 5-minute volume ≥ minVolume5m,
 *     smart money + KOL not fewer than at the buy (smartNotFewer)
 *   - trailPct: also exit trailPct below the highest polled price
 *   - holderDropPct: also exit when holders fall that far below their high
 * Why the default: blending 43 ordinary gated trades with the 11 gated $10M+ runners, "half at 2x,
 * hold the rest" broke even at one runner per 100 trades and earned at one per 50, while a 2x
 * full exit or a 30–50% trailing stop lost at every runner rate (they cut runners at 2–7x).
 */

import type { PipelineConfig } from "./config.js";

/** Token state the runner check compares against (from token info). */
export interface Strength {
  holders: number;
  volume5m: number;
  smartPlusKol: number;
}

export interface PaperPosition {
  symbol: string;
  entryPrice: number;
  size: number; // USD committed, before costs
  openedAt: number;
  entry?: Strength; // token state at the buy, for the runner check
  runner?: {
    keptFrac: number; // share of the position still held
    realized: number; // USD already received from the part sold at the take-profit
    since: number; // when the take-profit was reached
    peakPrice: number;
    peakHolders: number;
  };
}

export interface PaperState {
  cash: number;
  positions: Record<string, PaperPosition>;
  trades: number;
  wins: number;
  peakEquity: number;
  maxDrawdown: number; // 0.2 = 20% below the peak
  skipped: number; // alerts not taken because maxOpen positions were open
}

export const emptyPaper = (capital: number): PaperState => ({
  cash: capital,
  positions: {},
  trades: 0,
  wins: 0,
  peakEquity: capital,
  maxDrawdown: 0,
  skipped: 0,
});

export type ExitReason = "take_profit" | "stop_loss" | "time_stop" | "runner_stop" | "runner_trail" | "runner_holders_leaving" | "runner_time";

/** Part of a position sold at the take-profit while the rest is kept as a runner. */
export interface PaperPartial {
  address: string;
  symbol: string;
  price: number;
  soldFrac: number;
  proceeds: number;
  why: string; // which checks made it a runner
}

export interface PaperClose {
  address: string;
  symbol: string;
  reason: ExitReason;
  entryPrice: number;
  exitPrice: number;
  size: number;
  proceeds: number;
  ret: number; // net return of the whole position after costs (sold parts included), 0.25 = +25%
  heldMin: number;
  cashAfter: number;
}

export class Paper {
  constructor(private readonly c: PipelineConfig["paper"], readonly s: PaperState) {}

  private get cost() {
    return this.c.costPct / 100;
  }

  /** Opens a position on an alert. Returns undefined when already holding it, full, or out of cash. */
  open(address: string, symbol: string, price: number, t: number, entry?: Strength): PaperPosition | undefined {
    if (this.s.positions[address] || !(price > 0)) return undefined;
    if (Object.values(this.s.positions).filter((x) => !x.runner).length >= this.c.maxOpen) {
      this.s.skipped = (this.s.skipped ?? 0) + 1;
      return undefined;
    }
    const size = Math.min(this.s.cash, this.equity() * this.c.positionPct);
    if (size < 0.01) return undefined;
    this.s.cash -= size;
    const p: PaperPosition = { symbol, entryPrice: price, size, openedAt: t, entry };
    this.s.positions[address] = p;
    return p;
  }

  /**
   * Feeds a new price (and, for the runner check, the token's current state) for one token.
   * Returns the close when an exit rule fires, or the partial sale when a take-profit turns
   * the position into a runner.
   */
  mark(address: string, price: number, t: number, now?: Strength): PaperClose | PaperPartial | undefined {
    const p = this.s.positions[address];
    if (!p || !(price > 0)) return undefined;
    const x = price / p.entryPrice;
    if (p.runner) return this.markRunner(address, p, x, t, now);
    let reason: ExitReason | undefined;
    let exitX = x;
    if (x >= this.c.takeProfit) {
      const why = this.strong(p, now);
      if (why) return this.keepRunner(address, p, t, x, now, why);
      reason = "take_profit";
      exitX = this.c.takeProfit; // limit order fills at its level, never better
    } else if (x <= this.c.stopLoss) {
      reason = "stop_loss"; // fills at the observed price: gaps through the stop are real losses
    } else if (t - p.openedAt >= this.c.maxHoldMin * 60) {
      reason = "time_stop";
    }
    if (!reason) return undefined;
    return this.close(address, reason, p.entryPrice * exitX, t);
  }

  /** Returns why the rest is kept, or undefined (runner hold off, or a strength check enabled and failed). */
  private strong(p: PaperPosition, now?: Strength): string | undefined {
    const r = this.c.runner;
    if (!r.enabled) return undefined;
    const checks = r.minHolderGrowth > 0 || r.minVolume5m > 0 || r.smartNotFewer;
    if (!checks) return "runner hold";
    if (!p.entry || !now) return undefined;
    const growth = p.entry.holders > 0 ? now.holders / p.entry.holders - 1 : 0;
    if (r.minHolderGrowth > 0 && growth < r.minHolderGrowth) return undefined;
    if (now.volume5m < r.minVolume5m) return undefined;
    if (r.smartNotFewer && now.smartPlusKol < p.entry.smartPlusKol) return undefined;
    return `holders +${Math.round(growth * 100)}%, 5m volume $${Math.round(now.volume5m / 1000)}K, smart+KOL ${now.smartPlusKol}`;
  }

  private keepRunner(address: string, p: PaperPosition, t: number, x: number, now: Strength | undefined, why: string): PaperPartial {
    const soldFrac = 1 - this.c.runner.keepPct;
    const proceeds = p.size * soldFrac * ((this.c.takeProfit * (1 - this.cost)) / (1 + this.cost));
    this.s.cash += proceeds;
    p.runner = { keptFrac: this.c.runner.keepPct, realized: proceeds, since: t, peakPrice: p.entryPrice * x, peakHolders: now?.holders ?? 0 };
    return { address, symbol: p.symbol, price: p.entryPrice * this.c.takeProfit, soldFrac, proceeds, why };
  }

  private markRunner(address: string, p: PaperPosition, x: number, t: number, now?: Strength): PaperClose | undefined {
    const r = this.c.runner;
    const run = p.runner!;
    const price = p.entryPrice * x;
    run.peakPrice = Math.max(run.peakPrice, price);
    if (now) run.peakHolders = Math.max(run.peakHolders, now.holders);
    const stop = Math.max(p.entryPrice * r.stopX, r.trailPct > 0 ? run.peakPrice * (1 - r.trailPct) : 0);
    let reason: ExitReason | undefined;
    if (price <= stop) reason = r.trailPct > 0 && stop > p.entryPrice * r.stopX ? "runner_trail" : "runner_stop"; // fills at the observed price
    else if (r.holderDropPct > 0 && now && now.holders <= run.peakHolders * (1 - r.holderDropPct)) reason = "runner_holders_leaving";
    else if (t - run.since >= r.maxHoldMin * 60) reason = "runner_time";
    if (!reason) return undefined;
    return this.close(address, reason, price, t);
  }

  private close(address: string, reason: ExitReason, exitPrice: number, t: number): PaperClose {
    const p = this.s.positions[address];
    const kept = p.runner?.keptFrac ?? 1;
    const last = p.size * kept * (((exitPrice / p.entryPrice) * (1 - this.cost)) / (1 + this.cost));
    const proceeds = (p.runner?.realized ?? 0) + last;
    const ret = proceeds / p.size - 1;
    delete this.s.positions[address];
    this.s.cash += last;
    this.s.trades++;
    if (ret > 0) this.s.wins++;
    return {
      address,
      symbol: p.symbol,
      reason,
      entryPrice: p.entryPrice,
      exitPrice,
      size: p.size,
      proceeds,
      ret,
      heldMin: (t - p.openedAt) / 60,
      cashAfter: this.s.cash,
    };
  }

  /**
   * Equity = cash + open positions at their last known value. Positions are
   * valued at cost until they close (a runner at the cost of the part still held),
   * which keeps the drawdown figure honest about realized results only.
   */
  equity(): number {
    return this.s.cash + Object.values(this.s.positions).reduce((a, p) => a + p.size * (p.runner?.keptFrac ?? 1), 0);
  }

  /** Updates peak equity and max drawdown; call after every close. */
  trackDrawdown(): void {
    const eq = this.equity();
    this.s.peakEquity = Math.max(this.s.peakEquity, eq);
    this.s.maxDrawdown = Math.max(this.s.maxDrawdown, 1 - eq / this.s.peakEquity);
  }

  summary(): string {
    const open = Object.keys(this.s.positions).length;
    const wr = this.s.trades ? `${Math.round((this.s.wins / this.s.trades) * 100)}%` : "-";
    return (
      `paper: equity $${this.equity().toFixed(2)} (cash $${this.s.cash.toFixed(2)}, ${open} open) · ` +
      `${this.s.trades} closed, win ${wr}, ${Object.values(this.s.positions).filter((x) => x.runner).length} runners held, max drawdown ${(this.s.maxDrawdown * 100).toFixed(0)}%, ` +
      `${this.s.skipped ?? 0} alerts skipped (max ${this.c.maxOpen} open)`
    );
  }
}
