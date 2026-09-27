/**
 * The four stages:
 *   1. discovery  — poll /v1/market/rank, cut the universe with cheap baseline rules
 *   2. tracking   — watch survivors across scans (holders, liquidity, pressure, bots)
 *   3. deep dive  — one /v1/token/info call: rug, entrapment, KOL/smart money, copycats
 *   4. alert      — notify, then journal a snapshot every 30s for JOURNAL_HOURS
 */

import type { PipelineConfig } from "./config.js";
import { stage1, stage2, stage3, obsFromRow, type TrackState, type TrackSummary } from "./filters.js";
import type { GmgnSource, RankRow, TokenInfo } from "./gmgn.js";
import type { Store } from "./store.js";

type Stage = "s1_rejected" | "tracking" | "s2_failed" | "s3_failed" | "alerted";

interface Seen {
  firstSeen: number;
  symbol: string;
  stage: Stage;
  lastReasons?: string;
}

interface Tracked extends TrackState {
  symbol: string;
  lastRow: RankRow;
  deepDiveErrors: number;
}

interface Journaled {
  symbol: string;
  alertAt: number;
  alertPrice: number;
  until: number;
}

export interface PipelineState {
  seen: Record<string, Seen>;
  tracking: Record<string, Tracked>;
  journaling: Record<string, Journaled>;
  counters: { seen: number; s1Pass: number; s2Pass: number; alerts: number };
}

export const emptyState = (): PipelineState => ({
  seen: {},
  tracking: {},
  journaling: {},
  counters: { seen: 0, s1Pass: 0, s2Pass: 0, alerts: 0 },
});

// Tokens that never got past stage 1 are forgotten after this long, to bound state size.
const FORGET_REJECTED_SEC = 48 * 3600;
const MAX_DEEP_DIVE_ERRORS = 3;

export type Notify = (text: string) => Promise<void>;

export class Pipeline {
  constructor(
    private readonly cfg: PipelineConfig,
    private readonly src: GmgnSource,
    private readonly store: Store,
    private readonly notify: Notify,
    private readonly clock: () => number,
    readonly state: PipelineState = emptyState(),
    private readonly log: (msg: string) => void = console.log
  ) {}

  // ------------------------------------------------------------ stage 1 + 2

  async scan(): Promise<void> {
    const t = this.clock();
    const rows = await this.fetchUniverse();
    if (!rows) return; // every rank call failed; try again next scan

    const { seen, tracking, counters } = this.state;

    for (const row of rows.values()) {
      let s = seen[row.address];
      if (!s) {
        s = seen[row.address] = { firstSeen: t, symbol: row.symbol, stage: "s1_rejected" };
        counters.seen++;
      }
      if (s.stage !== "s1_rejected") continue; // already tracked or decided

      const reasons = stage1(row, this.cfg.s1, t);
      if (reasons.length) {
        const key = reasons.join(",");
        if (s.lastReasons !== key) {
          // Log only when the reason set changes, not every 30s.
          this.store.event("s1_reject", { address: row.address, symbol: row.symbol, reasons, row });
          s.lastReasons = key;
        }
        continue;
      }
      s.stage = "tracking";
      counters.s1Pass++;
      tracking[row.address] = { symbol: row.symbol, startedAt: t, missedScans: 0, obs: [], lastRow: row, deepDiveErrors: 0 };
      this.store.event("s1_pass", { address: row.address, symbol: row.symbol, row });
    }

    for (const [addr, tr] of Object.entries(tracking)) {
      const row = rows.get(addr);
      if (row) {
        tr.missedScans = 0;
        tr.lastRow = row;
        tr.obs.push(obsFromRow(row, t));
      } else {
        tr.missedScans++;
      }
      if (!tr.obs.length) continue;

      const v = stage2(tr, this.cfg.s2, t);
      if (v.status === "wait") continue;
      if (v.status === "fail") {
        this.store.event("s2_fail", { address: addr, symbol: tr.symbol, reasons: v.reasons, obs: tr.obs });
        seen[addr].stage = "s2_failed";
        delete tracking[addr];
        continue;
      }
      await this.deepDive(addr, tr, v.summary);
    }

    this.forgetOld(t);
  }

  private async fetchUniverse(): Promise<Map<string, RankRow> | null> {
    const merged = new Map<string, RankRow>();
    let ok = 0;
    for (const interval of this.cfg.rankIntervals) {
      try {
        const rows = await this.src.rank(this.cfg.chain, interval, this.cfg.rankLimit, this.cfg.rankMaxCreated);
        ok++;
        // First interval listed wins, so its buys/sells window is used consistently.
        for (const r of rows) if (!merged.has(r.address)) merged.set(r.address, r);
      } catch (err) {
        this.log(`[scan] rank ${interval} failed: ${(err as Error).message}`);
      }
    }
    return ok ? merged : null;
  }

  // ------------------------------------------------------------ stage 3 + 4

  private async deepDive(addr: string, tr: Tracked, summary: TrackSummary): Promise<void> {
    const { seen, tracking, counters } = this.state;
    let info: TokenInfo;
    try {
      info = await this.src.tokenInfo(this.cfg.chain, addr);
    } catch (err) {
      // Stay in tracking and retry on the next scan, a few times at most.
      tr.deepDiveErrors++;
      this.log(`[deep-dive] ${tr.symbol} ${addr} failed (${tr.deepDiveErrors}/${MAX_DEEP_DIVE_ERRORS}): ${(err as Error).message}`);
      if (tr.deepDiveErrors >= MAX_DEEP_DIVE_ERRORS) {
        this.store.event("s3_fail", { address: addr, symbol: tr.symbol, reasons: ["deep_dive_error"], summary });
        seen[addr].stage = "s3_failed";
        delete tracking[addr];
      }
      return;
    }

    counters.s2Pass++;
    this.store.event("s2_pass", { address: addr, symbol: tr.symbol, summary, obs: tr.obs });
    delete tracking[addr];

    const reasons = stage3(tr.lastRow, info, this.cfg.s3);
    if (reasons.length) {
      this.store.event("s3_fail", { address: addr, symbol: tr.symbol, reasons, row: tr.lastRow, info });
      seen[addr].stage = "s3_failed";
      return;
    }

    const t = this.clock();
    seen[addr].stage = "alerted";
    counters.alerts++;
    this.state.journaling[addr] = {
      symbol: tr.symbol,
      alertAt: t,
      alertPrice: info.price,
      until: t + this.cfg.journalHours * 3600,
    };
    this.store.event("alert", { address: addr, symbol: tr.symbol, row: tr.lastRow, info, summary });
    this.store.journal(addr, snapshot(t, info));
    await this.notify(formatAlert(this.cfg.chain, addr, tr.lastRow, info, summary)).catch((err) =>
      this.log(`[alert] notify failed: ${(err as Error).message}`)
    );
  }

  async journalTick(): Promise<void> {
    const t = this.clock();
    for (const [addr, j] of Object.entries(this.state.journaling)) {
      if (t >= j.until) {
        this.store.event("journal_done", { address: addr, symbol: j.symbol });
        delete this.state.journaling[addr];
        continue;
      }
      try {
        this.store.journal(addr, snapshot(t, await this.src.tokenInfo(this.cfg.chain, addr)));
      } catch (err) {
        this.log(`[journal] ${j.symbol} ${addr} failed: ${(err as Error).message}`);
      }
    }
  }

  private forgetOld(t: number): void {
    for (const [addr, s] of Object.entries(this.state.seen)) {
      if (s.stage === "s1_rejected" && t - s.firstSeen > FORGET_REJECTED_SEC) delete this.state.seen[addr];
    }
  }

  statusLine(): string {
    const c = this.state.counters;
    return (
      `funnel: ${c.seen} seen → ${c.s1Pass} passed s1 → ${c.s2Pass} passed s2 → ${c.alerts} alerts | ` +
      `tracking ${Object.keys(this.state.tracking).length}, journaling ${Object.keys(this.state.journaling).length}`
    );
  }
}

export function snapshot(t: number, i: TokenInfo): Record<string, number> {
  return {
    t,
    price: i.price,
    marketCap: i.marketCap,
    liquidity: i.liquidity,
    holders: i.holders,
    botRate: i.botRate,
    bundlerTraderPct: i.bundlerTraderPct,
    top10Rate: i.top10Rate,
    smartWallets: i.smartWallets,
    kolWallets: i.kolWallets,
    whaleWallets: i.whaleWallets,
    buys1m: i.buys1m,
    sells1m: i.sells1m,
    buyVolume1m: i.buyVolume1m,
    sellVolume1m: i.sellVolume1m,
    volume1m: i.volume1m,
  };
}

const usd = (v: number) =>
  v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`;
const pc = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

export function formatAlert(chain: string, addr: string, row: RankRow, info: TokenInfo, s: TrackSummary): string {
  return [
    `🔔 **${info.symbol || row.symbol}** passed all 4 stages (${chain})`,
    `\`${addr}\``,
    `MC ${usd(info.marketCap)} · Liq ${usd(info.liquidity)} · Holders ${info.holders}`,
    `Tracked ${s.scans} scans / ${Math.round(s.trackedSec / 60)}m: holders ${pc(s.holderGrowthPct)}, ` +
      `liq ${pc(s.liquidityChangePct)}, price ${pc(s.priceChangePct)}, buy/sell ${s.buySellRatio.toFixed(2)}`,
    `Smart ${info.smartWallets} · KOL ${info.kolWallets} · Bot ${(info.botRate * 100).toFixed(0)}% · ` +
      `Rug ratio ${row.rugRatio.toFixed(2)} · Top10 ${(info.top10Rate * 100).toFixed(0)}%`,
    `https://gmgn.ai/${chain}/token/${addr}`,
  ].join("\n");
}
