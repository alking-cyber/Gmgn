/**
 * Research step 3: forward signal recorder (see pipeline/RESEARCH.md).
 *
 *   npm run research:record            # runs until stopped (pm2: research-recorder)
 *   npm run research:analyze           # ranks the arms from what was recorded so far
 *
 * Every signal source is an "arm". When an arm fires for a token for the first time, the token's
 * state at that moment is logged (no lookahead). Later the token's candles are fetched once:
 *   - at trigger + 65 min: 1-minute candles for [trigger - 2 min, trigger + 60 min]
 *   - at trigger + 6h05m : 5-minute candles for [trigger, trigger + 6h]
 * A token whose candles are gone by then was purged by GMGN (dead) and is scored as a total loss.
 *
 * Arms
 *   sm1 / sm2 / sm3        1st / 2nd / 3rd distinct smart-money wallet buying it within 15 min (track smartmoney)
 *   kol1 / kol2 / kol3     same for KOL wallets (track kol)
 *   sig<N>                 GMGN market signal type N (price spike, ATH, key level, smart buy, KOL buy, CTO ...)
 *   hot                    token enters the 1h hot-search top 100
 *   wallet                 a wallet from research/wallets-step1.md buys it (WATCH_WALLETS overrides the list)
 *   base_new / base_near / base_done  every launchpad token the trenches list shows (base rates)
 *
 * Rate: RESEARCH_RATE units/s (default 1.5), shared with every gmgn job on this machine via the
 * pipeline's pause file. Data: research/data/rec/ (events.jsonl, candles/<token>.json, state.json).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenApiClient } from "../src/client/OpenApiClient.js";
import { getConfig } from "../src/config.js";
import { sanitizeString } from "../src/sanitize.js";
import { Throttle, sharedPause } from "../pipeline/gmgn.js";

export const DIR = join(import.meta.dirname, "data", "rec");
const CANDLES = join(DIR, "candles");
mkdirSync(CANDLES, { recursive: true });
const CHAIN = "sol";
const RATE = Number(process.env.RESEARCH_RATE) || 1.5;
const FEED_SEC = 15;
const CLUSTER_SEC = 15 * 60;

type Obj = Record<string, unknown>;
const n = (v: unknown): number => {
  const x = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(x) ? x : 0;
};
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const unwrap = (v: unknown): unknown => {
  const o = obj(v);
  return "code" in o && "data" in o ? o.data : v;
};
const list = (v: unknown, key = "list"): Obj[] => {
  const d = unwrap(v);
  if (Array.isArray(d)) return d as Obj[];
  const o = obj(d);
  return (Array.isArray(o[key]) ? o[key] : []) as Obj[];
};
const text = (v: unknown) => sanitizeString(String(v ?? "")).slice(0, 32);
const nowSec = () => Math.floor(Date.now() / 1000);
const ts = () => new Date().toISOString().slice(11, 19);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SKIP_TOKENS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

export interface Ev {
  arm: string;
  token: string;
  symbol: string;
  t: number; // trigger, unix seconds
  mcap: number; // at trigger (0 = unknown, read from candles)
  supply: number;
  createdAt: number; // 0 = unknown
  launchpad: string;
  f: Record<string, number | string | boolean>; // state at trigger
  seenAt?: number; // when the recorder saw it: a live bot could not buy before this
}

interface Job {
  token: string;
  kind: "1h" | "6h";
  due: number;
  from: number;
  to: number;
}

interface State {
  fired: Record<string, number>; // arm|token -> t
  buyers: Record<string, [string, number][]>; // sm|token / kol|token -> [wallet, t]
  txSeen: string[];
  hot: string[];
  jobs: Job[];
  walletCursor: Record<string, number>; // wallet -> last activity timestamp seen
  info: Record<string, { t: number; f: Ev["f"]; createdAt: number; supply: number; mcap: number }>;
}

const STATE = join(DIR, "state.json");
const EVENTS = join(DIR, "events.jsonl");
const state: State = existsSync(STATE)
  ? (JSON.parse(readFileSync(STATE, "utf8")) as State)
  : { fired: {}, buyers: {}, txSeen: [], hot: [], jobs: [], walletCursor: {}, info: {} };
function save() {
  // keep the state small: forget clusters / info older than a day, tx hashes beyond 5000
  const cut = nowSec() - 86400;
  for (const [k, v] of Object.entries(state.buyers)) {
    const keep = v.filter(([, t]) => t > nowSec() - CLUSTER_SEC);
    if (keep.length) state.buyers[k] = keep;
    else delete state.buyers[k];
  }
  for (const [k, v] of Object.entries(state.info)) if (v.t < cut) delete state.info[k];
  for (const [k, v] of Object.entries(state.fired)) if (v < cut - 86400 * 6) delete state.fired[k];
  state.txSeen = state.txSeen.slice(-5000);
  writeFileSync(STATE + ".tmp", JSON.stringify(state));
  renameSync(STATE + ".tmp", STATE);
}

const client = new OpenApiClient(getConfig());
// capacity 2: no bursts, the key is shared with the pm2 jobs
const throttle = new Throttle(RATE, 2);
let calls = 0;
async function call(weight: number, fn: () => Promise<unknown>): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    await throttle.take(weight);
    calls += weight;
    try {
      return await fn();
    } catch (err) {
      const reset = (err as { resetAtUnix?: number }).resetAtUnix;
      const limited = reset != null || /RATE_LIMIT|429/.test(String((err as Error).message));
      if (!limited || attempt >= 2) throw err;
      throttle.pauseUntil(reset ?? nowSec() + 60);
      console.warn(`[${ts()}] rate limited (${String((err as Error).message).slice(0, 120)}), all calls wait until ${new Date((reset ?? nowSec() + 60) * 1000).toISOString().slice(11, 19)}`);
    }
  }
}

// ---------- events ----------

// Busy arms (price spikes, ATHs, every launchpad token) fire hundreds of times an hour; their candles
// would not fit the rate budget. They keep a fixed random half of all tokens (by address hash, the
// same half for every arm, so they share candle jobs). Rare arms keep everything.
const SAMPLE_K = Number(process.env.SAMPLE_K) || 2;
const BUSY = /^(base_|sig(1|3|6|7|8|10|18)$)/;
const MAX_LAG_SEC = 300;
export const sampled = (token: string) => {
  let h = 0;
  for (const ch of token) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % SAMPLE_K === 0;
};

let fresh = 0;
function fire(e: Ev): void {
  const key = `${e.arm}|${e.token}`;
  if (state.fired[key] || SKIP_TOKENS.has(e.token)) return;
  if (nowSec() - e.t > MAX_LAG_SEC) return; // feeds repeat old events (first poll, restarts): not forward
  if (BUSY.test(e.arm) && !sampled(e.token)) return;
  state.fired[key] = e.t;
  e.seenAt = nowSec();
  appendFileSync(EVENTS, JSON.stringify(e) + "\n");
  fresh++;
  // one candle job per token and window; arms that fire close together share it
  for (const [kind, delay, span, pre] of [["1h", 65 * 60, 3600, 120], ["6h", 6 * 3600 + 300, 6 * 3600, 0]] as const) {
    const job = state.jobs.find((j) => j.token === e.token && j.kind === kind && e.t >= j.from && e.t + span <= j.to + 1800);
    if (job) {
      job.to = Math.max(job.to, e.t + span);
      job.due = Math.max(job.due, e.t + delay);
    } else state.jobs.push({ token: e.token, kind, due: e.t + delay, from: e.t - pre, to: e.t + span });
  }
}

/** State of a token right now from /v1/token/info (1 unit), cached 2 min. */
async function tokenState(token: string): Promise<State["info"][string] | null> {
  const c = state.info[token];
  if (c && nowSec() - c.t < 120) return c;
  try {
    const d = obj(unwrap(await call(1, () => client.getTokenInfo(CHAIN, token))));
    const price = obj(d.price);
    const stat = obj(d.stat);
    const tags = obj(d.wallet_tags_stat);
    const dev = obj(d.dev);
    const supply = n(d.circulating_supply) || n(d.total_supply);
    const p = n(price.price);
    const info = {
      t: nowSec(),
      supply,
      mcap: p * supply,
      createdAt: n(d.creation_timestamp) || n(d.open_timestamp),
      f: {
        holders: n(stat.holder_count) || n(d.holder_count),
        liquidity: n(d.liquidity),
        top10: n(stat.top_10_holder_rate),
        devHold: n(stat.dev_team_hold_rate),
        bundler: n(stat.top_bundler_trader_percentage),
        insider: n(stat.top_rat_trader_percentage),
        fresh: n(stat.fresh_wallet_rate),
        smart: n(tags.smart_wallets),
        kol: n(tags.renowned_wallets),
        sniper: n(tags.sniper_wallets),
        vol5m: n(price.volume_5m),
        vol1h: n(price.volume_1h),
        buys1h: n(price.buys_1h),
        sells1h: n(price.sells_1h),
        ch5m: n(price.price_5m) ? p / n(price.price_5m) - 1 : 0,
        ch1h: n(price.price_1h) ? p / n(price.price_1h) - 1 : 0,
        athMcap: n(d.ath_price) * supply,
        twitterRename: n(dev.twitter_rename_count ?? d.twitter_rename_count),
        twitterDel: n(dev.twitter_del_post_token_count ?? d.twitter_del_post_token_count),
        hasTwitter: !!(obj(d.link).twitter_username || d.twitter_username),
        launchpad: text(d.launchpad_platform ?? d.launchpad),
      },
    };
    state.info[token] = info;
    return info;
  } catch (err) {
    console.warn(`[${ts()}] token info ${token}: ${(err as Error).message}`);
    return null;
  }
}

async function fireWithState(arm: string, token: string, symbol: string, t: number, extra: Ev["f"], fallbackMcap: number, supply: number) {
  if (state.fired[`${arm}|${token}`] || SKIP_TOKENS.has(token) || nowSec() - t > MAX_LAG_SEC) return;
  const s = await tokenState(token);
  fire({
    arm,
    token,
    symbol,
    t,
    mcap: fallbackMcap || s?.mcap || 0,
    supply: supply || s?.supply || 0,
    createdAt: s?.createdAt || 0,
    launchpad: String(s?.f.launchpad ?? ""),
    f: { ...(s?.f ?? {}), ...extra },
  });
}

// ---------- sources ----------

async function tradeFeed(kind: "sm" | "kol") {
  const raw = await call(1, () => (kind === "sm" ? client.getSmartMoney(CHAIN, 200) : client.getKol(CHAIN, 200)));
  const rows = list(raw).filter((r) => r.side === "buy" && r.base_address);
  const seen = new Set(state.txSeen);
  for (const r of rows.sort((a, b) => n(a.timestamp) - n(b.timestamp))) {
    const tx = String(r.transaction_hash ?? "") + String(r.maker);
    if (seen.has(tx)) continue;
    seen.add(tx);
    state.txSeen.push(tx);
    const token = String(r.base_address);
    const key = `${kind}|${token}`;
    const b = (state.buyers[key] ??= []);
    if (b.some(([w]) => w === r.maker)) continue;
    b.push([String(r.maker), n(r.timestamp)]);
    const recent = b.filter(([, t]) => t > n(r.timestamp) - CLUSTER_SEC).length;
    if (recent > 3) continue;
    const bt = obj(r.base_token);
    const supply = n(bt.total_supply);
    await fireWithState(`${kind}${recent}`, token, text(bt.symbol), n(r.timestamp), { buyUsd: n(r.amount_usd), makerTags: (obj(r.maker_info).tags as string[] ?? []).join(" ") }, n(r.price_usd) * supply, supply);
  }
}

const SIGNAL_GROUPS = [[1], [6], [7], [8], [10], [11], [12], [13, 19], [20], [2, 3, 4, 5], [17, 18]];
async function signals() {
  const raw = await call(1, () => client.getTokenSignalV2(CHAIN, SIGNAL_GROUPS.map((g) => ({ signal_type: g }))));
  const d = unwrap(raw);
  const rows: Obj[] = Array.isArray(d) ? (d as unknown[]).flatMap((g) => (Array.isArray(g) ? (g as Obj[]) : Array.isArray(obj(g).list) ? (obj(g).list as Obj[]) : [obj(g)])) : list(d);
  for (const s of rows) {
    if (!s.token_address || !s.signal_type) continue;
    const x = obj(s.data);
    const supply = n(x.total_supply);
    fire({
      arm: `sig${n(s.signal_type)}`,
      token: String(s.token_address),
      symbol: text(x.symbol),
      t: n(s.trigger_at),
      mcap: n(s.trigger_mc),
      supply,
      createdAt: n(x.created_timestamp) || n(x.open_timestamp),
      launchpad: text(x.launchpad_platform ?? x.launchpad),
      f: {
        holders: n(x.holder_count),
        liquidity: n(x.liquidity),
        top10: n(x.top_10_holder_rate),
        devHold: Math.max(n(x.dev_team_hold_rate), n(x.creator_balance_rate)),
        bundler: n(x.bundler_trader_amount_rate),
        insider: n(x.rat_trader_amount_rate),
        smart: n(x.smart_degen_count),
        kol: n(x.renowned_count),
        vol1h: n(x.volume_1h),
        buys1h: n(x.buys_1h),
        sells1h: n(x.sells_1h),
        athMcap: n(s.ath),
        twitterRename: n(x.twitter_rename_count),
        twitterDel: n(x.twitter_del_post_token_count),
        hasTwitter: !!x.twitter,
        signalTimes: n(s.signal_times),
        visits: n(x.visiting_count),
        imageDup: n(x.image_dup),
        wash: !!x.is_wash_trading,
      },
    });
  }
}

async function hot() {
  const raw = await call(3, () => client.getHotSearches([{ interval: "1h", chain: CHAIN, limit: 100 }]));
  const d = unwrap(raw);
  const groups = (Array.isArray(d) ? d : [d]) as Obj[];
  const tokens = groups.flatMap((g) => (Array.isArray(g.tokens) ? (g.tokens as Obj[]) : []));
  const prev = new Set(state.hot);
  const first = state.hot.length === 0;
  for (const [rank, r] of tokens.entries()) {
    const token = String(r.address);
    if (first || prev.has(token)) continue; // only entries into the list are signals
    fire({
      arm: "hot",
      token,
      symbol: text(r.symbol),
      t: nowSec(),
      mcap: n(r.market_cap),
      supply: n(r.total_supply),
      createdAt: n(r.creation_timestamp) || n(r.open_timestamp),
      launchpad: text(r.launchpad_platform ?? r.launchpad),
      f: {
        rank,
        holders: n(r.holder_count),
        liquidity: n(r.liquidity),
        top10: n(r.top_10_holder_rate),
        smart: n(r.smart_degen_count),
        kol: n(r.renowned_count),
        vol1h: n(r.volume),
        ch1h: n(r.price_change_percent1h) / 100,
        ch5m: n(r.price_change_percent5m) / 100,
        athMcap: n(r.history_highest_market_cap),
        visits: n(r.visiting_count),
      },
    });
  }
  state.hot = tokens.map((r) => String(r.address));
}

async function trenches() {
  const raw = await call(2, () => client.getTrenches(CHAIN, ["new_creation", "near_completion", "completed"], undefined, 80, {}));
  const d = obj(unwrap(raw));
  for (const [type, arm] of [["new_creation", "base_new"], ["near_completion", "base_near"], ["completed", "base_done"]]) {
    for (const r of (Array.isArray(d[type]) ? d[type] : []) as Obj[]) {
      if (!r.address) continue;
      const mcap = n(r.usd_market_cap) || n(r.market_cap);
      // fake-mcap curve tokens (no liquidity, a handful of holders) are not tradable
      if (type === "completed" && n(r.liquidity) <= 0) continue;
      fire({
        arm,
        token: String(r.address),
        symbol: text(r.symbol),
        t: nowSec(),
        mcap,
        supply: n(r.total_supply),
        createdAt: n(r.created_timestamp) || n(r.open_timestamp),
        launchpad: text(r.launchpad_platform ?? r.launchpad),
        f: {
          holders: n(r.holder_count),
          liquidity: n(r.liquidity),
          top10: n(r.top_10_holder_rate),
          devHold: Math.max(n(r.dev_team_hold_rate), n(r.creator_balance_rate)),
          bundler: n(r.bundler_trader_amount_rate),
          smart: n(r.smart_degen_count),
          kol: n(r.renowned_count),
          vol24h: n(r.volume_24h),
          twitterRename: n(r.twitter_rename_count),
          twitterDel: n(r.twitter_del_post_token_count),
          hasTwitter: !!r.twitter,
          devTokens: n(r.creator_created_count),
          progress: n(r.progress),
        },
      });
    }
  }
}

function watchWallets(): string[] {
  if (process.env.WATCH_WALLETS) return process.env.WATCH_WALLETS.split(",").map((s) => s.trim()).filter(Boolean);
  const f = join(import.meta.dirname, "wallets-step1.md");
  if (!existsSync(f)) return [];
  // the clean rows of the step-1 table: positive 30d PnL, no flags
  return readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("| `"))
    .map((l) => l.split("|").map((c) => c.trim()))
    .filter((c) => c[13] === "" && parseFloat(c[9]) > 0)
    .map((c) => c[1].replace(/`/g, ""))
    .slice(0, 8);
}
const WALLETS = watchWallets();
let walletIdx = 0;
async function wallets() {
  if (!WALLETS.length) return;
  const w = WALLETS[walletIdx++ % WALLETS.length];
  const raw = await call(3, () => client.getWalletActivity(CHAIN, w, { type: ["buy"], limit: 20 }));
  const rows = list(raw, "activities");
  const last = state.walletCursor[w] ?? 0;
  if (!last) {
    // first look: only remember where we are, past buys are not forward signals
    state.walletCursor[w] = Math.max(nowSec() - 60, ...rows.map((r) => n(r.timestamp)));
    return;
  }
  for (const r of rows.sort((a, b) => n(a.timestamp) - n(b.timestamp))) {
    if (n(r.timestamp) <= last || r.event_type !== "buy") continue;
    const tok = obj(r.token);
    const token = String(tok.address);
    const supply = n(tok.total_supply);
    state.walletCursor[w] = Math.max(state.walletCursor[w], n(r.timestamp));
    await fireWithState("wallet", token, text(tok.symbol), n(r.timestamp), { buyUsd: n(r.cost_usd), wallet: w.slice(0, 6) }, n(r.price_usd) * supply, supply);
  }
}

// ---------- candles ----------

let nextKline = 0;
async function klines(token: string, res: "1m" | "5m", from: number, to: number): Promise<number[][]> {
  const step = res === "1m" ? 60 : 300;
  const out = new Map<number, number[]>();
  for (let a = from; a < to; a += step * 100) {
    const b = Math.min(to, a + step * 100);
    // the kline endpoint punishes calls closer than ~0.8s apart (per IP), whatever the plan rate
    const wait = Math.max(nextKline, n(readStamp())) - Date.now();
    if (wait > 0) await sleep(wait);
    nextKline = Date.now() + KLINE_GAP_MS;
    try {
      writeFileSync(KLINE_FILE, String(Date.now() + Math.min(KLINE_GAP_MS, 900))); // tell the other jobs on this IP
    } catch {
      // local spacing still holds
    }
    const raw = await call(2, () => client.getTokenKline(CHAIN, token, res, a * 1000, b * 1000));
    for (const k of list(raw)) {
      const t0 = n(k.time);
      const t = t0 > 1e11 ? Math.floor(t0 / 1000) : t0;
      if (t >= from && t < to) out.set(t, [t, n(k.open), n(k.high), n(k.low), n(k.close), n(k.volume)]);
    }
  }
  return [...out.values()].sort((x, y) => x[0] - y[0]);
}
const KLINE_GAP_MS = Number(process.env.KLINE_MIN_GAP_MS) || 1000;
const KLINE_FILE = (process.env.GMGN_PAUSE_FILE || join(process.env.TMPDIR || "/tmp", "gmgn-rate-limit-pause")) + "-kline";
const readStamp = () => {
  try {
    return readFileSync(KLINE_FILE, "utf8");
  } catch {
    return "0";
  }
};

export function candleFile(token: string): string {
  if (!/^[A-Za-z0-9]{20,64}$/.test(token)) throw new Error(`odd token address ${token}`);
  return join(CANDLES, `${token}.json`);
}

async function runJobs(budgetMs: number) {
  const until = Date.now() + budgetMs;
  state.jobs.sort((a, b) => a.due - b.due);
  while (state.jobs.length && state.jobs[0].due <= nowSec() && Date.now() < until) {
    const job = state.jobs.shift()!;
    const f = candleFile(job.token);
    const store = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as { m1: number[][]; m5: number[][] }) : { m1: [], m5: [] };
    try {
      const got = await klines(job.token, job.kind === "1h" ? "1m" : "5m", job.from, job.to);
      const key = job.kind === "1h" ? "m1" : "m5";
      const merged = new Map(store[key].map((c) => [c[0], c]));
      for (const c of got) merged.set(c[0], c);
      store[key] = [...merged.values()].sort((x, y) => x[0] - y[0]);
      (store as Obj)[`fetched_${job.kind}_${job.from}`] = got.length; // 0 = purged by then
      writeFileSync(f, JSON.stringify(store));
    } catch (err) {
      console.warn(`[${ts()}] klines ${job.token}: ${(err as Error).message}`);
      if (!/RATE_LIMIT|429/.test(String((err as Error).message))) continue;
      state.jobs.push(job);
      break;
    }
  }
}

// ---------- loop ----------

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1);
    stopping = true;
    save();
    console.log(`\n[${ts()}] stopped, state saved`);
    process.exit(0);
  });
}

async function main() {
  console.log(`[${ts()}] recorder: ${RATE} units/s, watching ${WALLETS.length} wallets, ${state.jobs.length} candle jobs pending`);
  let tick = 0;
  let lastLog = 0;
  for (;;) {
    const started = Date.now();
    const pause = sharedPause() - Date.now();
    if (pause > 0) await sleep(pause);
    const tasks: [string, () => Promise<void>][] = [
      ["smartmoney", () => tradeFeed("sm")],
      ["kol", () => tradeFeed("kol")],
      ["signal", signals],
    ];
    if (tick % 8 === 0) tasks.push(["hot", hot]);
    if (tick % 20 === 0) tasks.push(["trenches", trenches]);
    if (tick % 3 === 0) tasks.push(["wallets", wallets]);
    for (const [name, fn] of tasks) {
      try {
        await fn();
      } catch (err) {
        console.warn(`[${ts()}] ${name}: ${(err as Error).message}`);
      }
    }
    // the rest of the cycle goes to candle jobs
    await runJobs(Math.max(2000, FEED_SEC * 1000 - (Date.now() - started)));
    save();
    tick++;
    if (Date.now() - lastLog > 10 * 60_000) {
      lastLog = Date.now();
      const due = state.jobs.filter((j) => j.due <= nowSec()).length;
      console.log(`[${ts()}] +${fresh} events, ${state.jobs.length} candle jobs (${due} due), ${(calls / 600).toFixed(2)} units/s`);
      fresh = 0;
      calls = 0;
    }
    const wait = FEED_SEC * 1000 - (Date.now() - started);
    if (wait > 0) await sleep(wait);
  }
}

await main();
