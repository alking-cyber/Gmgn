/**
 * Research step 1: wallet discovery (see pipeline/RESEARCH.md).
 *
 *   npx tsx research/wallets.ts            # fetch new runners + their traders, then score
 *   npx tsx research/wallets.ts --score    # only re-aggregate / re-score what is already saved
 *
 * 1. Runners: Solana tokens up to 2 days old whose all-time-high market cap reached RUNNER_ATH
 *    (default $300K), with real liquidity / holders and not flagged as wash trading
 *    (/v1/market/rank 24h and 6h, ordered by volume).
 * 2. For each runner not fetched yet: its top 100 traders by profit and its top 100 smart_degen
 *    traders. Each row gives when the wallet started holding, its average buy price (-> entry
 *    market cap) and GMGN's maker tags for that token (sniper / bundler / dev / rat_trader ...).
 * 3. Early entry = bought with its own money (no transfer in), at least MIN_DELAY_SEC after launch,
 *    at an entry market cap <= 1/3 of the runner's ATH and <= EARLY_MAX_MCAP, and not tagged
 *    sniper / bundler / dev / insider for that token: those edges are speed or inside info.
 * 4. Wallets with early entries in >= MIN_HITS different runners are scored with
 *    /v1/user/wallet_stats (7d and 30d): win rate, realized PnL, tokens traded, hold time.
 *
 * Everything is appended under research/data/ so repeated runs over several days build the
 * day-by-day sample that step 2 (out-of-sample check) needs. Rate: RESEARCH_RATE units/s (1.5).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenApiClient } from "../src/client/OpenApiClient.js";
import { getConfig } from "../src/config.js";
import { Throttle } from "../pipeline/gmgn.js";

const DIR = join(import.meta.dirname, "data");
mkdirSync(DIR, { recursive: true });
const RUNNERS = join(DIR, "runners.jsonl");
const TRADERS = join(DIR, "traders.jsonl");
const STATS = join(DIR, "wallet-stats.jsonl");

const RATE = Number(process.env.RESEARCH_RATE) || 1.5;
const RUNNER_ATH = Number(process.env.RUNNER_ATH) || 300_000;
const EARLY_MAX_MCAP = Number(process.env.EARLY_MAX_MCAP) || 100_000;
const MIN_DELAY_SEC = Number(process.env.MIN_DELAY_SEC) || 15;
const MIN_HITS = Number(process.env.MIN_HITS) || 2;
const STATS_MAX_AGE_SEC = 6 * 3600;
const CHAIN = "sol";
// maker tags that mean the edge is speed or inside information, not something a follower can copy
const BAD_MAKER_TAGS = ["sniper", "bundler", "dev", "dev_team", "creator", "rat_trader", "insider", "transfer_in"];

type Obj = Record<string, unknown>;
const n = (v: unknown): number => {
  const x = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(x) ? x : 0;
};
const unwrap = (v: unknown): unknown => {
  const o = (v && typeof v === "object" ? v : {}) as Obj;
  return "code" in o && "data" in o ? o.data : v;
};
const nowSec = () => Math.floor(Date.now() / 1000);
const readJsonl = <T>(f: string): T[] =>
  existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : [];
const append = (f: string, rows: unknown[]) => rows.length && appendFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

const client = new OpenApiClient(getConfig());
const throttle = new Throttle(RATE, 5);
async function call<T>(weight: number, fn: () => Promise<unknown>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await throttle.take(weight);
    try {
      return unwrap(await fn()) as T;
    } catch (err) {
      const reset = (err as { resetAtUnix?: number }).resetAtUnix;
      const limited = reset != null || /RATE_LIMIT|429/.test(String((err as Error).message));
      if (!limited || attempt >= 3) throw err;
      throttle.pauseUntil(reset ?? nowSec() + 60);
      console.warn(`rate limited, pausing until ${new Date((reset ?? nowSec() + 60) * 1000).toISOString().slice(11, 19)}`);
    }
  }
}

export interface Runner {
  seenAt: number;
  address: string;
  symbol: string;
  launchpad: string;
  createdAt: number;
  supply: number;
  mcap: number;
  ath: number;
  holders: number;
  liquidity: number;
  smart: number;
  kol: number;
}

export interface TraderRow {
  token: string;
  symbol: string;
  wallet: string;
  createdAt: number;
  ath: number;
  startAt: number;
  endAt: number;
  delaySec: number;
  entryMcap: number;
  buyUsd: number;
  profit: number;
  profitX: number; // profit / cost
  buys: number;
  sells: number;
  tags: string[]; // wallet tags (smart_degen, renowned, fomo ...)
  makerTags: string[]; // tags for this token (sniper, bundler ...)
  transferIn: boolean;
  onCurve: boolean;
  fetchedAt: number;
}

async function fetchRunners(): Promise<Runner[]> {
  const out = new Map<string, Runner>();
  for (const interval of ["24h", "6h", "1h"]) {
    const data = await call<Obj>(3, () =>
      client.getTrendingSwaps(CHAIN, interval, {
        limit: 100,
        order_by: "volume",
        direction: "desc",
        max_created: "2880m",
        min_marketcap: 30_000,
        min_holder_count: 300,
        min_liquidity: 10_000,
        filters: ["not_wash_trading"],
      })
    );
    for (const r of (Array.isArray(data.rank) ? data.rank : []) as Obj[]) {
      const ath = Math.max(n(r.history_highest_market_cap), n(r.market_cap));
      const createdAt = n(r.creation_timestamp) || n(r.open_timestamp);
      if (ath < RUNNER_ATH || !createdAt || r.is_wash_trading) continue;
      out.set(String(r.address), {
        seenAt: nowSec(),
        address: String(r.address),
        symbol: String(r.symbol ?? "").slice(0, 32),
        launchpad: String(r.launchpad_platform ?? r.launchpad ?? ""),
        createdAt,
        supply: n(r.total_supply),
        mcap: n(r.market_cap),
        ath,
        holders: n(r.holder_count),
        liquidity: n(r.liquidity),
        smart: n(r.smart_degen_count),
        kol: n(r.renowned_count),
      });
    }
  }
  return [...out.values()];
}

function parseTrader(r: Obj, run: Runner): TraderRow | null {
  const buyAmt = n(r.buy_amount_cur);
  const buyUsd = n(r.buy_volume_cur) || n(r.history_bought_cost);
  const startAt = n(r.start_holding_at);
  if (!r.address || n(r.addr_type) !== 0) return null; // pools / program accounts
  const cost = n(r.total_cost) || buyUsd;
  return {
    token: run.address,
    symbol: run.symbol,
    wallet: String(r.address),
    createdAt: run.createdAt,
    ath: run.ath,
    startAt,
    endAt: n(r.end_holding_at),
    delaySec: startAt ? startAt - run.createdAt : -1,
    entryMcap: buyAmt > 0 ? (buyUsd / buyAmt) * run.supply : 0,
    buyUsd,
    profit: n(r.profit),
    profitX: cost > 0 ? n(r.profit) / cost : 0,
    buys: n(r.buy_tx_count_cur),
    sells: n(r.sell_tx_count_cur),
    tags: Array.isArray(r.tags) ? (r.tags as unknown[]).map(String) : [],
    makerTags: Array.isArray(r.maker_token_tags) ? (r.maker_token_tags as unknown[]).map(String) : [],
    transferIn: r.transfer_in === true || n(r.history_transfer_in_amount) > 0,
    onCurve: r.is_on_curve === true,
    fetchedAt: nowSec(),
  };
}

async function fetchTraders(run: Runner): Promise<TraderRow[]> {
  const rows = new Map<string, TraderRow>();
  for (const extra of <Record<string, string | number>[]>[
    { limit: 100, order_by: "profit", direction: "desc" },
    { limit: 100, order_by: "profit", direction: "desc", tag: "smart_degen" },
  ]) {
    const data = await call<unknown>(5, () => client.getTokenTopTraders(CHAIN, run.address, extra));
    const list = (Array.isArray(data) ? data : Array.isArray((data as Obj)?.list) ? (data as Obj).list : []) as Obj[];
    for (const r of list) {
      const t = parseTrader(r, run);
      if (t) rows.set(t.wallet, t);
    }
  }
  return [...rows.values()];
}

export function isEarly(t: TraderRow): boolean {
  return (
    !t.transferIn &&
    t.buyUsd > 0 &&
    t.entryMcap > 0 &&
    t.delaySec >= MIN_DELAY_SEC &&
    t.entryMcap <= EARLY_MAX_MCAP &&
    t.entryMcap <= t.ath / 3 &&
    !t.makerTags.some((m) => BAD_MAKER_TAGS.includes(m))
  );
}

interface WalletStat {
  wallet: string;
  period: string;
  at: number;
  winrate: number;
  pnl: number; // realized_profit / total_cost
  profit: number;
  tokens: number;
  buys: number;
  avgHoldSec: number;
  gt2x: number;
  lossOver50: number;
  tags: string[];
}

async function fetchStats(wallets: string[], period: string): Promise<WalletStat[]> {
  const out: WalletStat[] = [];
  // wallet_stats accepts several addresses but answers only the first, so one call per wallet
  for (const wallet of wallets) {
    let data: unknown;
    try {
      data = await call<unknown>(3, () => client.getWalletStats(CHAIN, [wallet], period));
    } catch (err) {
      console.warn(`stats ${period} failed for ${wallet}: ${(err as Error).message}`);
      continue;
    }
    const list = (Array.isArray(data) ? data : [data]) as Obj[];
    for (const s of list) {
      if (!s || !s.wallet_address) continue;
      const p = (s.pnl_stat ?? {}) as Obj;
      const c = (s.common ?? {}) as Obj;
      out.push({
        wallet: String(s.wallet_address),
        period,
        at: nowSec(),
        winrate: n(p.winrate),
        pnl: n(s.realized_profit_pnl),
        profit: n(s.realized_profit),
        tokens: n(p.token_num),
        buys: n(s.buy),
        avgHoldSec: n(p.avg_holding_period),
        gt2x: n(p.pnl_2x_5x_num) + n(p.pnl_gt_5x_num),
        lossOver50: n(p.pnl_lt_nd5_num),
        tags: Array.isArray(c.tags) ? (c.tags as unknown[]).map(String) : [],
      });
    }
  }
  return out;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const k = (x: number) => (Math.abs(x) >= 1e6 ? (x / 1e6).toFixed(1) + "M" : Math.abs(x) >= 1e3 ? (x / 1e3).toFixed(0) + "K" : x.toFixed(0));
const pct = (x: number) => (x * 100).toFixed(0) + "%";
const dur = (s: number) => (s >= 86400 ? (s / 86400).toFixed(1) + "d" : s >= 3600 ? (s / 3600).toFixed(1) + "h" : (s / 60).toFixed(0) + "m");

async function main() {
  const scoreOnly = process.argv.includes("--score");
  const known = new Map(readJsonl<Runner>(RUNNERS).map((r) => [r.address, r]));
  const fetched = new Set(readJsonl<TraderRow>(TRADERS).map((t) => t.token));

  if (!scoreOnly) {
    const runners = await fetchRunners();
    const fresh = runners.filter((r) => !known.has(r.address));
    append(RUNNERS, fresh);
    for (const r of fresh) known.set(r.address, r);
    // a runner is fetched once; by 2 days old its early buyers are settled
    const todo = runners.filter((r) => !fetched.has(r.address));
    console.log(`${runners.length} runners (ATH >= $${k(RUNNER_ATH)}), ${todo.length} not fetched yet`);
    for (const [i, r] of todo.entries()) {
      try {
        const rows = await fetchTraders(r);
        append(TRADERS, rows);
        console.log(`[${i + 1}/${todo.length}] ${r.symbol.padEnd(12)} ATH $${k(r.ath)}  ${rows.length} traders, ${rows.filter(isEarly).length} early`);
      } catch (err) {
        console.warn(`[${i + 1}/${todo.length}] ${r.symbol}: ${(err as Error).message}`);
      }
    }
  }

  // aggregate early entries per wallet
  const traders = readJsonl<TraderRow>(TRADERS);
  const byWallet = new Map<string, TraderRow[]>();
  for (const t of traders) {
    if (!isEarly(t)) continue;
    const list = byWallet.get(t.wallet) ?? [];
    if (!list.some((x) => x.token === t.token)) list.push(t);
    byWallet.set(t.wallet, list);
  }
  const candidates = [...byWallet.entries()].filter(([, l]) => l.length >= MIN_HITS);
  console.log(`\n${traders.length} trader rows over ${new Set(traders.map((t) => t.token)).size} runners; ` +
    `${byWallet.size} wallets with an early entry, ${candidates.length} with >= ${MIN_HITS} runners`);

  // score candidates (cached for STATS_MAX_AGE_SEC)
  const cached = new Map<string, WalletStat>();
  for (const s of readJsonl<WalletStat>(STATS)) if (nowSec() - s.at < STATS_MAX_AGE_SEC) cached.set(s.wallet + s.period, s);
  for (const period of ["30d", "7d"]) {
    // 7d only for wallets that made money over 30d
    const need = candidates
      .map(([w]) => w)
      .filter((w) => !cached.has(w + period) && (period === "30d" || (cached.get(w + "30d")?.pnl ?? 0) > 0));
    if (!need.length) continue;
    console.log(`fetching ${period} stats for ${need.length} wallets...`);
    const got = await fetchStats(need, period);
    append(STATS, got);
    for (const s of got) cached.set(s.wallet + s.period, s);
  }

  // coordinated groups: candidates that entered the same runners within CLUSTER_SEC of each other
  const CLUSTER_SEC = 300;
  const peers = (a: TraderRow[], b: TraderRow[]) =>
    a.filter((x) => b.some((y) => y.token === x.token && Math.abs(y.startAt - x.startAt) <= CLUSTER_SEC)).length;
  const clusterSize = new Map<string, number>();
  for (const [w, l] of candidates) {
    clusterSize.set(w, candidates.filter(([v, m]) => v !== w && peers(l, m) >= 2).length);
  }

  const table = candidates.map(([wallet, l]) => {
    const s7 = cached.get(wallet + "7d");
    const s30 = cached.get(wallet + "30d");
    const hold = median(l.map((t) => (t.endAt > t.startAt ? t.endAt - t.startAt : nowSec() - t.startAt)));
    const flags: string[] = [];
    if (s30 && s30.tokens > 1500) flags.push("bot-volume");
    if (s30 && s30.avgHoldSec > 0 && s30.avgHoldSec < 120) flags.push("scalper");
    if (median(l.map((t) => t.delaySec)) < 60) flags.push("fast");
    if (!s30) flags.push("no-stats");
    if ((clusterSize.get(wallet) ?? 0) >= 2) flags.push(`cluster(${clusterSize.get(wallet)})`);
    return { wallet, l, s7, s30, hold, flags };
  });
  // copyable = no bot/no-stats flag, positive 30d PnL on a decent sample
  const score = (r: (typeof table)[number]) =>
    !r.s30 ? -1e9 : r.flags.some((f) => f.startsWith("cluster") || f === "bot-volume") ? -1e6 + r.s30.pnl : r.s30.pnl * Math.min(1, r.s30.tokens / 30) + 0.5 * r.s30.winrate + 0.1 * r.l.length;
  table.sort((a, b) => score(b) - score(a));

  const lines: string[] = [];
  lines.push(`# Step 1 — wallet discovery (${new Date().toISOString().slice(0, 16)}Z)`, "");
  lines.push(`Runners: ${new Set(traders.map((t) => t.token)).size} Solana tokens <= 2 days old with ATH >= $${k(RUNNER_ATH)}.`);
  lines.push(`Early entry: entry mcap <= $${k(EARLY_MAX_MCAP)} and <= ATH/3, >= ${MIN_DELAY_SEC}s after launch, own money, no sniper/bundler/dev/insider tag.`);
  lines.push(`Candidates: ${candidates.length} wallets with early entries in >= ${MIN_HITS} runners.`, "");
  lines.push("| wallet | runners | med entry mcap | med delay | med hold (token) | 7d win | 7d pnl | 30d win | 30d pnl | 30d tokens | 30d avg hold | 30d >=2x | flags | tags |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of table) {
    lines.push(
      `| \`${r.wallet}\` | ${r.l.length} (${r.l.map((t) => t.symbol).join(", ").slice(0, 40)}) | $${k(median(r.l.map((t) => t.entryMcap)))} | ${dur(median(r.l.map((t) => t.delaySec)))} | ${dur(r.hold)} | ` +
        `${r.s7 ? pct(r.s7.winrate) : "-"} | ${r.s7 ? pct(r.s7.pnl) : "-"} | ${r.s30 ? pct(r.s30.winrate) : "-"} | ${r.s30 ? pct(r.s30.pnl) : "-"} | ` +
        `${r.s30?.tokens ?? "-"} | ${r.s30 ? dur(r.s30.avgHoldSec) : "-"} | ${r.s30?.gt2x ?? "-"} | ${r.flags.join(" ")} | ${[...new Set([...(r.s30?.tags ?? []), ...r.l.flatMap((t) => t.tags)])].join(" ")} |`
    );
  }
  writeFileSync(join(DIR, "..", "wallets-step1.md"), lines.join("\n") + "\n");
  console.log(lines.slice(0, 6 + Math.min(40, table.length)).join("\n"));
}

await main();
