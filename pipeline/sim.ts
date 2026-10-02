/**
 * The paper book's exit rules replayed on candles (used by backtest.ts and outcomes.ts): enter at
 * the open of the first tradeable candle, stop checked before target inside a candle, a gap below
 * the stop fills at the open, a rug candle fills between the stop and the close, a target fills at
 * its level, costs per side.
 */

import type { PipelineConfig } from "./config.js";
import type { Candle } from "./gmgn.js";

export const MIN_TRADE_VOLUME = 1000; // candles with less than $1K traded cannot fill a $5 order at that price

export interface SimTrade { at: number; ret: number; endAt: number; why: string; peakX: number; lowX: number }

export function simulate(path: Candle[], P: PipelineConfig["paper"], maxEntryPrice = Infinity): SimTrade | null {
  const K = path.filter((k) => (k.volume || 0) >= MIN_TRADE_VOLUME);
  if (K.length < 2) return null;
  const e = K[0].o;
  if (!(e > 0) || e > maxEntryPrice) return null;
  const cost = P.costPct / 100;
  const net = (x: number) => (x * (1 - cost)) / (1 + cost) - 1;
  let peak = 1, low = 1;
  for (let j = 1; j < K.length; j++) {
    const k = K[j];
    const o = k.o / e, h = k.h / e, l = k.l / e, c = k.c / e;
    const trailing = P.trailArm > 0 && peak >= P.trailArm;
    const stop = trailing ? Math.max(P.stopLoss, peak * (1 - P.trailPct)) : P.stopLoss;
    let x: number | null = null;
    let why = "";
    if (k.t - K[0].t >= P.maxHoldMin * 60) { x = o; why = "time"; }
    else if (o <= stop) { x = o; why = trailing ? "trailing (gap)" : "stop (gap)"; }
    else if (l <= stop) { x = c >= 0.5 * stop ? stop : (stop + c) / 2; why = trailing ? "trailing" : "stop"; }
    else if (P.takeProfit > 0 && h >= P.takeProfit) { x = P.takeProfit; why = "target"; }
    peak = Math.max(peak, h);
    low = Math.min(low, l);
    if (x != null) return { at: K[0].t, ret: net(x), endAt: k.t + 60, why, peakX: peak, lowX: low };
  }
  const x = K[K.length - 1].c / e;
  return { at: K[0].t, ret: net(x), endAt: K[K.length - 1].t + 60, why: "still open", peakX: peak, lowX: low };
}

/** Highest and lowest price over the whole path relative to the entry (no exit rule). */
export function range(path: Candle[]): { peakX: number; lowX: number; lastX: number } | null {
  const K = path.filter((k) => (k.volume || 0) >= MIN_TRADE_VOLUME);
  if (K.length < 2 || !(K[0].o > 0)) return null;
  const e = K[0].o;
  return { peakX: Math.max(...K.map((k) => k.h)) / e, lowX: Math.min(...K.map((k) => k.l)) / e, lastX: K[K.length - 1].c / e };
}
