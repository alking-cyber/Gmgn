/**
 * npm run pipeline:evaluate
 *
 * Reads data/events.jsonl + data/journal/*.jsonl and reports:
 *   1. the funnel and which rules cut the most tokens at each stage
 *   2. the outcome of every alerted token (peak / final multiple from the journal)
 *   3. which alert-time features separate runners from the rest
 *   4. a simple TP/SL backtest with slippage and fees
 *
 * Slippage and fees here are fixed assumptions (BT_SLIPPAGE_PCT, BT_FEE_PCT),
 * not derived from on-chain fills. Treat the backtest as a relative comparison
 * between exit rules, not a P&L forecast.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "./config.js";
import { readJsonl } from "./store.js";

const envNum = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);
const RUNNER_X = envNum("RUNNER_X", 2); // peak multiple that counts as a runner
const ENTRY_DELAY_SEC = envNum("BT_ENTRY_DELAY_SEC", 30); // reaction time after the alert
const SLIPPAGE_PCT = envNum("BT_SLIPPAGE_PCT", 3); // per side
const FEE_PCT = envNum("BT_FEE_PCT", 1); // per side

type Ev = { t: number; type: string; address: string; symbol: string; reasons?: string[]; [k: string]: unknown };
type Snap = { t: number; price: number; [k: string]: number };

const dir = cfg.dataDir;
const events = readJsonl<Ev>(join(dir, "events.jsonl"));
if (!events.length) {
  console.log(`No events in ${dir}/events.jsonl yet. Run the pipeline first: npm run pipeline`);
  process.exit(0);
}

const hours = (events[events.length - 1].t - events[0].t) / 3600;
console.log(`Data: ${dir} — ${events.length} events over ${hours.toFixed(1)}h\n`);

// ------------------------------------------------------------------ 1. funnel

const byType = (type: string) => events.filter((e) => e.type === type);
const uniq = (evs: Ev[]) => new Set(evs.map((e) => e.address));
const seen = uniq(events.filter((e) => e.type.startsWith("s1_")));
const s1Pass = uniq(byType("s1_pass"));
const s2Pass = uniq(byType("s2_pass"));
const alerts = byType("alert");

const share = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
console.log("=== Funnel ===");
console.log(`seen            ${seen.size}`);
console.log(`passed stage 1  ${s1Pass.size}  (${share(s1Pass.size, seen.size)} of seen)`);
console.log(`passed stage 2  ${s2Pass.size}  (${share(s2Pass.size, s1Pass.size)} of tracked)`);
console.log(`alerts          ${alerts.length}  (${share(alerts.length, seen.size)} of seen)\n`);

function reasonTable(title: string, evs: Ev[]): void {
  // Count each token once, using its last recorded reason set.
  const last = new Map<string, string[]>();
  for (const e of evs) last.set(e.address, e.reasons ?? []);
  const counts = new Map<string, number>();
  for (const rs of last.values()) for (const r of rs) counts.set(r, (counts.get(r) ?? 0) + 1);
  console.log(`${title} (${last.size} tokens; a token can fail several rules)`);
  for (const [r, c] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${r.padEnd(24)} ${String(c).padStart(5)}  ${share(c, last.size)}`);
  }
  console.log();
}
reasonTable("Stage 1 rejections", byType("s1_reject").filter((e) => !s1Pass.has(e.address)));
reasonTable("Stage 2 failures", byType("s2_fail"));
reasonTable("Stage 3 failures", byType("s3_fail"));

// ------------------------------------------------------------------ 2. outcomes

interface Outcome {
  symbol: string;
  address: string;
  snaps: Snap[];
  peakX: number;
  finalX: number;
  minX: number;
  minToPeak: number;
  hoursJournaled: number;
  runner: boolean;
  alert: Ev;
}

const outcomes: Outcome[] = [];
for (const a of alerts) {
  const path = join(dir, "journal", `${a.address}.jsonl`);
  const snaps = existsSync(path) ? readJsonl<Snap>(path).filter((s) => s.price > 0) : [];
  if (snaps.length < 2) continue;
  const p0 = snaps[0].price;
  let peak = snaps[0];
  for (const s of snaps) if (s.price > peak.price) peak = s;
  const peakX = peak.price / p0;
  outcomes.push({
    symbol: a.symbol,
    address: a.address,
    snaps,
    peakX,
    finalX: snaps[snaps.length - 1].price / p0,
    minX: Math.min(...snaps.map((s) => s.price)) / p0,
    minToPeak: (peak.t - snaps[0].t) / 60,
    hoursJournaled: (snaps[snaps.length - 1].t - snaps[0].t) / 3600,
    runner: peakX >= RUNNER_X,
    alert: a,
  });
}

console.log(`=== Alert outcomes (runner = peak ≥ ${RUNNER_X}x from alert price) ===`);
if (!outcomes.length) console.log("No journaled alerts yet.\n");
else {
  console.log("symbol        peak    final   low     t→peak  journaled");
  for (const o of outcomes.sort((a, b) => b.peakX - a.peakX)) {
    console.log(
      `${o.symbol.slice(0, 12).padEnd(12)}  ${o.peakX.toFixed(2).padStart(5)}x  ${o.finalX.toFixed(2).padStart(5)}x  ` +
        `${o.minX.toFixed(2).padStart(5)}x  ${o.minToPeak.toFixed(0).padStart(4)}m   ${o.hoursJournaled.toFixed(1)}h` +
        (o.runner ? "  ← runner" : "")
    );
  }
  const runners = outcomes.filter((o) => o.runner).length;
  console.log(`\n${runners}/${outcomes.length} alerts ran ≥ ${RUNNER_X}x (${share(runners, outcomes.length)})\n`);
}

// ------------------------------------------------------------------ 3. what separates runners

if (outcomes.length >= 4) {
  const features: Record<string, (o: Outcome) => number> = {
    "holder growth % (tracking)": (o) => get(o.alert, "summary", "holderGrowthPct"),
    "buy/sell ratio (tracking)": (o) => Math.min(get(o.alert, "summary", "buySellRatio"), 10),
    "price change % (tracking)": (o) => get(o.alert, "summary", "priceChangePct"),
    "bot rate": (o) => get(o.alert, "info", "botRate"),
    "bundler trader %": (o) => get(o.alert, "info", "bundlerTraderPct"),
    "top10 rate": (o) => get(o.alert, "info", "top10Rate"),
    "smart wallets": (o) => get(o.alert, "info", "smartWallets"),
    "KOL wallets": (o) => get(o.alert, "info", "kolWallets"),
    "rug ratio": (o) => get(o.alert, "row", "rugRatio"),
    "liquidity $": (o) => get(o.alert, "info", "liquidity"),
    "market cap $": (o) => get(o.alert, "info", "marketCap"),
    "holders Δ first 10m": (o) => deltaAfter(o.snaps, "holders", 600),
    "smart Δ first 10m": (o) => deltaAfter(o.snaps, "smartWallets", 600),
  };
  const r = outcomes.filter((o) => o.runner);
  const rest = outcomes.filter((o) => !o.runner);
  console.log(`=== Runners (${r.length}) vs rest (${rest.length}): median at alert time ===`);
  for (const [name, f] of Object.entries(features)) {
    console.log(`  ${name.padEnd(28)} ${fmt(median(r.map(f))).padStart(10)}  vs ${fmt(median(rest.map(f))).padStart(10)}`);
  }
  console.log("  (big gaps are candidate filter rules; small samples mislead — wait for 30+ alerts)\n");
}

// ------------------------------------------------------------------ 4. backtest

if (outcomes.length) {
  console.log(
    `=== Backtest: entry ${ENTRY_DELAY_SEC}s after alert, slippage ${SLIPPAGE_PCT}%/side, fee ${FEE_PCT}%/side ===`
  );
  console.log("TP      SL      trades  win%    avg ret   total ret");
  const cost = (SLIPPAGE_PCT + FEE_PCT) / 100;
  for (const tp of [1.5, 2, 3, 5]) {
    for (const sl of [0.6, 0.75, 0.85]) {
      const rets: number[] = [];
      for (const o of outcomes) {
        const entrySnap = o.snaps.find((s) => s.t >= o.snaps[0].t + ENTRY_DELAY_SEC);
        if (!entrySnap) continue;
        const entry = entrySnap.price * (1 + cost);
        let exit = o.snaps[o.snaps.length - 1].price; // time stop at journal end
        for (const s of o.snaps) {
          if (s.t <= entrySnap.t) continue;
          // Exits fill at the snapshot price that crossed the level, not the level itself.
          if (s.price >= entrySnap.price * tp || s.price <= entrySnap.price * sl) {
            exit = s.price;
            break;
          }
        }
        rets.push((exit * (1 - cost)) / entry - 1);
      }
      if (!rets.length) continue;
      const wins = rets.filter((x) => x > 0).length;
      const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
      console.log(
        `${(tp + "x").padEnd(8)}${(sl + "x").padEnd(8)}${String(rets.length).padEnd(8)}` +
          `${share(wins, rets.length).padEnd(8)}${pcs(avg).padEnd(10)}${pcs(avg * rets.length)}`
      );
    }
  }
  console.log("  (total ret = sum of per-trade returns with equal size per trade)");
}

// ------------------------------------------------------------------ helpers

function get(e: Ev, section: string, key: string): number {
  const v = (e[section] as Record<string, unknown> | undefined)?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : NaN;
}

function deltaAfter(snaps: Snap[], key: string, sec: number): number {
  const later = snaps.find((s) => s.t >= snaps[0].t + sec);
  return later ? later[key] - snaps[0][key] : NaN;
}

function median(xs: number[]): number {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function fmt(x: number): string {
  if (!Number.isFinite(x)) return "-";
  return Math.abs(x) >= 1000 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(3);
}

function pcs(x: number): string {
  return `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
}
