/**
 * npm run pipeline:backtest                      backtest the early profile over the last 5 days
 * npm run pipeline:backtest -- --days 2          a shorter range
 *
 * Replays the early profile's entry (first $10K cross inside the first hour, 5-minute volume,
 * launched below the level; cfg.gate) and the paper book's exit (stop, trailing stop, fixed target,
 * costs, network fee per transaction; cfg.paper) on 1-minute candles, using only data up to each
 * decision. Tokens are listed by launch hour (default launchpads + stonkfun), not by outcome.
 *
 * The one bias that cannot be removed: GMGN keeps tokens that never graduated ("new_creation")
 * listed for only a few hours. Older hours contain graduated tokens only, which would make the
 * strategy look far better than it is. So the report:
 *   - measures, on the recent hours where ungraduated tokens are still listed, the share of passers
 *     that graduate and the average trade of the ones that do not;
 *   - uses those to weight the graduated trades from all 5 days (the weighted estimate);
 *   - and runs a plain $50 account over the recent complete hours only (no weighting at all).
 * Results are cached in pipeline/data-backtest/, so a rerun only fetches what is missing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cfg } from "./config.js";
import { GATE, runnerGate } from "./gate.js";
import { GmgnApi, type Candle, type RankRow } from "./gmgn.js";
import { simulate } from "./sim.js";
import { now } from "./store.js";

const arg = (name: string, def: number) => {
  const i = process.argv.lastIndexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
};
const DAYS = arg("days", Number(process.env.BACKTEST_DAYS) || 5);
const DIR = process.env.BACKTEST_DIR || join(dirname(cfg.dataDir), "data-backtest");
// slower than the live pipeline on purpose: a long batch job should never trip the per-IP ban
const api = new GmgnApi(Number(process.env.BACKTEST_RATE_LIMIT) || 2, undefined, 6);
const g = { ...GATE, ...cfg.gate };
const P = cfg.paper;
const T = now();
const TYPES = ["new_creation", "near_completion", "completed"] as const;
type Kind = (typeof TYPES)[number];

mkdirSync(join(DIR, "k"), { recursive: true });
const load = <X>(f: string, d: X): X => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d);

// ------------------------------------------------------------------ 1. tokens by launch hour

interface Listed { row: RankRow; kind: Kind }
const uniFile = join(DIR, `universe-${DAYS}d.json`);
let uni: Record<string, Listed> = load(uniFile, {});
if (!Object.keys(uni).length) {
  const rank = (k: Kind) => TYPES.indexOf(k);
  const list = async (h: number, kind: Kind, platforms: string[] | undefined) => {
    const rows = await api.trenches(cfg.chain, { types: [kind], limit: 80, filters: { min_created: `${h * 60}m`, max_created: `${h * 60 + 60}m` }, platforms });
    for (const r of rows) {
      const age = T - r.createdAt;
      if (!(r.price > 0) || age < h * 3600 || age >= (h + 1) * 3600) continue;
      const old = uni[r.address];
      if (!old || rank(kind) > rank(old.kind)) uni[r.address] = { row: r, kind };
    }
  };
  // a skipped hour would silently bias the sample, so failed hours are retried and the run stops if they keep failing
  let failed: [number, Kind, string[] | undefined][] = [];
  for (let h = 1; h < DAYS * 24; h++) {
    for (const platforms of [undefined, ...cfg.trenches.extraPlatforms.map((p) => [p])]) {
      for (const kind of TYPES) {
        try { await list(h, kind, platforms); } catch { failed.push([h, kind, platforms]); }
      }
    }
    if (h % 6 === 0 || h === 1) console.log(`listed ${h}h back: ${Object.keys(uni).length} tokens` + (failed.length ? ` (${failed.length} calls to retry)` : ""));
  }
  for (let round = 1; round <= 3 && failed.length; round++) {
    console.log(`retrying ${failed.length} failed listing calls (round ${round}/3) after a pause...`);
    await new Promise((r) => setTimeout(r, 60_000));
    const again = failed;
    failed = [];
    for (const [h, kind, platforms] of again) {
      try { await list(h, kind, platforms); } catch { failed.push([h, kind, platforms]); }
    }
  }
  if (failed.length) {
    console.error(`\n${failed.length} listing calls still fail: the GMGN API is rate-limiting this key/IP.`);
    console.error(`Stop everything else that uses the same API key (pm2 stop all), wait 5 minutes, then run again.`);
    process.exit(1);
  }
  writeFileSync(uniFile, JSON.stringify(uni));
}
const listed = Object.values(uni);
console.log(`${listed.length} tokens launched 1-${DAYS * 24}h ago`);

// ------------------------------------------------------------------ 2. entry rule + price path

interface Result { status: string; crossAt?: number; crossMcap?: number; path?: Candle[] }
let done = 0;
for (const { row: r } of listed) {
  const f = join(DIR, "k", `${r.address}.json`);
  if (existsSync(f)) continue;
  const supply = r.marketCap / r.price;
  const from = r.createdAt - (r.createdAt % 60);
  try {
    const K = await api.klines(cfg.chain, r.address, "1m", from, from + (g.maxCrossAgeMin + 1) * 60);
    const gate = runnerGate(K, supply, r.createdAt, T, g);
    const out: Result = { status: gate.status };
    if (gate.status === "pass") {
      out.crossAt = gate.crossAt;
      out.crossMcap = gate.crossMcap;
      const m1 = await api.klines(cfg.chain, r.address, "1m", gate.crossAt, Math.min(T, gate.crossAt + 3 * 3600));
      const h1From = gate.crossAt + 3 * 3600 - ((gate.crossAt + 3 * 3600) % 3600);
      const h1 = h1From < T ? await api.klines(cfg.chain, r.address, "1h", h1From, T) : [];
      const last = m1.length ? m1[m1.length - 1].t + 60 : gate.crossAt;
      out.path = [...m1, ...h1.filter((k) => k.t >= last)];
    }
    writeFileSync(f, JSON.stringify(out));
  } catch (err) {
    console.error(`[candles] ${r.symbol}: ${(err as Error).message}`);
  }
  if (++done % 50 === 0) console.log(`checked ${done} of ${listed.length} tokens`);
}

// ------------------------------------------------------------------ 3. the paper book on each passer

interface Trade { symbol: string; kind: Kind; at: number; ageH: number; ret: number; exits: number; endAt: number; why: string; peakX: number }
function trade(path: Candle[], crossMcap: number, supply: number): Omit<Trade, "symbol" | "kind" | "ageH"> | null {
  // already ran away past maxChaseMult x the cross: the pipeline skips it
  const t = simulate(path, P, (cfg.s3.maxChaseMult * crossMcap) / supply);
  return t && { at: t.at, ret: t.ret, exits: 1, endAt: t.endAt, why: t.why, peakX: t.peakX };
}

const trades: Trade[] = [];
let crossed = 0;
const gateCount: Record<string, number> = {};
for (const { row: r, kind } of listed) {
  const x = load<Result | null>(join(DIR, "k", `${r.address}.json`), null);
  if (!x) continue;
  gateCount[x.status] = (gateCount[x.status] ?? 0) + 1;
  if (x.status === "pass" || x.status === "fail") crossed++;
  if (x.status !== "pass" || !x.path) continue;
  const t = trade(x.path, x.crossMcap!, r.marketCap / r.price);
  if (t) trades.push({ symbol: r.symbol, kind, ageH: (T - r.createdAt) / 3600, ...t });
}
trades.sort((a, b) => a.at - b.at);

// ------------------------------------------------------------------ 4. report

const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const pct = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%` : "-");
const graduated = (t: Trade) => t.kind !== "new_creation";
// hours where ungraduated tokens are still listed: the complete part of the sample
const completeH = Math.max(0, ...listed.filter((x) => x.kind === "new_creation").map((x) => (T - x.row.createdAt) / 3600));
const recent = trades.filter((t) => t.ageH <= completeH);
const G = trades.filter(graduated), Grecent = recent.filter(graduated), N = recent.filter((t) => !graduated(t));
const p = recent.length ? Grecent.length / recent.length : NaN;

console.log(`\n=== Backtest: profile ${cfg.profile}, last ${DAYS} days (${new Date(T * 1000).toISOString().slice(0, 16)} UTC) ===`);
console.log(`entry: first $${g.crossMcap / 1000}K cross within ${g.maxCrossAgeMin} min, 5m volume >= $${g.minVolume5m / 1000}K, launched below the level, <= ${cfg.s3.maxChaseMult}x the cross`);
console.log(`exit: stop ${pct(P.stopLoss - 1)}` + (P.trailArm > 0 ? `, trailing ${P.trailPct * 100}% once ${P.trailArm}x` : "") + (P.takeProfit > 0 ? `, target ${P.takeProfit}x` : "") +
  `, max ${Math.round(P.maxHoldMin / 1440)}d, costs ${P.costPct}%/side + $${P.feeUsd}/transaction`);
console.log(`tokens: ${listed.length} listed, ${crossed} crossed $${g.crossMcap / 1000}K in their first hour, gate: ${JSON.stringify(gateCount)}`);
console.log(`ungraduated tokens are listed only up to ${completeH.toFixed(1)}h back; older hours hold graduated tokens only\n`);

console.log(`trades (before network fees):`);
console.log(`  graduated, all ${DAYS} days     n=${String(G.length).padStart(4)}  avg ${pct(avg(G.map((t) => t.ret)))}  (looks good because the losers are missing)`);
console.log(`  recent ${completeH.toFixed(0)}h, graduated    n=${String(Grecent.length).padStart(4)}  avg ${pct(avg(Grecent.map((t) => t.ret)))}`);
console.log(`  recent ${completeH.toFixed(0)}h, not graduated n=${String(N.length).padStart(4)}  avg ${pct(avg(N.map((t) => t.ret)))}`);

// Is the ungraduated listing really complete over those hours? If GMGN drops dead tokens as they age,
// ungraduated passers per hour shrink with age and the graduation share below is overstated.
const bands = [[1, 3], [3, 6], [6, 12], [12, 24], [24, 48], [48, DAYS * 24]].filter(([a]) => a < DAYS * 24);
console.log(`\ncoverage by token age (passers per hour of launches should stay roughly flat if the listing is complete):`);
for (const [a, b] of bands) {
  const ts = trades.filter((t) => t.ageH >= a && t.ageH < b);
  const ng = ts.filter((t) => !graduated(t)).length, gr = ts.length - ng;
  const ul = listed.filter((x) => x.kind === "new_creation" && (T - x.row.createdAt) / 3600 >= a && (T - x.row.createdAt) / 3600 < b).length;
  console.log(`  ${`${a}-${b}h`.padEnd(7)} ungraduated listed ${(ul / (b - a)).toFixed(1).padStart(6)}/h | passers graduated ${(gr / (b - a)).toFixed(1).padStart(5)}/h, not graduated ${(ng / (b - a)).toFixed(1).padStart(5)}/h` +
    (ts.length ? ` | ${Math.round((gr / ts.length) * 100)}% graduated` : ""));
}
const gAvg = avg(Grecent.map((t) => t.ret)), nAvg = avg(N.map((t) => t.ret));
if (Number.isFinite(gAvg) && Number.isFinite(nAvg) && gAvg > nAvg) {
  const be = -nAvg / (gAvg - nAvg);
  console.log(`\nper trade if the true graduation share of passers were (recent averages ${pct(gAvg)} graduated / ${pct(nAvg)} not):`);
  console.log("  " + [0.1, 0.2, 0.3, 0.5, 0.7].map((q) => `${Math.round(q * 100)}% -> ${pct(q * gAvg + (1 - q) * nAvg)}`).join("   "));
  console.log(`  break-even at ${Math.round(be * 100)}% graduating; only a live recording of every crosser measures the true share`);
}

if (N.length >= 5 && G.length >= 5) {
  const est = p * avg(G.map((t) => t.ret)) + (1 - p) * avg(N.map((t) => t.ret));
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = <X>(a: X[]) => a[Math.floor(rnd() * a.length)];
  const bs: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const a = G.map(() => pick(G).ret), b = N.map(() => pick(N).ret);
    bs.push(p * avg(a) + (1 - p) * avg(b));
  }
  bs.sort((x, y) => x - y);
  console.log(`\nWEIGHTED ESTIMATE per trade: ${pct(est)}  (90% range ${pct(bs[50])} .. ${pct(bs[949])})`);
  console.log(`  ${Math.round(p * 100)}% of recent passers graduated; weight = that share for graduated trades, the rest at the not-graduated average`);
  console.log(`  valid only if the coverage table above is flat; if ungraduated passers thin out with age, this share is too high`);
  const fin: number[] = [];
  for (let i = 0; i < 2000; i++) {
    let eq = P.startCapital;
    for (let n = 0; n < 100; n++) {
      const size = eq * P.positionPct;
      if (size < 1) break;
      const r = rnd() < p ? pick(G).ret : pick(N).ret;
      eq += size * r - 2 * P.feeUsd;
    }
    fin.push(eq);
  }
  fin.sort((x, y) => x - y);
  console.log(`  $${P.startCapital} account, ${P.positionPct * 100}% per trade, 100 trades drawn from that mix: median $${fin[1000].toFixed(0)}, ` +
    `ended below $${P.startCapital} in ${Math.round((fin.filter((v) => v < P.startCapital).length / fin.length) * 100)}% of runs`);
} else {
  console.log(`\nNot enough recent trades to weight (need 5+ graduated and 5+ not graduated). Run again later or with more --days.`);
}

// plain account on the complete recent hours, in time order, no weighting
let cash = P.startCapital;
const open: { end: number; value: number; size: number }[] = [];
let taken = 0, wins = 0;
for (const t of recent) {
  for (const o of open.filter((o) => o.end <= t.at)) { cash += o.value; open.splice(open.indexOf(o), 1); }
  if (open.length >= P.maxOpen) continue;
  const size = Math.min(cash - P.feeUsd, (cash + open.reduce((s, o) => s + o.size, 0)) * P.positionPct);
  if (size < 1) continue;
  cash -= size + P.feeUsd;
  open.push({ end: t.endAt, size, value: size * (1 + t.ret) - P.feeUsd });
  taken++;
  if (t.ret > 0) wins++;
}
const final = cash + open.reduce((s, o) => s + o.value, 0);
console.log(`\nPLAIN ACCOUNT over the complete recent ${completeH.toFixed(0)}h (no weighting): ${taken} trades, ${wins} won, $${P.startCapital} -> $${final.toFixed(2)}`);
console.log(`  only ${completeH.toFixed(0)} hours of market: treat it as one sample, not a verdict`);

const byDay = new Map<number, Trade[]>();
for (const t of G) { const d = Math.floor(t.ageH / 24); byDay.set(d, [...(byDay.get(d) ?? []), t]); }
console.log(`\ngraduated trades per day (biased up; compare days with each other, not with zero):`);
for (const [d, ts] of [...byDay].sort((a, b) => a[0] - b[0])) console.log(`  ${d}-${d + 1} days ago: ${ts.length} trades, avg ${pct(avg(ts.map((t) => t.ret)))}, best ${pct(Math.max(...ts.map((t) => t.ret)))}`);

const csv = ["time_utc,symbol,group,age_h,return_pct,exit,peak_x"].concat(
  trades.map((t) => [new Date(t.at * 1000).toISOString().slice(0, 16), JSON.stringify(t.symbol), graduated(t) ? "graduated" : "not_graduated", t.ageH.toFixed(1), (t.ret * 100).toFixed(1), t.why, t.peakX.toFixed(2)].join(","))
);
writeFileSync(join(DIR, "trades.csv"), csv.join("\n"));
console.log(`\nevery simulated trade: ${join(DIR, "trades.csv")}`);
