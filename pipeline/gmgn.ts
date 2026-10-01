/**
 * Thin typed layer over the gmgn-cli OpenApiClient. Field names were checked
 * against live /v1/market/rank, /v1/trenches, /v1/token/info and
 * /v1/market/token_top_holders responses.
 */

import type { Funding } from "./gate.js";
import { OpenApiClient } from "../src/client/OpenApiClient.js";
import { getConfig } from "../src/config.js";
import { sanitizeString } from "../src/sanitize.js";

/** One row of /v1/market/rank, reduced to the fields the pipeline uses. */
export interface RankRow {
  address: string;
  symbol: string;
  name: string;
  price: number;
  marketCap: number;
  liquidity: number;
  volume: number;
  holders: number;
  buys: number;
  sells: number;
  createdAt: number; // unix seconds
  top10Rate: number;
  devHoldRate: number;
  isWashTrading: boolean;
  bundlerRate: number;
  botRate: number;
  insiderRate: number; // rat_trader_amount_rate
  entrapmentRatio: number;
  rugRatio: number;
  imageDup: number; // number of OTHER tokens sharing this image
  twitterDup: number;
  websiteDup: number;
  telegramDup: number;
  smartCount: number;
  kolCount: number;
  launchpad: string;
  sniperHoldRate: number; // top70_sniper_hold_rate
  devTokens: number; // tokens the creator has launched (trenches only; 0 when unknown)
}

/** Deep-dive / journal view of /v1/token/info. */
export interface TokenInfo {
  address: string;
  symbol: string;
  price: number;
  marketCap: number;
  liquidity: number;
  holders: number;
  top10Rate: number;
  devHoldRate: number;
  botRate: number;
  bundlerTraderPct: number;
  entrapmentTraderPct: number;
  insiderTraderPct: number;
  freshWalletRate: number;
  smartWallets: number;
  kolWallets: number;
  whaleWallets: number;
  bundlerWallets: number;
  sniperWallets: number;
  imageDupCount: number;
  buys1m: number;
  sells1m: number;
  buyVolume1m: number;
  sellVolume1m: number;
  volume1m: number;
  volume5m: number;
  supply: number; // circulating supply, to turn per-token prices into market caps
  devTokens: number; // tokens the creator has launched
}

/** One row of /v1/market/token_top_holders. */
export interface Holder {
  address: string;
  pct: number; // share of supply held
  usd: number; // current value held
  avgCost: number; // average buy price per token (0 = received, not bought)
  soldPct: number; // share of its bought amount already sold
  isPool: boolean; // liquidity pool account, not a trader
  // Program account GMGN labels by name (e.g. "DBC Vault", a Meteora bonding-curve vault)
  // that received tokens without buying: platform supply, not a wallet that can dump at will.
  isSystem: boolean;
  name: string;
  tags: string[];
}

export interface TrenchQuery {
  types: string[];
  limit: number;
  filters: Record<string, number | string>;
  platforms?: string[]; // launchpad filter; omitted = the service's default launchpads
}

/** What the pipeline needs from GMGN — swapped for a fake in tests. */
export interface GmgnSource {
  rank(chain: string, interval: string, limit: number, maxCreated: string): Promise<RankRow[]>;
  tokenInfo(chain: string, address: string): Promise<TokenInfo>;
  /** Launchpad tokens (new / near completion / completed). Needed when PIPELINE_SOURCE=trenches. */
  trenches?(chain: string, q: TrenchQuery): Promise<RankRow[]>;
  /** Top holders, optionally only wallets with a tag (smart_degen, renowned). Needed for holder checks. */
  holders?(chain: string, address: string, tag: string, limit: number): Promise<Holder[]>;
  /** 1-minute (or other) candles, unix seconds. Needed for the runner gate. */
  klines?(chain: string, address: string, resolution: string, from: number, to: number): Promise<Candle[]>;
  /** When and from where the token's biggest buyers were funded. Needed for the funding checks. */
  traderFunding?(chain: string, address: string, limit: number): Promise<Funding[]>;
}

const n = (v: unknown): number => {
  const x = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(x) ? x : 0;
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});

// Some responses come back as the bare payload, others still wrapped in {code, data}.
const unwrap = (v: unknown): Obj => {
  const o = obj(v);
  return "code" in o && o.data && typeof o.data === "object" ? obj(o.data) : o;
};

// Token names/symbols are attacker-controlled; neutralize them before they are
// logged, posted to Discord, or read back by an AI agent.
const text = (v: unknown): string => sanitizeString(String(v ?? "")).slice(0, 64);

export function parseRankRow(r: Obj): RankRow {
  return {
    address: String(r.address),
    symbol: text(r.symbol),
    name: text(r.name),
    price: n(r.price),
    marketCap: n(r.market_cap),
    liquidity: n(r.liquidity),
    volume: n(r.volume),
    holders: n(r.holder_count),
    buys: n(r.buys),
    sells: n(r.sells),
    createdAt: n(r.creation_timestamp) || n(r.open_timestamp),
    top10Rate: n(r.top_10_holder_rate),
    devHoldRate: n(r.dev_team_hold_rate),
    isWashTrading: Boolean(r.is_wash_trading),
    bundlerRate: n(r.bundler_rate),
    botRate: n(r.bot_degen_rate),
    insiderRate: n(r.rat_trader_amount_rate),
    entrapmentRatio: n(r.entrapment_ratio),
    rugRatio: n(r.rug_ratio),
    imageDup: n(r.image_dup),
    twitterDup: n(r.twitter_dup),
    websiteDup: n(r.website_dup),
    telegramDup: n(r.telegram_dup),
    smartCount: n(r.smart_degen_count),
    kolCount: n(r.renowned_count),
    launchpad: text(r.launchpad_platform ?? r.launchpad),
    sniperHoldRate: n(r.top70_sniper_hold_rate),
    devTokens: 0,
  };
}

/** Trenches rows carry the same data as rank rows under different names. */
export function parseTrenchRow(r: Obj): RankRow {
  return {
    ...parseRankRow(r),
    volume: n(r.volume_24h),
    buys: n(r.buys_24h),
    sells: n(r.sells_24h),
    createdAt: n(r.created_timestamp) || n(r.open_timestamp),
    devHoldRate: Math.max(n(r.dev_team_hold_rate), n(r.creator_balance_rate)),
    isWashTrading: r.is_wash_trading === true || r.is_wash_trading === 1 || r.is_wash_trading === "1",
    bundlerRate: n(r.bundler_trader_amount_rate),
    insiderRate: Math.max(n(r.rat_trader_amount_rate), n(r.suspected_insider_hold_rate)),
    devTokens: n(r.creator_created_count),
  };
}

export function parseHolder(r: Obj): Holder {
  return {
    address: String(r.address),
    pct: n(r.amount_percentage),
    usd: n(r.usd_value),
    avgCost: n(r.avg_cost),
    soldPct: n(r.sell_amount_percentage),
    isPool: r.addr_type === 2,
    isSystem: r.addr_type !== 2 && !!r.name && !n(r.avg_cost) && !n(r.buy_tx_count_cur),
    name: text(r.name),
    tags: Array.isArray(r.tags) ? (r.tags as unknown[]).map(String) : [],
  };
}

export function parseTokenInfo(d: Obj): TokenInfo {
  const price = obj(d.price);
  const stat = obj(d.stat);
  const tags = obj(d.wallet_tags_stat);
  const p = n(price.price);
  return {
    address: String(d.address),
    symbol: text(d.symbol),
    price: p,
    marketCap: p * n(d.circulating_supply || d.total_supply),
    liquidity: n(d.liquidity),
    holders: n(stat.holder_count) || n(d.holder_count),
    top10Rate: n(stat.top_10_holder_rate),
    devHoldRate: n(stat.dev_team_hold_rate),
    botRate: n(stat.bot_degen_rate),
    bundlerTraderPct: n(stat.top_bundler_trader_percentage),
    entrapmentTraderPct: n(stat.top_entrapment_trader_percentage),
    insiderTraderPct: n(stat.top_rat_trader_percentage),
    freshWalletRate: n(stat.fresh_wallet_rate),
    smartWallets: n(tags.smart_wallets),
    kolWallets: n(tags.renowned_wallets),
    whaleWallets: n(tags.whale_wallets),
    bundlerWallets: n(tags.bundler_wallets),
    sniperWallets: n(tags.sniper_wallets),
    imageDupCount: n(d.image_dup_count),
    buys1m: n(price.buys_1m),
    sells1m: n(price.sells_1m),
    buyVolume1m: n(price.buy_volume_1m),
    sellVolume1m: n(price.sell_volume_1m),
    volume1m: n(price.volume_1m),
    volume5m: n(price.volume_5m),
    supply: n(d.circulating_supply || d.total_supply),
    devTokens: n(stat.creator_created_count),
  };
}

/**
 * Client-side leaky bucket matching GMGN's limiter (Free 5/5, Plus 20/20,
 * Pro 50/50 rate/capacity; /v1/market/rank costs 3, /v1/token/info costs 1).
 * Without it, two back-to-back rank calls on the Free plan (3+3 > 5) trip
 * RATE_LIMIT_EXCEEDED, and repeating that escalates to RATE_LIMIT_BANNED.
 * All calls go through one queue, so the scan and journal loops share it.
 */
export class Throttle {
  private level = 0;
  private last = Date.now();
  private pausedUntil = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly rate: number, private readonly capacity: number) {}

  take(weight: number): Promise<void> {
    const w = Math.min(weight, this.capacity);
    const run = async () => {
      for (;;) {
        const t = Date.now();
        this.level = Math.max(0, this.level - ((t - this.last) / 1000) * this.rate);
        this.last = t;
        if (t < this.pausedUntil) {
          await sleep(this.pausedUntil - t);
          continue;
        }
        if (this.level + w <= this.capacity) {
          this.level += w;
          return;
        }
        await sleep(((this.level + w - this.capacity) / this.rate) * 1000 + 20);
      }
    };
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }

  /** Stop all calls until the server's reset time (after a 429). */
  pauseUntil(unixSec: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, unixSec * 1000 + 1000);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const WEIGHT = { rank: 3, tokenInfo: 1, kline: 2, trenches: 2, holders: 5, traders: 5 };

export interface Candle {
  t: number; // unix seconds, candle open
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number; // USD
}

export class GmgnApi implements GmgnSource {
  private readonly client = new OpenApiClient(getConfig());

  // GMGN_RATE_LIMIT = your plan's rate (Free 5, Plus 20, Pro 50). Run at 80% of it for headroom.
  constructor(
    planRate = Number(process.env.GMGN_RATE_LIMIT) || 5,
    private readonly throttle = new Throttle(planRate * 0.8, planRate),
    // The live pipeline skips a failed rank call (the next scan is 30s away); batch jobs retry.
    private readonly rankRetries = 0
  ) {}

  /** `retries`: how many times to retry after a 429 (the throttle waits out the reset first). */
  private async call<T>(weight: number, fn: () => Promise<T>, retries = 0): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.throttle.take(weight);
      try {
        return await fn();
      } catch (err) {
        const reset = (err as { resetAtUnix?: number }).resetAtUnix;
        const limited = reset != null || /RATE_LIMIT/.test(String((err as Error).message));
        if (reset) this.throttle.pauseUntil(reset);
        else if (limited) this.throttle.pauseUntil(Date.now() / 1000 + 60);
        if (!limited || attempt >= retries) throw err;
      }
    }
  }

  async rank(
    chain: string,
    interval: string,
    limit: number,
    maxCreated: string,
    more: Record<string, string | number> = {}
  ): Promise<RankRow[]> {
    const extra: Record<string, string | number> = { limit, ...more };
    if (maxCreated) extra.max_created = maxCreated;
    const data = unwrap(await this.call(WEIGHT.rank, () => this.client.getTrendingSwaps(chain, interval, extra), this.rankRetries));
    const rows = Array.isArray(data.rank) ? (data.rank as Obj[]) : [];
    return rows.filter((r) => r && r.address).map(parseRankRow);
  }

  async trenches(chain: string, q: TrenchQuery): Promise<RankRow[]> {
    const data = unwrap(
      await this.call(WEIGHT.trenches, () => this.client.getTrenches(chain, q.types, q.platforms, q.limit, q.filters), this.rankRetries)
    );
    const rows: RankRow[] = [];
    for (const type of q.types) {
      const list = Array.isArray(data[type]) ? (data[type] as Obj[]) : [];
      for (const r of list) if (r && r.address) rows.push(parseTrenchRow(r));
    }
    return rows;
  }

  async holders(chain: string, address: string, tag: string, limit: number): Promise<Holder[]> {
    const extra: Record<string, string | number> = { limit };
    if (tag) extra.tag = tag;
    const data = unwrap(await this.call(WEIGHT.holders, () => this.client.getTokenTopHolders(chain, address, extra)));
    return (Array.isArray(data.list) ? (data.list as Obj[]) : []).map(parseHolder);
  }

  async tokenInfo(chain: string, address: string): Promise<TokenInfo> {
    return parseTokenInfo(unwrap(await this.call(WEIGHT.tokenInfo, () => this.client.getTokenInfo(chain, address))));
  }

  /**
   * Candles in [from, to) (unix seconds), oldest first. The API takes milliseconds and
   * returns at most ~100 candles per call, so this converts and pages.
   */
  async traderFunding(chain: string, address: string, limit: number): Promise<Funding[]> {
    const data = unwrap(
      await this.call(WEIGHT.traders, () => this.client.getTokenTopTraders(chain, address, { limit, order_by: "buy_volume_cur", direction: "desc" }), 3)
    );
    const list = Array.isArray(data) ? (data as Obj[]) : Array.isArray(data.list) ? (data.list as Obj[]) : [];
    const out: Funding[] = [];
    for (const h of list) {
      const t = obj(h.native_transfer);
      const at = n(t.timestamp);
      if (at > 0) out.push({ at, from: String(t.from_address ?? ""), exchange: t.name ? String(t.name) : null });
    }
    return out;
  }

  async klines(chain: string, address: string, resolution: string, from: number, to: number): Promise<Candle[]> {
    const stepSec = ({ "1m": 60, "5m": 300, "15m": 900, "1h": 3600 } as Record<string, number>)[resolution];
    if (!stepSec) throw new Error(`unsupported resolution ${resolution}`);
    const out = new Map<number, Candle>();
    for (let a = from; a < to; a += stepSec * 100) {
      const b = Math.min(to, a + stepSec * 100);
      const data = unwrap(await this.call(WEIGHT.kline, () => this.client.getTokenKline(chain, address, resolution, a * 1000, b * 1000), 5));
      const list = Array.isArray(data.list) ? (data.list as Obj[]) : [];
      for (const k of list) {
        const raw = n(k.time);
        const t = raw > 1e11 ? Math.floor(raw / 1000) : raw;
        if (t >= from && t < to) out.set(t, { t, o: n(k.open), h: n(k.high), l: n(k.low), c: n(k.close), volume: n(k.volume) });
      }
    }
    return [...out.values()].sort((x, y) => x.t - y.t);
  }
}
