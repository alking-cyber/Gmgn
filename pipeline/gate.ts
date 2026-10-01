/**
 * The loose runner gate (same rules as the gmgn-degen scan, Step 3b), measured at the minute a
 * token first closed at or above $100K market cap, from 1-minute candles only up to that minute.
 *
 *   volume into the cross   the crossing candle + the 4 before it ≥ $15K
 *   not instant             crossed at least 1 minute after creation
 *   not vertical            close / close 5 candles earlier − 1 ≤ +200%
 *   not inflated            the first candle opened below $200K
 *
 * Measured on the 15 tokens that ran from $100K to $10M+ in the 30 days before 2026-10-01 vs 179
 * ordinary tokens that crossed $100K (age-based, dead ones included): 11 of 15 runners passed,
 * 24% of the ordinary tokens did.
 */

import type { Candle } from "./gmgn.js";

export const GATE = {
  crossMcap: 100_000,
  maxCrossAgeMin: 60, // only tokens that crossed in their first hour (the measured population)
  minVolume5m: 15_000,
  minAgeMin: 1,
  maxChange5m: 2, // +200%
  inflatedMcap: 200_000,
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
  const reasons: string[] = [];
  if (volume5m < g.minVolume5m) reasons.push("low_volume");
  if (ageMin < g.minAgeMin) reasons.push("instant");
  if (change5m > g.maxChange5m) reasons.push("vertical");
  return { status: reasons.length ? "fail" : "pass", crossAt, crossMcap: candles[i].c * supply, ageMin, volume5m, change5m, reasons };
}

/**
 * Highest market cap reached in the hourly candles, counting only hours with real trading
 * (volume ≥ minHourVolume) so a single stray print cannot fake a runner.
 */
export function peakMcap(hourly: Candle[], supply: number, minHourVolume = 5_000): number {
  return hourly.reduce((m, k) => ((k.volume || 0) >= minHourVolume ? Math.max(m, k.c * supply) : m), 0);
}
