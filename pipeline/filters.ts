/**
 * Pure filter rules for stages 1–3. No I/O here, so the same rules can be
 * replayed over recorded data by evaluate.ts and exercised by selftest.ts.
 *
 * Each rule returns a short machine-readable reason code on failure, so the
 * evaluator can count which rules cut which tokens.
 */

import type { PipelineConfig } from "./config.js";
import type { Holder, RankRow, TokenInfo } from "./gmgn.js";

// ---------------------------------------------------------------- stage 1

/**
 * `narrativeLeader`: whether this token has the most holders among the tokens
 * with the same symbol in this scan (only used when c.copycat is "leader").
 */
export function stage1(row: RankRow, c: PipelineConfig["s1"], nowSec: number, narrativeLeader = true): string[] {
  const reasons: string[] = [];
  const ageMin = (nowSec - row.createdAt) / 60;
  if (!row.createdAt || ageMin < c.minAgeMin) reasons.push("too_young");
  if (ageMin > c.maxAgeMin) reasons.push("too_old");
  if (row.holders < c.minHolders) reasons.push("few_holders");
  if (row.liquidity < c.minLiquidityUsd) reasons.push("low_liquidity");
  if (row.top10Rate > c.maxTop10Rate) reasons.push("top10_concentrated");
  if (row.devHoldRate > c.maxDevHoldRate) reasons.push("dev_concentrated");
  if (row.isWashTrading) reasons.push("wash_trading");
  if (c.minMcap && row.marketCap < c.minMcap) reasons.push("mcap_below_band");
  if (c.maxMcap && row.marketCap > c.maxMcap) reasons.push("mcap_above_band");
  if (row.bundlerRate > c.maxBundlerRate) reasons.push("bundled");
  if (row.sniperHoldRate > c.maxSniperHoldRate) reasons.push("snipers_hold");
  if (row.insiderRate > c.maxInsiderRate) reasons.push("insiders");
  if (row.rugRatio > c.maxRugRatio) reasons.push("rug_ratio_high");
  if (c.maxDevTokens && row.devTokens >= c.maxDevTokens) reasons.push("serial_launcher");
  const shared = row.imageDup + row.twitterDup + row.websiteDup > 0;
  if (c.copycat === "leader" && shared && !narrativeLeader) reasons.push("copycat");
  return reasons;
}

/** Normalized symbol used to group clones of one narrative. */
export const narrativeKey = (row: RankRow) => row.symbol.trim().toLowerCase();

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

/** Holder lists for the stage-3 holder checks; omitted when those checks are off. */
export interface HolderSet {
  smart: Holder[]; // tag smart_degen
  kol: Holder[]; // tag renowned
  top: Holder[]; // by share of supply
}

export const needsHolders = (c: PipelineConfig["s3"]) =>
  c.minHoldingSmart > 0 || c.maxTop20EntryMult > 0 || c.maxSingleHolderPct > 0;

export function stage3(row: RankRow, info: TokenInfo, c: PipelineConfig["s3"], h?: HolderSet): string[] {
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
  if (c.maxDevTokens && info.devTokens >= c.maxDevTokens) reasons.push("serial_launcher");
  if (h && needsHolders(c)) reasons.push(...holderChecks(info, c, h));
  return reasons;
}

/** Entry market cap of a holder: its average buy price times circulating supply. */
export const entryMcap = (x: Holder, supply: number) => x.avgCost * supply;

export function holderSummary(info: TokenInfo, h: HolderSet, minUsd: number) {
  const holding = [...h.smart, ...h.kol].filter((x, i, all) => x.usd > minUsd && all.findIndex((y) => y.address === x.address) === i);
  const traders = h.top.filter((x) => !x.isPool && !x.isSystem);
  const entries = traders
    .slice(0, 20)
    .filter((x) => x.avgCost > 0)
    .map((x) => entryMcap(x, info.supply))
    .sort((a, b) => a - b);
  return {
    smartHolding: holding.length,
    smartHoldingUsd: holding.reduce((a, x) => a + x.usd, 0),
    smartEntryMcaps: holding.filter((x) => x.avgCost > 0).map((x) => entryMcap(x, info.supply)),
    top20EntryMedian: entries.length ? entries[Math.floor(entries.length / 2)] : 0,
    biggestHolder: traders.reduce<Holder | undefined>((a, x) => (!a || x.pct > a.pct ? x : a), undefined),
    // Supply parked in labelled program accounts (vesting / bonding-curve vaults): future supply.
    systemPct: h.top.filter((x) => x.isSystem).reduce((a, x) => a + x.pct, 0),
  };
}

function holderChecks(info: TokenInfo, c: PipelineConfig["s3"], h: HolderSet): string[] {
  const reasons: string[] = [];
  const s = holderSummary(info, h, c.holderMinUsd);
  if (c.minHoldingSmart && s.smartHolding < c.minHoldingSmart) reasons.push("smart_money_not_holding");
  // Median top-20 entry well above today's market cap: the holder base is underwater.
  if (c.maxTop20EntryMult && info.marketCap > 0 && s.top20EntryMedian > c.maxTop20EntryMult * info.marketCap) {
    reasons.push("holders_underwater");
  }
  if (c.maxSingleHolderPct && s.biggestHolder && s.biggestHolder.pct > c.maxSingleHolderPct) reasons.push("whale_holder");
  return reasons;
}
