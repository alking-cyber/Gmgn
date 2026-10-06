/**
 * npm run research:analyze [-- --min 20 --arm sm2 --by mcap|age|half]
 *
 * Scores every arm the recorder logged. Entry = close of the 1-minute candle that contains
 * trigger + ENTRY_DELAY_SEC (default 30 s: a polling bot cannot buy at the trigger), or the moment
 * the recorder saw the event + 5 s when that was later. From the entry,
 * the path is the 1-minute candles to +1h, then 5-minute candles to +6h when they were fetched.
 * Tokens whose candles were purged before the 1h fetch count as a total loss.
 *
 * Exit rules (inside one candle the stop is assumed to fill first, a pessimistic order):
 *   hold      sell at the end of the horizon
 *   trail3x   stop -30%; from 3x on, sell 30% below the highest high
 *   tp25/12   take +25%, stop -12%    (the best rule on the early bot's 40 alerts)
 *   tp50/25   take +50%, stop -25%
 *   tp100/30  take 2x,  stop -30%
 * Every return is net of COST (default 0.06 round trip: ~1% fee + ~2% slippage per side).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DIR, candleFile, type Ev } from "./recorder.js";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const MIN_N = Number(opt("min", "15"));
const ONLY = opt("arm", "");
const BY = opt("by", "");
const DELAY = Number(process.env.ENTRY_DELAY_SEC) || 30;
const COST = Number(process.env.COST ?? 0.06);

type C = number[]; // [t, o, h, l, c, v]
interface Store {
  m1: C[];
  m5: C[];
  [k: string]: unknown;
}

const events: Ev[] = existsSync(join(DIR, "events.jsonl"))
  ? readFileSync(join(DIR, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Ev)
  : [];
const cache = new Map<string, Store | null>();
function candles(token: string): Store | null {
  if (!cache.has(token)) {
    let f: string;
    try {
      f = candleFile(token);
    } catch {
      cache.set(token, null);
      return null;
    }
    cache.set(token, existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Store) : null);
  }
  return cache.get(token)!;
}

interface Result {
  e: Ev;
  purged: boolean;
  horizon: "1h" | "6h";
  entryMcap: number;
  maxUp: number;
  ddBeforeUp30: number; // lowest low before the first +30% (or over the path)
  hit30: boolean;
  hit2x: boolean;
  hit5x: boolean;
  r: Record<string, number>;
}

const RULES: Record<string, { tp?: number; sl?: number; trail?: [number, number] }> = {
  hold: {},
  trail3x: { sl: -0.3, trail: [3, 0.3] },
  "tp25/12": { tp: 0.25, sl: -0.12 },
  "tp50/25": { tp: 0.5, sl: -0.25 },
  "tp100/30": { tp: 1, sl: -0.3 },
};

function simulate(path: C[], entry: number, rule: (typeof RULES)[string]): number {
  let peak = entry;
  for (const [, , h, l, c] of path) {
    const stop = Math.max(
      rule.sl != null ? entry * (1 + rule.sl) : 0,
      rule.trail && peak >= entry * rule.trail[0] ? peak * (1 - rule.trail[1]) : 0
    );
    if (stop > 0 && l <= stop) return Math.min(stop, c > stop ? stop : c) / entry - 1; // gaps fill at the candle's close if below
    if (rule.tp != null && h >= entry * (1 + rule.tp)) return rule.tp;
    peak = Math.max(peak, h);
  }
  return path.length ? path[path.length - 1][4] / entry - 1 : 0;
}

function evaluate(e: Ev): Result | null {
  const s = candles(e.token);
  if (!s) return null; // 1h job not run yet
  const fetched1h = Object.entries(s).find(([k]) => k.startsWith("fetched_1h_") && Number(k.slice(11)) <= e.t && Number(k.slice(11)) + 3600 + 1800 >= e.t);
  if (!fetched1h) return null;
  const at = Math.max(e.t + DELAY, (e.seenAt ?? 0) + 5); // never before the recorder saw it
  const m1 = s.m1.filter((c) => c[0] + 60 > at && c[0] < e.t + 3600);
  const r = Object.fromEntries(Object.keys(RULES).map((k) => [k, -1 - COST]));
  if (!m1.length || m1[0][0] > at + 180) {
    // no trades around the trigger: purged (dead) when nothing at all came back, else untradable
    const purged = !s.m1.length;
    if (!purged) return null;
    return { e, purged, horizon: "1h", entryMcap: e.mcap, maxUp: -1, ddBeforeUp30: -1, hit30: false, hit2x: false, hit5x: false, r };
  }
  const entry = m1[0][4];
  if (!(entry > 0)) return null;
  const m5 = s.m5.filter((c) => c[0] >= e.t + 3600 && c[0] < e.t + 6 * 3600);
  const has6h = Object.keys(s).some((k) => k.startsWith("fetched_6h_") && Math.abs(Number(k.slice(11)) - e.t) < 1800 + 6 * 3600);
  const path = [...m1.slice(1), ...(has6h ? m5 : [])];
  let maxUp = 0;
  let low = 0;
  let dd = 0;
  let up30 = false;
  for (const c of path) {
    low = Math.min(low, c[3] / entry - 1);
    if (!up30) dd = low;
    if (c[2] / entry - 1 >= 0.3) up30 = true;
    maxUp = Math.max(maxUp, c[2] / entry - 1);
  }
  for (const [k, rule] of Object.entries(RULES)) r[k] = simulate(path, entry, rule) - COST;
  const supply = e.supply || (e.mcap && e.f.price ? e.mcap / Number(e.f.price) : 0);
  return {
    e,
    purged: false,
    horizon: has6h ? "6h" : "1h",
    entryMcap: supply ? entry * supply : e.mcap,
    maxUp,
    ddBeforeUp30: dd,
    hit30: maxUp >= 0.3,
    hit2x: maxUp >= 1,
    hit5x: maxUp >= 4,
    r,
  };
}

const results = events.map(evaluate).filter((x): x is Result => !!x);
const pending = events.length - results.length;

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (x: number) => (Number.isFinite(x) ? (x * 100).toFixed(0) + "%" : "-");
const sgn = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%" : "-");

function bucketOf(r: Result): string {
  if (BY === "mcap") {
    const m = r.entryMcap;
    return m < 30e3 ? "<30K" : m < 100e3 ? "30-100K" : m < 300e3 ? "100-300K" : m < 1e6 ? "300K-1M" : ">1M";
  }
  if (BY === "age") {
    if (!r.e.createdAt) return "age?";
    const a = (r.e.t - r.e.createdAt) / 3600;
    return a < 1 ? "<1h" : a < 6 ? "1-6h" : a < 24 ? "6-24h" : ">24h";
  }
  if (BY === "half") {
    const ts = results.map((x) => x.e.t).sort((a, b) => a - b);
    return r.e.t < ts[Math.floor(ts.length / 2)] ? "1st half" : "2nd half";
  }
  return "";
}

const groups = new Map<string, Result[]>();
for (const r of results) {
  if (ONLY && r.e.arm !== ONLY) continue;
  const k = r.e.arm + (BY ? ` ${bucketOf(r)}` : "");
  const g = groups.get(k) ?? [];
  // one result per token per arm (the recorder already fires once, this guards merged files)
  if (!g.some((x) => x.e.token === r.e.token)) g.push(r);
  groups.set(k, g);
}
const base = results.filter((r) => r.e.arm === "base_new");
const baseHit2x = mean(base.map((r) => (r.hit2x ? 1 : 0)));

const span = results.length ? (Math.max(...results.map((r) => r.e.t)) - Math.min(...results.map((r) => r.e.t))) / 3600 : 0;
console.log(`${results.length} scored events over ${span.toFixed(1)}h (${pending} still waiting for candles); entry +${DELAY}s, cost ${pct(COST)} round trip`);
console.log(`base rate (base_new): ${pct(baseHit2x)} reach 2x\n`);
const rules = Object.keys(RULES);
const head = ["arm", "n", "6h", "dead", "+30%", "2x", "5x", "lift2x", "med max", "dd<+30", ...rules.map((k) => k)];
const rows = [...groups.entries()]
  .filter(([, g]) => g.length >= MIN_N)
  .map(([k, g]) => {
    const best = Math.max(...rules.map((x) => mean(g.map((r) => r.r[x]))));
    return { k, g, best };
  })
  .sort((a, b) => b.best - a.best);
const table = rows.map(({ k, g }) => {
  const hit2 = mean(g.map((r) => (r.hit2x ? 1 : 0)));
  return [
    k,
    String(g.length),
    String(g.filter((r) => r.horizon === "6h").length),
    pct(mean(g.map((r) => (r.purged ? 1 : 0)))),
    pct(mean(g.map((r) => (r.hit30 ? 1 : 0)))),
    pct(hit2),
    pct(mean(g.map((r) => (r.hit5x ? 1 : 0)))),
    baseHit2x > 0 ? (hit2 / baseHit2x).toFixed(1) + "x" : "-",
    pct(median(g.map((r) => r.maxUp))),
    pct(median(g.filter((r) => !r.purged).map((r) => r.ddBeforeUp30))),
    ...rules.map((x) => sgn(mean(g.map((r) => r.r[x])))),
  ];
});
const w = head.map((h, i) => Math.max(h.length, ...table.map((r) => r[i].length)));
const line = (r: string[]) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join("  ");
console.log(line(head));
for (const r of table) console.log(line(r));
console.log(`\n(arms with fewer than ${MIN_N} tokens hidden; per-rule columns are the mean net return per trade)`);
