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
 */

import type { PipelineConfig } from "./config.js";

export interface PaperPosition {
  symbol: string;
  entryPrice: number;
  size: number; // USD committed, before costs
  openedAt: number;
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

export type ExitReason = "take_profit" | "stop_loss" | "time_stop";

export interface PaperClose {
  address: string;
  symbol: string;
  reason: ExitReason;
  entryPrice: number;
  exitPrice: number;
  size: number;
  proceeds: number;
  ret: number; // net return after costs, 0.25 = +25%
  heldMin: number;
  cashAfter: number;
}

export class Paper {
  constructor(private readonly c: PipelineConfig["paper"], readonly s: PaperState) {}

  private get cost() {
    return this.c.costPct / 100;
  }

  /** Opens a position on an alert. Returns undefined when already holding it, full, or out of cash. */
  open(address: string, symbol: string, price: number, t: number): PaperPosition | undefined {
    if (this.s.positions[address] || !(price > 0)) return undefined;
    if (Object.keys(this.s.positions).length >= this.c.maxOpen) {
      this.s.skipped = (this.s.skipped ?? 0) + 1;
      return undefined;
    }
    const size = Math.min(this.s.cash, this.equity() * this.c.positionPct);
    if (size < 0.01) return undefined;
    this.s.cash -= size;
    const p = { symbol, entryPrice: price, size, openedAt: t };
    this.s.positions[address] = p;
    return p;
  }

  /** Feeds a new price for one token; closes the position when an exit rule fires. */
  mark(address: string, price: number, t: number): PaperClose | undefined {
    const p = this.s.positions[address];
    if (!p || !(price > 0)) return undefined;
    const x = price / p.entryPrice;
    let reason: ExitReason | undefined;
    let exitX = x;
    if (x >= this.c.takeProfit) {
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

  private close(address: string, reason: ExitReason, exitPrice: number, t: number): PaperClose {
    const p = this.s.positions[address];
    const ret = ((exitPrice / p.entryPrice) * (1 - this.cost)) / (1 + this.cost) - 1;
    const proceeds = p.size * (1 + ret);
    delete this.s.positions[address];
    this.s.cash += proceeds;
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
   * valued at cost until they close, which keeps the drawdown figure honest
   * about realized results only.
   */
  equity(): number {
    return this.s.cash + Object.values(this.s.positions).reduce((a, p) => a + p.size, 0);
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
      `${this.s.trades} closed, win ${wr}, max drawdown ${(this.s.maxDrawdown * 100).toFixed(0)}%, ` +
      `${this.s.skipped ?? 0} alerts skipped (max ${this.c.maxOpen} open)`
    );
  }
}
