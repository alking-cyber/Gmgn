/**
 * Pure filter rules for stages 1–3. No I/O here, so the same rules can be
 * replayed over recorded data by evaluate.ts and exercised by selftest.ts.
 *
 * Each rule returns a short machine-readable reason code on failure, so the
 * evaluator can count which rules cut which tokens.
 */

import type { PipelineConfig } from "./config.js";
import type { RankRow, TokenInfo } from "./gmgn.js";

// ---------------------------------------------------------------- stage 1

export function stage1(row: RankRow, c: PipelineConfig["s1"], nowSec: number): string[] {
  const reasons: string[] = [];
  const ageMin = (nowSec - row.createdAt) / 60;
  if (!row.createdAt || ageMin < c.minAgeMin) reasons.push("too_young");
  if (ageMin > c.maxAgeMin) reasons.push("too_old");
  if (row.holders < c.minHolders) reasons.push("few_holders");
  if (row.liquidity < c.minLiquidityUsd) reasons.push("low_liquidity");
  if (row.top10Rate > c.maxTop10Rate) reasons.push("top10_concentrated");
  if (row.devHoldRate > c.maxDevHoldRate) reasons.push("dev_concentrated");
  if (row.isWashTrading) reasons.push("wash_trading");
  return reasons;
}

// ---------------------------------------------------------------- stage 2

export interface TrackObs {
  t: number; // unix seconds
  price: number;
  marketCap: number;
  liquidity: number;
  holders: number;
  buys: number;
  sells: number;
  bundlerRate: number;
  botRate: number;
}

export function obsFromRow(row: RankRow, t: number): TrackObs {
  return {
    t,
    price: row.price,
    marketCap: row.marketCap,
    liquidity: row.liquidity,
    holders: row.holders,
    buys: row.buys,
    sells: row.sells,
    bundlerRate: row.bundlerRate,
    botRate: row.botRate,
  };
}

export interface TrackState {
  startedAt: number;
  missedScans: number;
  obs: TrackObs[];
}

export type TrackVerdict =
  | { status: "wait"; reasons: string[] }
  | { status: "pass"; summary: TrackSummary }
  | { status: "fail"; reasons: string[] };

export interface TrackSummary {
  scans: number;
  trackedSec: number;
  holderGrowthPct: number;
  liquidityChangePct: number;
  priceChangePct: number;
  buySellRatio: number;
  bundlerRate: number;
  botRate: number;
}

const pct = (a: number, b: number) => (a > 0 ? ((b - a) / a) * 100 : 0);
const sumOf = (obs: TrackObs[], k: "buys" | "sells") => obs.reduce((acc, o) => acc + o[k], 0);
const ratio = (buys: number, sells: number) => (sells > 0 ? buys / sells : buys > 0 ? Infinity : 0);

export function summarize(s: TrackState, nowSec: number): TrackSummary {
  const first = s.obs[0];
  const last = s.obs[s.obs.length - 1];
  return {
    scans: s.obs.length,
    trackedSec: nowSec - s.startedAt,
    holderGrowthPct: pct(first.holders, last.holders),
    liquidityChangePct: pct(first.liquidity, last.liquidity),
    priceChangePct: pct(first.price, last.price),
    // Summed over the whole tracking window: a single 1m window flips back and forth.
    buySellRatio: ratio(sumOf(s.obs, "buys"), sumOf(s.obs, "sells")),
    bundlerRate: last.bundlerRate,
    botRate: last.botRate,
  };
}

export function stage2(s: TrackState, c: PipelineConfig["s2"], nowSec: number): TrackVerdict {
  // Hard failures end tracking immediately.
  if (s.missedScans > c.maxMissedScans) return { status: "fail", reasons: ["left_trending"] };
  const last = s.obs[s.obs.length - 1];
  const peakHolders = Math.max(...s.obs.map((o) => o.holders));
  const peakLiq = Math.max(...s.obs.map((o) => o.liquidity));
  const hard: string[] = [];
  if (pct(peakHolders, last.holders) < -c.maxHolderDropPct) hard.push("holders_falling");
  if (pct(peakLiq, last.liquidity) < -c.maxLiquidityDropPct) hard.push("liquidity_drained");
  if (hard.length) return { status: "fail", reasons: hard };

  const sum = summarize(s, nowSec);
  const soft: string[] = [];
  if (sum.scans < c.minObservations || sum.trackedSec < c.minTrackSec) soft.push("still_observing");
  if (sum.holderGrowthPct < c.minHolderGrowthPct) soft.push("holders_flat");
  if (sum.buySellRatio < c.minBuySellRatio) soft.push("sell_pressure");
  if (last.bundlerRate > c.maxBundlerRate) soft.push("bundler_high");
  if (last.bundlerRate - s.obs[0].bundlerRate > c.maxBundlerRise) soft.push("bundler_rising");
  if (last.botRate > c.maxBotRate) soft.push("bot_rate_high");

  if (!soft.length) return { status: "pass", summary: sum };
  // Conditions not met yet: keep watching until the tracking window runs out.
  if (sum.trackedSec >= c.maxTrackSec) {
    return { status: "fail", reasons: ["timeout", ...soft.filter((r) => r !== "still_observing")] };
  }
  return { status: "wait", reasons: soft };
}

// ---------------------------------------------------------------- stage 3

export function stage3(row: RankRow, info: TokenInfo, c: PipelineConfig["s3"]): string[] {
  const reasons: string[] = [];
  // rug_ratio and the *_dup counts only exist on the rank row, not in token info.
  if (row.rugRatio > c.maxRugRatio) reasons.push("rug_ratio_high");
  if (Math.max(row.entrapmentRatio, info.entrapmentTraderPct) > c.maxEntrapment) reasons.push("entrapment_high");
  if (info.top10Rate > c.maxTop10Rate) reasons.push("top10_concentrated");
  if (info.devHoldRate > c.maxDevHoldRate) reasons.push("dev_concentrated");
  if (info.bundlerTraderPct > c.maxBundlerTraderPct) reasons.push("bundler_high");
  if (info.kolWallets + info.smartWallets < c.minKolPlusSmart) reasons.push("no_kol_or_smart_money");
  if (Math.max(row.imageDup, info.imageDupCount) > c.maxImageDup) reasons.push("image_copycat");
  if (row.twitterDup > c.maxTwitterDup) reasons.push("twitter_copycat");
  if (row.websiteDup > c.maxWebsiteDup) reasons.push("website_copycat");
  return reasons;
}
