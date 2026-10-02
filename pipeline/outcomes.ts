/**
 * npm run pipeline:outcomes -- --profile early      outcome of every token the pipeline saw
 * npm run pipeline:outcomes -- --profile early --report   report from the cache only, no API calls
 *
 * The evaluate report only follows alerted tokens. This looks up what happened to every token the
 * pipeline saw, alerted or not, so the filters can be judged against the tokens they turned down:
 *   - entry for an alerted token: the alert time; for a turned-down token: the time it was turned
 *     down (stage 1: the first time it was seen), at the open of the next tradeable 1-minute candle;
 *   - the same exit as the paper book (stop, trailing stop, costs), plus the plain peak and low;
 *   - one row per group: alerted, and each rule that turned tokens down at its last stage.
 * A filter helps only if the tokens it turned down did worse than the ones it let through.
 * Candles come from the API (1m for the first 100 minutes after the entry, one call; then 1h) and are
 * cached per token, so an interrupted run (Ctrl+C) picks up where it stopped. Cached in
 * <data>/outcomes/; a token is fetched again while it is less than TRACK days old.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "./config.js";
import { GmgnApi, type Candle } from "./gmgn.js";
import { range, simulate } from "./sim.js";
import { now, readJsonl } from "./store.js";

const env = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);
const TRACK_DAYS = env("OUTCOME_DAYS", 7);
const REFRESH_SEC = env("OUTCOME_REFRESH_SEC", 3600);
const DIR = join(cfg.dataDir, "outcomes");
const REPORT_ONLY = process.argv.includes("--report");
// gentle by default: the pm2 jobs share the same key and IP
if (!process.env.KLINE_MIN_GAP_MS) process.env.KLINE_MIN_GAP_MS = "2500";

type Ev = { t: number; type: string; address: string; symbol: string; reasons?: string[] };
interface Decision { address: string; symbol: string; at: number; group: string; reasons: string[] }
interface Cached { fetchedAt: number; path: Candle[] }

// ------------------------------------------------------------------ 1. every token and its decision

const events = readJsonl<Ev>(join(cfg.dataDir, "events.jsonl"));
const STAGE: Record<string, number> = { s1_reject: 1, s1_pass: 2, s2_fail: 3, s2_pass: 4, s3_fail: 5, alert: 6 };
const best = new Map<string, { stage: number; e: Ev; firstSeen: number }>();
for (const e of events) {
  const st = STAGE[e.type];
  if (!st || !e.address) continue;
  const b = best.get(e.address);
  if (!b) best.set(e.address, { stage: st, e, firstSeen: e.t });
  else if (st > b.stage || (st === b.stage && st !== 1)) { b.stage = st; b.e = e; } // stage 1: keep the first sighting
}
const decisions: Decision[] = [];
for (const [address, { stage, e, firstSeen }] of best) {
  if (stage === 2 || stage === 4) continue; // still being tracked, no decision yet
  const label = stage === 6 ? "ALERT (bought)" : stage === 1 ? "stage 1" : stage === 3 ? "stage 2" : "stage 3";
  decisions.push({ address, symbol: e.symbol, at: stage === 1 ? firstSeen : e.t, group: label, reasons: e.reasons ?? [] });
}
console.log(`${best.size} tokens seen in ${cfg.dataDir}, ${decisions.length} decided (alerted or turned down)`);

// ------------------------------------------------------------------ 2. price path after each decision

mkdirSync(DIR, { recursive: true });
const T = now();
const fileOf = (a: string) => join(DIR, `${a}.json`);
const load = (a: string): Cached | null => (existsSync(fileOf(a)) ? JSON.parse(readFileSync(fileOf(a), "utf8")) : null);

if (!REPORT_ONLY) {
  const api = new GmgnApi(env("OUTCOME_RATE_LIMIT", 0.8), undefined, 3);
  const todo = decisions.filter((d) => {
    const c = load(d.address);
    if (!c) return true;
    return c.fetchedAt - d.at < TRACK_DAYS * 86400 && T - c.fetchedAt > REFRESH_SEC;
  });
  console.log(`fetching candles for ${todo.length} tokens (cached: ${decisions.length - todo.length}); this runs slowly on purpose`);
  let n = 0;
  const started = Date.now();
  for (const d of todo) {
    try {
      const from = d.at - (d.at % 60);
      const m1End = Math.min(T, from + 100 * 60); // one kline call returns at most 100 candles
      const m1 = await api.klines(cfg.chain, d.address, "1m", from, m1End);
      const h1From = m1End - (m1End % 3600);
      const h1 = m1End < T ? await api.klines(cfg.chain, d.address, "1h", h1From, Math.min(T, d.at + TRACK_DAYS * 86400)) : [];
      const last = m1.length ? m1[m1.length - 1].t + 60 : from;
      // the first candle starts at or after the decision: no price from before it is used
      const path = [...m1.filter((k) => k.t >= d.at), ...h1.filter((k) => k.t >= last)];
      writeFileSync(fileOf(d.address), JSON.stringify({ fetchedAt: T, path } satisfies Cached));
    } catch (err) {
      console.error(`[outcomes] ${d.symbol}: ${(err as Error).message}`);
    }
    if (++n % 5 === 0 || n === todo.length) {
      const left = ((Date.now() - started) / n) * (todo.length - n);
      console.log(`  ${n} of ${todo.length} tokens, about ${Math.ceil(left / 60000)} min left`);
    }
  }
}

// ------------------------------------------------------------------ 3. report

interface Row { d: Decision; ret: number; peakX: number; lowX: number; why: string }
const rows: Row[] = [];
let noData = 0;
for (const d of decisions) {
  const c = load(d.address);
  const t = c && simulate(c.path, cfg.paper);
  const r = c && range(c.path);
  if (!t || !r) { noData++; continue; }
  rows.push({ d, ret: t.ret, peakX: r.peakX, lowX: r.lowX, why: t.why });
}

const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const med = (a: number[]) => { const v = [...a].sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : NaN; };
const pct = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}%` : "-");
const sh = (v: number) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : "-");
const line = (label: string, rs: Row[]) =>
  `${label.padEnd(30)} ${String(rs.length).padStart(4)}  ${sh(rs.filter((r) => r.peakX >= 2).length / rs.length).padStart(5)}  ` +
  `${sh(rs.filter((r) => r.peakX >= 3).length / rs.length).padStart(5)}  ${(med(rs.map((r) => r.peakX)).toFixed(2) + "x").padStart(6)}  ` +
  `${sh(rs.filter((r) => r.ret > 0).length / rs.length).padStart(5)}  ${pct(avg(rs.map((r) => r.ret))).padStart(6)}`;

const P = cfg.paper;
console.log(`\n=== Outcome of every token seen (profile ${cfg.profile}) ===`);
console.log(`entry: next 1m candle after the decision; exit: stop x${P.stopLoss}` + (P.trailArm > 0 ? `, trailing ${P.trailPct * 100}% once ${P.trailArm}x` : "") +
  (P.takeProfit > 0 ? `, target x${P.takeProfit}` : "") + `, costs ${P.costPct}%/side (network fees not included)`);
console.log(`${rows.length} tokens with candles` + (noData ? `, ${noData} without (no trading after the decision, or not fetched yet)` : "") + "\n");
console.log(`${"group".padEnd(30)} ${"n".padStart(4)}  ${"≥2x".padStart(5)}  ${"≥3x".padStart(5)}  ${"peak".padStart(6)}  ${"win".padStart(5)}  ${"trade".padStart(6)}`);
console.log(line("ALL TOKENS SEEN", rows));
console.log(line("ALERT (bought)", rows.filter((r) => r.d.group === "ALERT (bought)")));
console.log(line("turned down", rows.filter((r) => r.d.group !== "ALERT (bought)")));
for (const g of ["stage 1", "stage 2", "stage 3"]) {
  const inG = rows.filter((r) => r.d.group === g);
  if (!inG.length) continue;
  console.log(line(`  ${g} (all)`, inG));
  for (const reason of [...new Set(inG.flatMap((r) => r.d.reasons))].sort()) {
    console.log(line(`    ${reason}`, inG.filter((r) => r.d.reasons.includes(reason))));
  }
}
console.log(`\npeak = median highest price after entry; ≥2x / ≥3x = share that reached it; win / trade = share of winning trades and`);
console.log(`average trade with the paper exit. A rule is worth keeping only if the tokens it turned down did worse than ALERT.`);
console.log(`A token can fail several rules, so the rule rows overlap. Small groups (under 30) mean little.`);

const csv = ["decided_utc,symbol,address,group,reasons,peak_x,low_x,trade_pct,exit"].concat(
  rows.map((r) => [new Date(r.d.at * 1000).toISOString().slice(0, 16), JSON.stringify(r.d.symbol), r.d.address, r.d.group, r.d.reasons.join(" "),
    r.peakX.toFixed(2), r.lowX.toFixed(2), (r.ret * 100).toFixed(1), r.why].join(","))
);
writeFileSync(join(DIR, "..", "outcomes.csv"), csv.join("\n"));
console.log(`\nevery token: ${join(cfg.dataDir, "outcomes.csv")}`);
