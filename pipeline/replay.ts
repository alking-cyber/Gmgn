/**
 * npm run pipeline:replay
 *
 * Replays the loose profile on tokens launched REPLAY_MIN_AGE_H..REPLAY_MAX_AGE_H hours ago
 * (default 3-10h), picked by age, not by how they turned out — dead tokens are included.
 *
 * Per token, with only data available at each minute:
 *   stage 1  first 1m close inside the S1 market-cap band, age S1_MIN_AGE_MIN..S1_MAX_AGE_MIN
 *   stage 2  one more minute; a >44% price drop (~ a 25% liquidity drop on a curve) fails it
 *   stage 3  optionally >= REPLAY_MIN_SMART smart/KOL wallets holding at that minute
 *            (from their start/end holding times; tags are today's tags)
 *   then     the paper rules (TP / SL / time stop / cost / % of equity / max open) on 1m candles,
 *            walking open → low → high → close so a stop inside a candle counts before a target.
 *
 * Holder counts, top-10, bundler and dev history at the time are not available historically
 * and are not applied. Run it on several different days before trusting a result.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "./config.js";
import { GmgnApi, type Candle } from "./gmgn.js";
import { OpenApiClient } from "../src/client/OpenApiClient.js";
import { getConfig } from "../src/config.js";
import { Throttle } from "./gmgn.js";
import { now } from "./store.js";

const env = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);
const MIN_AGE_H = env("REPLAY_MIN_AGE_H", 3);
const MAX_AGE_H = env("REPLAY_MAX_AGE_H", 10);
const MIN_SMART = env("REPLAY_MIN_SMART", 0);
const { minMcap: LO, maxMcap: HI, minAgeMin, maxAgeMin } = cfg.s1;
const P = cfg.paper;
const COST = P.costPct / 100;
if (!LO || !HI) throw new Error("set S1_MIN_MCAP and S1_MAX_MCAP (or use PIPELINE_PROFILE=loose)");

const t0 = now();
const dir = join(cfg.dataDir, `replay-${new Date(t0 * 1000).toISOString().slice(0, 13)}`);
mkdirSync(join(dir, "k"), { recursive: true });
mkdirSync(join(dir, "h"), { recursive: true });

const api = new GmgnApi(env("HISTORY_RATE_LIMIT", 3), undefined, 5);
const raw = new OpenApiClient(getConfig());
const th = new Throttle(2.4, 3);
type Obj = Record<string, any>;
const unwrap = (d: any) => (d && typeof d === "object" && "code" in d && d.data ? d.data : d);
async function call(w: number, fn: () => Promise<unknown>): Promise<any> {
  for (let i = 0; i < 6; i++) {
    await th.take(w);
    try {
      return unwrap(await fn());
    } catch (e: any) {
      if (e.resetAtUnix) th.pauseUntil(e.resetAtUnix);
      else if (!/RATE_LIMIT/.test(e.message)) return null;
    }
  }
  return null;
}
const cached = async <T>(file: string, fn: () => Promise<T>): Promise<T> => {
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const v = await fn();
  writeFileSync(file, JSON.stringify(v));
  return v;
};

// ------------------------------------------------------------------ sample by age

const uni = await cached(join(dir, "universe.json"), async () => {
  const rows = new Map<string, Obj>();
  for (let a = MIN_AGE_H * 60; a < MAX_AGE_H * 60; a += 120) {
    const d = await call(2, () => raw.getTrenches(cfg.chain, cfg.trenches.types, undefined, 80, { min_created: `${a}m`, max_created: `${a + 120}m` }));
    for (const type of cfg.trenches.types) for (const r of d?.[type] ?? []) rows.set(r.address, r);
  }
  return [...rows.values()].filter((r) => {
    const age = t0 - r.created_timestamp;
    return age >= MIN_AGE_H * 3600 && age <= MAX_AGE_H * 3600 && +r.price > 0;
  });
});
console.log(`sample: ${uni.length} tokens launched ${MIN_AGE_H}-${MAX_AGE_H}h ago (by age, dead ones included)`);

// ------------------------------------------------------------------ candles + holders

const supplyOf = (r: Obj) => +r.market_cap / +r.price;
const inBand = (r: Obj, K: Candle[]) =>
  K.some((k) => k.t - r.created_timestamp <= maxAgeMin * 60 && k.c * supplyOf(r) >= LO && k.c * supplyOf(r) <= HI);
let n = 0;
for (const r of uni) {
  const created = r.created_timestamp as number;
  const kf = join(dir, "k", `${r.address}.json`);
  // first 100 minutes for everyone; the full 4 hours only for tokens that reached the band
  let K = await cached(kf, () => api.klines(cfg.chain, r.address, "1m", created - (created % 60), created - (created % 60) + 6000));
  if (inBand(r, K) && K.length && K[K.length - 1].t < created + 6000 - 120 && !existsSync(kf + ".full")) {
    K = await api.klines(cfg.chain, r.address, "1m", created - (created % 60), Math.min(created + 4 * 3600, t0));
    writeFileSync(kf, JSON.stringify(K));
    writeFileSync(kf + ".full", "");
  }
  if (MIN_SMART && inBand(r, K)) {
    for (const tag of ["smart_degen", "renowned"]) {
      await cached(join(dir, "h", `${r.address}_${tag}.json`), async () =>
        ((await call(5, () => raw.getTokenTopHolders(cfg.chain, r.address, { limit: 100, tag, order_by: "profit", direction: "desc" })))?.list ?? []).map(
          (h: Obj) => [h.start_holding_at || 0, h.end_holding_at || 0]
        )
      );
    }
  }
  if (++n % 50 === 0) console.log(`  ${n}/${uni.length}`);
}

// ------------------------------------------------------------------ replay signals

interface Signal { sym: string; t: number; K: Candle[]; nowMcap: number }
const signals: Signal[] = [];
for (const r of uni) {
  const K: Candle[] = JSON.parse(readFileSync(join(dir, "k", `${r.address}.json`), "utf8"));
  const created = r.created_timestamp as number;
  const sup = supplyOf(r);
  let W: [number, number][] = [];
  if (MIN_SMART) for (const tag of ["smart_degen", "renowned"]) {
    const f = join(dir, "h", `${r.address}_${tag}.json`);
    if (existsSync(f)) W = W.concat(JSON.parse(readFileSync(f, "utf8")));
  }
  for (let i = 0; i + 1 < K.length; i++) {
    const age = K[i].t + 60 - created;
    if (age < minAgeMin * 60) continue;
    if (age > maxAgeMin * 60) break;
    if (K[i].c * sup < LO || K[i].c * sup > HI) continue;
    const peak = Math.max(K[i].c, K[i + 1].c);
    const t2 = K[i + 1].t + 60;
    const smart = W.filter(([s, e]) => s && s <= t2 && (!e || e > t2)).length;
    if (Math.min(K[i].c, K[i + 1].c) >= 0.56 * peak && smart >= MIN_SMART) {
      signals.push({ sym: String(r.symbol), t: t2, K: K.slice(i + 1), nowMcap: +r.market_cap });
    }
    break; // one shot, like the live pipeline
  }
}
signals.sort((a, b) => a.t - b.t);

// ------------------------------------------------------------------ paper rules on 1m candles

function exit(K: Candle[], tp: number, sl: number): { x: number; t: number } | null {
  if (K.length < 2) return null;
  const e = K[0].c, tIn = K[0].t + 60;
  for (const k of K.slice(1)) {
    if (k.t - tIn >= P.maxHoldMin * 60) return { x: k.o / e, t: k.t };
    if (k.o <= e * sl) return { x: k.o / e, t: k.t };
    if (k.l <= e * sl) return { x: sl, t: k.t + 60 };
    if (k.h >= e * tp) return { x: Math.max(tp, k.o / e), t: k.t + 60 };
  }
  const last = K[K.length - 1];
  return { x: last.c / e, t: last.t + 60 };
}

function simulate(tp: number, sl: number) {
  let cash = P.startCapital, peak = cash, mdd = 0, taken = 0, skipped = 0, wins = 0;
  const open: { end: number; size: number; value: number }[] = [];
  for (const s of signals) {
    for (const p of open.filter((p) => p.end <= s.t)) { cash += p.value; open.splice(open.indexOf(p), 1); }
    const r = exit(s.K, tp, sl);
    if (!r) continue;
    if (open.length >= P.maxOpen) { skipped++; continue; }
    const equity = cash + open.reduce((a, p) => a + p.size, 0);
    const size = Math.min(cash, equity * P.positionPct);
    const ret = (r.x * (1 - COST)) / (1 + COST) - 1;
    cash -= size; open.push({ end: r.t, size, value: size * (1 + ret) });
    taken++; if (ret > 0) wins++;
    const eq = cash + open.reduce((a, p) => a + p.size, 0);
    peak = Math.max(peak, eq); mdd = Math.max(mdd, 1 - eq / peak);
  }
  cash += open.reduce((a, p) => a + p.value, 0);
  return { cash, mdd, taken, skipped, wins };
}

const dead = signals.filter((s) => s.nowMcap < 10_000).length;
console.log(`\nsignals: ${signals.length} (${dead} of those tokens are below $10K today); band $${LO / 1000}-${HI / 1000}K` +
  (MIN_SMART ? `, >=${MIN_SMART} smart/KOL holding` : ", no smart-money requirement"));
console.log(`paper: $${P.startCapital} start, ${P.positionPct * 100}% of equity per trade, max ${P.maxOpen} open, cost ${P.costPct}%/side, max hold ${P.maxHoldMin}m\n`);
console.log("TP / SL".padEnd(18) + "taken  skipped  win    final     max drawdown   hit rate vs break-even");
for (const tp of [1.2, 1.25, 1.3, 1.5, 2, 3]) {
  for (const sl of [0.75, 0.7, 0.5]) {
    const r = simulate(tp, sl);
    const hits = signals.filter((s) => { const e = exit(s.K, tp, sl); return e && e.x >= tp; }).length;
    const win = tp * (1 - COST) / (1 + COST) - 1, loss = 1 - sl * (1 - COST) / (1 + COST);
    const mark = tp === P.takeProfit && sl === P.stopLoss ? "  ← current paper setting" : "";
    console.log(
      `+${Math.round((tp - 1) * 100)}% / -${Math.round((1 - sl) * 100)}%`.padEnd(18) +
        `${String(r.taken).padStart(5)}  ${String(r.skipped).padStart(7)}  ${String(r.wins).padStart(3)}  ` +
        `$${r.cash.toFixed(2).padStart(8)}  ${(r.mdd * 100).toFixed(0).padStart(6)}%        ` +
        `${Math.round((hits / Math.max(signals.length, 1)) * 100)}% vs ${Math.round((loss / (win + loss)) * 100)}%${mark}`
    );
  }
}
console.log(`\ncache: ${dir} (rerun is free). One run is one market session — repeat on other days.`);
