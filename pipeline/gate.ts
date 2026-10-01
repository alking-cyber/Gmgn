/**
 * The loose runner gate (same rules as the gmgn-degen scan, Step 3b), measured at the minute a
 * token first closed at or above $100K market cap, from 1-minute candles only up to that minute.
 *
 *   volume into the cross   the crossing candle + the 4 before it ≥ $15K
 *   not instant             crossed at least 1 minute after creation
 *   not vertical            close / close 5 candles earlier − 1 ≤ +200%
 *   not inflated            the first candle opened below $200K
 *   not a bot ramp          at most 80% green candles in the (up to) 15 candles into the cross,
 *                           when there are at least 4 of them — a smooth staircase with no
 *                           pullbacks is volume bots, not buyers
 *
 * Measured on the 15 tokens that ran from $100K to $10M+ in the 30 days before 2026-10-01 vs 179
 * ordinary tokens that crossed $100K (age-based, dead ones included): 11 of 15 runners passed,
 * 24% of the ordinary tokens did. The bot-ramp rule kept all 8 runners that had 4+ candles and
 * dropped 22 of 56 ordinary tokens, which averaged −43% per trade vs −27% for the rest.
 *
 * fundingFlags() adds the wallet-funding checks (needs the token's top traders):
 *   time-linked funding     ≥ 5 wallets funded inside one 10-minute window, between 24 hours before
 *                           launch and the cross — one operator spreading buys across wallets
 *   one funder              ≥ 5 wallets funded from the same non-exchange address
 * On 166 ordinary tokens these dropped 11 tokens that averaged −34% (vs −26%) and no runner.
 * Not used as red flags, because the data says otherwise: bundles / connected bubbles (every
 * runner had many bundler wallets; bundled ordinary tokens did better, not worse) and fresh
 * wallets (tokens with many did not do worse).
 */

import type { Candle } from "./gmgn.js";

export const GATE = {
  crossMcap: 100_000,
  maxCrossAgeMin: 60, // only tokens that crossed in their first hour (the measured population)
  minVolume5m: 15_000,
  minAgeMin: 1,
  maxChange5m: 2, // +200%
  inflatedMcap: 200_000,
  maxGreenShare: 0.8,
  greenWindow: 15,
  minGreenCandles: 4,
  fundingWindowSec: 600,
  maxFundedTogether: 4, // 5+ in one window is a red flag
  maxSameFunder: 4,
};

export type GateResult =
  | { status: "pending" } // not crossed yet, still inside the first hour
  | { status: "ignored"; why: string } // never crossed in its first hour, or inflated launch
  | {
      status: "pass" | "fail";
      crossAt: number; // unix seconds, end of the crossing candle
      crossMcap: number;
      ageMin: number;
      volume5m: number;
      change5m: number;
      greenShare: number | null; // null when fewer than minGreenCandles candles led into the cross
      reasons: string[]; // failed rules ("fail" only)
    };

export function runnerGate(candles: Candle[], supply: number, createdAt: number, now: number, g = GATE): GateResult {
  if (!candles.length || !(supply > 0)) return now - createdAt > g.maxCrossAgeMin * 60 ? { status: "ignored", why: "no candles" } : { status: "pending" };
  if (candles[0].o * supply >= g.inflatedMcap) return { status: "ignored", why: "inflated launch" };
  const i = candles.findIndex((k) => k.c * supply >= g.crossMcap);
  if (i < 0 || candles[i].t + 60 - createdAt > g.maxCrossAgeMin * 60) {
    return now - createdAt > g.maxCrossAgeMin * 60 ? { status: "ignored", why: "did not cross $100K in its first hour" } : { status: "pending" };
  }
  const crossAt = candles[i].t + 60;
  const ageMin = (crossAt - createdAt) / 60;
  const volume5m = candles.slice(Math.max(0, i - 4), i + 1).reduce((a, k) => a + (k.volume || 0), 0);
  const change5m = i > 0 ? candles[i].c / candles[Math.max(0, i - 5)].c - 1 : 0;
  const w = candles.slice(Math.max(0, i - g.greenWindow + 1), i + 1);
  let greenShare: number | null = null;
  if (w.length >= g.minGreenCandles) {
    let green = 0;
    for (let j = 1; j < w.length; j++) if (w[j].c > w[j - 1].c) green++;
    greenShare = green / (w.length - 1);
  }
  const reasons: string[] = [];
  if (volume5m < g.minVolume5m) reasons.push("low_volume");
  if (ageMin < g.minAgeMin) reasons.push("instant");
  if (change5m > g.maxChange5m) reasons.push("vertical");
  if (greenShare != null && greenShare > g.maxGreenShare) reasons.push("bot_ramp");
  return { status: reasons.length ? "fail" : "pass", crossAt, crossMcap: candles[i].c * supply, ageMin, volume5m, change5m, greenShare, reasons };
}

/** A trader's funding: when the wallet received SOL, from where (name set for exchanges). */
export interface Funding {
  at: number;
  from: string;
  exchange: string | null;
}

/** Wallet-funding red flags from the token's top traders, using only funding up to the cross. */
export function fundingFlags(funding: Funding[], createdAt: number, crossAt: number, g = GATE): { fundedTogether: number; sameFunder: number; reasons: string[] } {
  const f = funding.filter((x) => x.at >= createdAt - 86400 && x.at <= crossAt);
  const ts = f.map((x) => x.at).sort((a, b) => a - b);
  let fundedTogether = 0;
  for (let i = 0, j = 0; i < ts.length; i++) {
    while (ts[i] - ts[j] >= g.fundingWindowSec) j++;
    fundedTogether = Math.max(fundedTogether, i - j + 1);
  }
  const by = new Map<string, number>();
  for (const x of f) if (!x.exchange && x.from) by.set(x.from, (by.get(x.from) ?? 0) + 1);
  const sameFunder = Math.max(0, ...by.values());
  const reasons: string[] = [];
  if (fundedTogether > g.maxFundedTogether) reasons.push("funded_together");
  if (sameFunder > g.maxSameFunder) reasons.push("one_funder");
  return { fundedTogether, sameFunder, reasons };
}

/**
 * Highest market cap reached in the hourly candles, counting only hours with real trading
 * (volume ≥ minHourVolume) so a single stray print cannot fake a runner.
 */
export function peakMcap(hourly: Candle[], supply: number, minHourVolume = 5_000): number {
  return hourly.reduce((m, k) => ((k.volume || 0) >= minHourVolume ? Math.max(m, k.c * supply) : m), 0);
}
