/**
 * npm run pipeline:history
 *
 * Historical backtest of the exit strategies over tokens launched in the last
 * HISTORY_DAYS (default 14) days, using 5m candles from GMGN.
 *
 * GMGN has no historical trending lists or historical holder / bot / bundler
 * data, so the stage 1–3 filters CANNOT be replayed here. Instead each token
 * gets a price/volume "entry signal" as a stand-in for an alert:
 *   the first 5m candle in the token's first 24h where the token is at least
 *   ENTRY_MIN_AGE_MIN old, market cap ≥ ENTRY_MIN_MCAP, candle volume ≥
 *   ENTRY_MIN_VOL_USD, and price is up over the last 3 candles.
 *
 * Known biases — read before trusting the numbers:
 *   - Survivorship: the universe comes from today's rank lists, so tokens that
 *     already died and stopped trading are under-represented. Results skew UP.
 *   - No filters: tokens the pipeline would have rejected (bundled, botted,
 *     copycats) are included. Results can skew DOWN versus real alerts.
 *   - Inside a 5m candle the order of high and low is unknown; the path is
 *     assumed open → low → high → close, so stops trigger before targets.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "./config.js";
import { GmgnApi, type Candle, type RankRow } from "./gmgn.js";
import { STRATEGIES, runExit } from "./strategies.js";
import { now } from "./store.js";

const env = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);
const DAYS = env("HISTORY_DAYS", 14);
const MIN_AGE_MIN = env("ENTRY_MIN_AGE_MIN", 10);
const MIN_MCAP = env("ENTRY_MIN_MCAP", 40_000);
const MIN_VOL = env("ENTRY_MIN_VOL_USD", 10_000);
const HOLD_HOURS = env("HISTORY_HOLD_HOURS", 6);
const MAX_TOKENS = env("HISTORY_MAX_TOKENS", 400);
const COST = (env("BT_SLIPPAGE_PCT", 0.5) + env("BT_FEE_PCT", 1)) / 100;
const CANDLE = 300;

// Slower than the live pipeline: GMGN also limits per IP, and cloud IPs are often shared.
const rate = env("HISTORY_RATE_LIMIT", 3);
const api = new GmgnApi(rate, undefined, 5);
const cacheDir = join(cfg.dataDir, "history");
mkdirSync(cacheDir, { recursive: true });
const t0 = now();

// ------------------------------------------------------------------ universe

const universe = new Map<string, RankRow>();
const sorts: Record<string, string | number>[] = [
  {},
  { order_by: "volume" },
  { order_by: "marketcap" },
  { order_by: "holder_count" },
  { order_by: "swaps" },
  { order_by: "creation_timestamp" },
  { order_by: "change1h", direction: "desc" },
  { order_by: "change1h", direction: "asc" },
];
for (const interval of ["1h", "6h", "24h"]) {
  for (const s of sorts) {
    try {
      for (const r of await api.rank(cfg.chain, interval, 100, `${DAYS}d`, s)) {
        const age = t0 - r.createdAt;
        // Need the token's first day plus the holding window to be in the past.
        if (age <= DAYS * 86400 && age >= (HOLD_HOURS + 1) * 3600 && r.price > 0) universe.set(r.address, r);
      }
    } catch (err) {
      console.error(`rank ${interval} ${JSON.stringify(s)} failed: ${(err as Error).message}`);
    }
  }
}
const tokens = [...universe.values()].slice(0, MAX_TOKENS);
console.log(`universe: ${universe.size} tokens launched in the last ${DAYS}d (using ${tokens.length})`);

// ------------------------------------------------------------------ candles + entry signal

interface Trade {
  symbol: string;
  address: string;
  entryT: number;
  entryMcap: number;
  path0: number[]; // entry at signal candle close
  path1: number[]; // entry one candle later (reaction delay)
  peakX: number;
  lowX: number;
}

const trades: Trade[] = [];
let noSignal = 0;
let failed = 0;
for (const [i, r] of tokens.entries()) {
  const from = r.createdAt - (r.createdAt % CANDLE);
  const to = Math.min(from + (24 + HOLD_HOURS) * 3600 + CANDLE, t0);
  const cache = join(cacheDir, `${r.address}.json`);
  let candles: Candle[];
  try {
    candles = existsSync(cache) ? JSON.parse(readFileSync(cache, "utf8")) : await api.klines(cfg.chain, r.address, "5m", from, to);
    if (!existsSync(cache)) writeFileSync(cache, JSON.stringify(candles));
  } catch (err) {
    failed++;
    console.error(`klines ${r.symbol} failed: ${(err as Error).message}`);
    continue;
  }
  if ((i + 1) % 25 === 0) console.log(`  candles: ${i + 1}/${tokens.length}`);

  const supply = r.marketCap / r.price;
  const holdN = (HOLD_HOURS * 3600) / CANDLE;
  const idx = candles.findIndex(
    (c, j) =>
      j >= 3 &&
      c.t - r.createdAt >= MIN_AGE_MIN * 60 &&
      c.t - r.createdAt <= 24 * 3600 &&
      c.c * supply >= MIN_MCAP &&
      c.volume >= MIN_VOL &&
      c.c > candles[j - 3].c
  );
  if (idx < 0 || idx + 1 + holdN > candles.length) {
    noSignal++;
    continue;
  }
  // Pessimistic intra-candle order: open → low → high → close.
  const expand = (cs: Candle[]) => cs.flatMap((c) => [c.o, c.l, c.h, c.c]);
  const after0 = candles.slice(idx + 1, idx + 1 + holdN);
  const after1 = candles.slice(idx + 2, idx + 2 + holdN);
  const e = candles[idx].c;
  trades.push({
    symbol: r.symbol,
    address: r.address,
    entryT: candles[idx].t,
    entryMcap: e * supply,
    path0: [e, ...expand(after0)],
    path1: [candles[idx + 1].c, ...expand(after1)],
    peakX: Math.max(...after0.map((c) => c.h)) / e,
    lowX: Math.min(...after0.map((c) => c.l)) / e,
  });
}

console.log(
  `\n${trades.length} tokens with an entry signal (${noSignal} without one or too recent, ${failed} failed)\n` +
    `entry signal: age ≥ ${MIN_AGE_MIN}m, mcap ≥ $${MIN_MCAP / 1000}K, 5m volume ≥ $${MIN_VOL / 1000}K, price up over 15m; ` +
    `held ${HOLD_HOURS}h, cost ${(COST * 100).toFixed(1)}%/side\n`
);
if (!trades.length) process.exit(0);

// ------------------------------------------------------------------ how far do they run?

const share = (a: number, b: number) => `${((a / b) * 100).toFixed(0)}%`.padStart(5);
console.log(`=== Peak within ${HOLD_HOURS}h after entry ===`);
for (const x of [1.25, 1.5, 2, 3, 5, 10]) {
  console.log(`  reached ${String(x).padEnd(4)}x   ${share(trades.filter((t) => t.peakX >= x).length, trades.length)}`);
}
const firstHit = (p: number[], up: number, dn: number) => {
  for (const v of p.slice(1)) {
    if (v <= p[0] * dn) return "down";
    if (v >= p[0] * up) return "up";
  }
  return "none";
};
console.log("\n  which comes first?       up first  down first  neither");
for (const [up, dn] of [[1.25, 0.75], [1.5, 0.7], [1.25, 0.88], [2, 0.75]]) {
  const r = trades.map((t) => firstHit(t.path0, up, dn));
  console.log(
    `  +${Math.round((up - 1) * 100)}% vs -${Math.round((1 - dn) * 100)}%`.padEnd(26) +
      `${share(r.filter((x) => x === "up").length, r.length)}     ${share(r.filter((x) => x === "down").length, r.length)}     ${share(r.filter((x) => x === "none").length, r.length)}`
  );
}

// ------------------------------------------------------------------ strategies

const pcs = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
console.log(`\n=== Exit strategies, $100 per token (${trades.length} tokens) ===`);
console.log("strategy".padEnd(42) + "entry at signal".padStart(42) + "entry +5m".padStart(42));
console.log(" ".repeat(42) + "  win%    median     avg     total  excl.top10".padStart(42).repeat(2));
const results: Record<string, unknown> = {};
for (const [name, rule] of Object.entries(STRATEGIES)) {
  let line = name.padEnd(42);
  for (const key of ["path0", "path1"] as const) {
    const rets = trades.map((t) => runExit(t[key], rule, COST));
    const wins = rets.filter((x) => x > 0).length;
    const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
    const total = rets.reduce((a, r) => a + 100 * (1 + r), 0);
    const sorted = [...rets].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    // Average return once the 10 best trades are removed: shows how much a few outliers carry the result.
    const trimmed = sorted.slice(0, Math.max(1, sorted.length - 10));
    const avgTrim = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
    line += `${share(wins, rets.length)} ${pcs(median).padStart(8)} ${pcs(avg).padStart(8)} ${("$" + total.toFixed(0)).padStart(8)} ${pcs(avgTrim).padStart(8)}`.padStart(42);
    results[`${name} | ${key}`] = { wins, median, avg, avgExclTop10: avgTrim, total, n: rets.length };
  }
  console.log(line);
}
console.log(
  `  (invested: $${trades.length * 100} per column; "excl.top10" = average return without the 10 best trades)`
);

writeFileSync(
  join(cfg.dataDir, "history-result.json"),
  JSON.stringify({ at: t0, days: DAYS, trades: trades.map(({ path0, path1, ...t }) => t), results }, null, 1)
);
console.log(`\nper-token details: ${join(cfg.dataDir, "history-result.json")}`);
