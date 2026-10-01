/**
 * npm run pipeline:runners              track continuously (every TRACK_INTERVAL_SEC)
 * npm run pipeline:runners -- --once    one round, then the report
 * npm run pipeline:runners -- --report  report only, no API calls
 *
 * Measures the one number the runner strategy depends on: how often a token that passes the
 * runner gate goes on to $10M. Every launchpad token is looked at once, when it is 60-120 minutes
 * old (picked by age, dead ones included); if it crossed $100K market cap in its first hour it is
 * recorded with the gate result and inputs, and checked again TRACK_DAYS later (highest hourly
 * close with real volume since the cross). Failed tokens are the control group: the gate is only
 * useful if passers become runners more often than failers.
 *
 * Break-even for "sell half at 2x, hold the rest to -30%" was about one $10M runner per 100
 * trades in the replay blend; one per 50 was clearly profitable.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cfg } from "./config.js";
import { GmgnApi, type RankRow } from "./gmgn.js";
import { GATE, peakMcap, runnerGate } from "./gate.js";
import { now } from "./store.js";

const env = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);
const INTERVAL_SEC = env("TRACK_INTERVAL_SEC", 600); // tokens stay in the 60-120 minute window for an hour
const DAYS = env("TRACK_DAYS", 7);
const DIR = process.env.TRACK_DIR || join(dirname(cfg.dataDir), "data-runners");
const FILE = join(DIR, "tracked.json");

interface Tracked {
  symbol: string;
  launchpad: string;
  createdAt: number;
  supply: number;
  status: "pending" | "ignored" | "pass" | "fail"; // "pending" is not stored: tokens are checked after their first hour
  why?: string;
  crossAt?: number;
  crossMcap?: number;
  ageMin?: number;
  volume5m?: number;
  change5m?: number;
  reasons?: string[];
  // outcome, filled TRACK_DAYS after the cross
  peakMcap?: number;
  resolvedAt?: number;
}

const load = (): Record<string, Tracked> => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {});
const save = (db: Record<string, Tracked>) => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(db));
};

// The kline endpoint answers faster calls with a ~30s penalty per call; ~1.2 kline calls/s stays clear of it.
const api = new GmgnApi(env("TRACK_RATE_LIMIT", 3), undefined, 3);

/**
 * Tokens aged 60-120 minutes, picked by age with no market-cap filter, so tokens that crossed $100K
 * and dumped right after are recorded too (a market-cap filter would only see survivors).
 * Bonding-curve tokens that reached $100K have graduated or are close to it.
 */
async function universe(): Promise<RankRow[]> {
  const rows = new Map<string, RankRow>();
  const filters = { min_created: `${GATE.maxCrossAgeMin}m`, max_created: `${GATE.maxCrossAgeMin + 60}m` };
  const types = ["near_completion", "completed"];
  for (const platforms of [undefined, ...cfg.trenches.extraPlatforms.map((p) => [p])]) {
    try {
      for (const r of await api.trenches(cfg.chain, { types, limit: 80, filters, platforms })) rows.set(r.address, r);
    } catch (err) {
      console.error(`[track] trenches ${platforms ?? "default"}: ${(err as Error).message}`);
    }
  }
  return [...rows.values()];
}

async function round(db: Record<string, Tracked>): Promise<void> {
  const t = now();
  // 1. every token seen once, after its first hour is over: was it a $100K cross, and did it pass the gate?
  let added = 0;
  let checked = 0;
  for (const r of await universe()) {
    if (db[r.address]) continue;
    const age = t - r.createdAt;
    if (!(r.price > 0) || !(r.createdAt > 0) || age < GATE.maxCrossAgeMin * 60 || age > (GATE.maxCrossAgeMin + 60) * 60) continue;
    const supply = r.marketCap / r.price;
    const from = r.createdAt - (r.createdAt % 60);
    try {
      const K = await api.klines(cfg.chain, r.address, "1m", from, from + (GATE.maxCrossAgeMin + 1) * 60);
      checked++;
      const g = runnerGate(K, supply, r.createdAt, t);
      db[r.address] = { symbol: r.symbol, launchpad: r.launchpad, createdAt: r.createdAt, supply, ...g, status: g.status };
      if (g.status === "pass" || g.status === "fail") {
        added++;
        console.log(`[track] ${g.status.toUpperCase()} ${r.symbol} (${r.launchpad}) crossed $100K at ${g.ageMin.toFixed(1)}m, ` +
          `5m vol $${Math.round(g.volume5m / 1000)}K, 5m ${g.change5m >= 0 ? "+" : ""}${Math.round(g.change5m * 100)}%` + (g.reasons.length ? ` — ${g.reasons.join(", ")}` : ""));
      }
    } catch (err) {
      console.error(`[track] klines ${r.symbol}: ${(err as Error).message}`);
    }
  }
  // 2. outcomes after TRACK_DAYS
  let resolved = 0;
  for (const [addr, x] of Object.entries(db)) {
    if ((x.status !== "pass" && x.status !== "fail") || x.resolvedAt || !x.crossAt || t - x.crossAt < DAYS * 86400) continue;
    try {
      const H = await api.klines(cfg.chain, addr, "1h", x.crossAt - (x.crossAt % 3600), x.crossAt + DAYS * 86400);
      x.peakMcap = peakMcap(H, x.supply);
      x.resolvedAt = t;
      resolved++;
    } catch (err) {
      console.error(`[track] outcome ${x.symbol}: ${(err as Error).message}`);
    }
  }
  save(db);
  console.log(`[track] ${new Date(t * 1000).toISOString()}: ${checked} tokens checked, ${added} crossed $100K in their first hour, ${resolved} outcomes resolved`);
}

export function report(db: Record<string, Tracked>, t = now()): string {
  const all = Object.values(db).filter((x) => x.status === "pass" || x.status === "fail");
  const line = (label: string, xs: Tracked[]) => {
    const done = xs.filter((x) => x.resolvedAt);
    const m1 = done.filter((x) => (x.peakMcap ?? 0) >= 1e6).length;
    const m10 = done.filter((x) => (x.peakMcap ?? 0) >= 1e7).length;
    const rate = m10 ? `1 in ${Math.round(done.length / m10)}` : done.length ? `0 of ${done.length}` : "-";
    return `${label.padEnd(14)} recorded ${String(xs.length).padStart(5)} | resolved ${String(done.length).padStart(5)} | reached $1M ${String(m1).padStart(4)} | reached $10M ${String(m10).padStart(3)} (${rate})`;
  };
  const pass = all.filter((x) => x.status === "pass");
  const fail = all.filter((x) => x.status === "fail");
  const days = all.length ? (t - Math.min(...all.map((x) => x.crossAt!))) / 86400 : 0;
  return [
    `Runner tracker — tokens that crossed $100K in their first hour, outcome ${DAYS} days later (${days.toFixed(1)} days of data)`,
    line("gate PASS", pass),
    line("gate FAIL", fail),
    "Break-even for 'half at 2x, hold the rest to -30%': about 1 runner ($10M) in 100 gate passers; 1 in 50 is clearly profitable.",
    "Trust it only after a few hundred resolved passers: one runner more or less moves the rate a lot.",
  ].join("\n");
}

const isMain = process.argv[1]?.endsWith("runner-tracker.ts");
if (isMain) {
  const db = load();
  if (process.argv.includes("--report")) {
    console.log(report(db));
  } else if (process.argv.includes("--once")) {
    await round(db);
    console.log("\n" + report(db));
  } else {
    console.log(`tracking every ${INTERVAL_SEC}s into ${FILE}; Ctrl+C to stop`);
    for (;;) {
      await round(db).catch((err) => console.error(`[track] round failed: ${(err as Error).message}`));
      await new Promise((r) => setTimeout(r, INTERVAL_SEC * 1000));
    }
  }
}
