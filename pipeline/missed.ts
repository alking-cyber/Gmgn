/**
 * npm run pipeline:missed -- --profile early
 *
 * Which tokens that ran in the last 24 hours did the bot miss, and why? Lists graduated tokens
 * now worth MISSED_MIN_MCAP or more (default $100K, launched in the last 24h), then for each one:
 *   - seen by the bot: the stage it reached and the rule that turned it down;
 *   - not seen: from its 1-minute candles, when it was inside the scan's market-cap band and how
 *     old it was then, checked against the bot's event log:
 *       too old        it reached the band only after the scan's maximum age
 *       skipped band   it never closed a minute inside the band (launched above it, or jumped past)
 *       bot silent     it was in the band while the bot logged nothing (off, or banned)
 *       not listed     it was in the band, young enough, while the bot was running: the scan did
 *                      not return it (row cap, or the API) — a coverage bug to fix
 * Runs slowly on purpose (two kline calls per token) so the pm2 jobs are not banned.
 */

import { join } from "node:path";
import { cfg } from "./config.js";
import { GmgnApi, type RankRow } from "./gmgn.js";
import { now, readJsonl } from "./store.js";

if (!process.env.KLINE_MIN_GAP_MS) process.env.KLINE_MIN_GAP_MS = "2500";
const MIN_MCAP = Number(process.env.MISSED_MIN_MCAP) || 100_000;
const SILENT_SEC = 180;

type Ev = { t: number; type: string; address: string; symbol: string; reasons?: string[] };
const events = readJsonl<Ev>(join(cfg.dataDir, "events.jsonl"));
const times = events.map((e) => e.t).sort((a, b) => a - b);
const STAGE: Record<string, number> = { s1_reject: 1, s1_pass: 2, s2_fail: 3, s2_pass: 4, s3_fail: 5, alert: 6 };
const NAME = ["", "stage 1", "tracking", "stage 2", "deep dive", "stage 3", "ALERT"];
const last = new Map<string, Ev>();
for (const e of events) {
  const st = STAGE[e.type];
  if (!st) continue;
  const b = last.get(e.address);
  if (!b || st >= STAGE[b.type]) last.set(e.address, e);
}
/** The bot logged something within SILENT_SEC of every minute of [a, b]. */
function running(a: number, b: number): boolean {
  if (!times.length || a < times[0] - SILENT_SEC || b > times[times.length - 1] + SILENT_SEC) return false;
  let i = times.findIndex((t) => t >= a - SILENT_SEC);
  if (i < 0) return false;
  for (let t = a; t <= b; t += 60) {
    while (i + 1 < times.length && times[i + 1] <= t) i++;
    const near = Math.min(Math.abs(times[i] - t), i + 1 < times.length ? Math.abs(times[i + 1] - t) : Infinity);
    if (near > SILENT_SEC) return false;
  }
  return true;
}
const minutes = (s: string) => (s.endsWith("h") ? parseFloat(s) * 60 : s.endsWith("d") ? parseFloat(s) * 1440 : parseFloat(s));

const q = cfg.trenches;
const bandLo = Math.max(q.minMcap, cfg.s1.minMcap || 0);
const bandHi = Math.min(q.maxMcap, cfg.s1.maxMcap || Infinity);
const maxAge = Math.min(minutes(q.maxCreated), cfg.s1.maxAgeMin) * 60;

const api = new GmgnApi(Number(process.env.MISSED_RATE_LIMIT) || 0.8, undefined, 3);
const T = now();
const runners = new Map<string, RankRow>();
for (const platforms of [undefined, ...q.extraPlatforms.map((p) => [p])]) {
  try {
    for (const r of await api.trenches(cfg.chain, { types: ["completed"], limit: 80, filters: { min_marketcap: MIN_MCAP, max_created: "24h" }, platforms })) {
      if (r.price > 0 && r.createdAt > 0) runners.set(r.address, r);
    }
  } catch (err) {
    console.error(`[missed] trenches: ${(err as Error).message}`);
  }
}
const list = [...runners.values()].filter((r) => r.createdAt >= (times[0] ?? T) - 3600).sort((a, b) => a.createdAt - b.createdAt);
console.log(`${runners.size} tokens launched in the last 24h are now worth $${MIN_MCAP / 1000}K+; ${list.length} launched while the bot has data`);
console.log(`scan band $${bandLo / 1000}K-$${bandHi / 1000}K, max age ${maxAge / 60} min; checking each (slow on purpose)...\n`);

const f = (t: number) => new Date(t * 1000).toLocaleString("sv-SE").slice(5, 16);
const counts = new Map<string, number>();
for (const r of list) {
  let verdict: string;
  let detail = "";
  const seen = last.get(r.address);
  if (seen) {
    verdict = seen.type === "alert" ? "ALERT" : "seen, turned down";
    detail = `${NAME[STAGE[seen.type]]}${seen.reasons?.length ? ": " + seen.reasons.join(", ") : ""}`;
  } else {
    try {
      const supply = r.marketCap / r.price;
      const from = r.createdAt - (r.createdAt % 60);
      const K = await api.klines(cfg.chain, r.address, "1m", from, Math.min(T, from + 200 * 60));
      const inBand = K.filter((k) => k.c * supply >= bandLo && k.c * supply <= bandHi);
      const young = inBand.filter((k) => k.t + 60 - r.createdAt <= maxAge);
      if (!inBand.length) {
        verdict = "skipped band";
        detail = K.length ? `first close $${Math.round((K[0].c * supply) / 1000)}K` : "no candles";
      } else if (!young.length) {
        verdict = "too old";
        detail = `in band from age ${Math.round((inBand[0].t + 60 - r.createdAt) / 60)} min`;
      } else {
        const a = young[0].t, b = young[young.length - 1].t + 60;
        detail = `in band ${f(a)}-${f(b).slice(6)} (age ${Math.round((a - r.createdAt) / 60)}-${Math.round((b - r.createdAt) / 60)} min)`;
        verdict = running(a, b) ? "not listed" : "bot silent";
      }
    } catch (err) {
      verdict = "error";
      detail = (err as Error).message.slice(0, 80);
    }
  }
  counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
  console.log(`${f(r.createdAt)}  ${r.symbol.slice(0, 12).padEnd(12)} now $${Math.round(r.marketCap / 1000)}K`.padEnd(42) + `${verdict.padEnd(18)} ${detail}`);
}

console.log(`\nsummary: ${[...counts].map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(`"not listed" is the one to fix (the bot ran but the scan did not return the token); "too old" and "skipped band"`);
console.log(`follow from the profile's rules; "bot silent" means the bot was off or banned at that moment.`);
