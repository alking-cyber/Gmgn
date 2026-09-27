/**
 * The four stages:
 *   1. discovery  — poll /v1/market/rank, cut the universe with cheap baseline rules
 *   2. tracking   — watch survivors across scans (holders, liquidity, pressure, bots)
 *   3. deep dive  — one /v1/token/info call: rug, entrapment, KOL/smart money, copycats
 *   4. alert      — notify, then journal a snapshot every 30s for JOURNAL_HOURS
 */

import type { PipelineConfig } from "./config.js";
import {
  stage1,
  stage2,
  stage3,
  obsFromRow,
  narrativeKey,
  needsHolders,
  holderSummary,
  type HolderSet,
  type TrackState,
  type TrackSummary,
} from "./filters.js";
import type { GmgnSource, RankRow, TokenInfo } from "./gmgn.js";
import type { Store } from "./store.js";
import { Paper, emptyPaper, type PaperClose, type PaperState } from "./paper.js";

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
  paper?: PaperState;
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
  private readonly paper?: Paper;

  constructor(
    private readonly cfg: PipelineConfig,
    private readonly src: GmgnSource,
    private readonly store: Store,
    private readonly notify: Notify,
    private readonly clock: () => number,
    readonly state: PipelineState = emptyState(),
    private readonly log: (msg: string) => void = console.log
  ) {
    if (cfg.paper.enabled) {
      if (cfg.journalHours * 60 < cfg.paper.maxHoldMin) {
        throw new Error("JOURNAL_HOURS must cover PAPER_MAX_HOLD_MIN: paper positions are priced by the journal");
      }
      this.paper = new Paper(cfg.paper, (state.paper ??= emptyPaper(cfg.paper.startCapital)));
    }
  }

  // ------------------------------------------------------------ stage 1 + 2

  async scan(): Promise<void> {
    const t = this.clock();
    const rows = await this.fetchUniverse();
    if (!rows) return; // every rank call failed; try again next scan

    const { seen, tracking, counters } = this.state;

    // The token with the most holders among same-symbol clones is the narrative's leader.
    const leaders = new Map<string, RankRow>();
    for (const row of rows.values()) {
      const k = narrativeKey(row);
      const cur = leaders.get(k);
      if (!cur || row.holders > cur.holders) leaders.set(k, row);
    }

    for (const row of rows.values()) {
      let s = seen[row.address];
      if (!s) {
        s = seen[row.address] = { firstSeen: t, symbol: row.symbol, stage: "s1_rejected" };
        counters.seen++;
      }
      if (s.stage !== "s1_rejected") continue; // already tracked or decided

      const reasons = stage1(row, this.cfg.s1, t, leaders.get(narrativeKey(row))?.address === row.address);
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
    if (this.cfg.source === "trenches") {
      if (!this.src.trenches) throw new Error("PIPELINE_SOURCE=trenches but the data source has no trenches()");
      const q = this.cfg.trenches;
      try {
        const rows = await this.src.trenches(this.cfg.chain, {
          types: q.types,
          limit: q.limit,
          filters: { min_marketcap: q.minMcap, max_marketcap: q.maxMcap, max_created: q.maxCreated },
        });
        for (const r of rows) if (!merged.has(r.address)) merged.set(r.address, r);
        return merged;
      } catch (err) {
        this.log(`[scan] trenches failed: ${(err as Error).message}`);
        return null;
      }
    }
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
    let holders: HolderSet | undefined;
    try {
      info = await this.src.tokenInfo(this.cfg.chain, addr);
      if (needsHolders(this.cfg.s3)) {
        if (!this.src.holders) throw new Error("holder checks are on but the data source has no holders()");
        holders = {
          smart: await this.src.holders(this.cfg.chain, addr, "smart_degen", 100),
          kol: await this.src.holders(this.cfg.chain, addr, "renowned", 50),
          top: await this.src.holders(this.cfg.chain, addr, "", 40),
        };
      }
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

    const hs = holders ? holderSummary(info, holders, this.cfg.s3.holderMinUsd) : undefined;
    const reasons = stage3(tr.lastRow, info, this.cfg.s3, holders);
    if (reasons.length) {
      this.store.event("s3_fail", { address: addr, symbol: tr.symbol, reasons, row: tr.lastRow, info, holders: hs });
      seen[addr].stage = "s3_failed";
      return;
    }

    const t = this.clock();
    seen[addr].stage = "alerted";
    counters.alerts++;
    this.store.event("alert", { address: addr, symbol: tr.symbol, row: tr.lastRow, info, summary, holders: hs });
    let text = formatAlert(this.cfg.chain, addr, tr.lastRow, info, summary, hs);
    const pos = this.paper?.open(addr, tr.symbol, info.price, t);
    if (this.cfg.journalAllAlerts || pos) {
      this.state.journaling[addr] = {
        symbol: tr.symbol,
        alertAt: t,
        alertPrice: info.price,
        until: t + this.cfg.journalHours * 3600,
      };
      this.store.journal(addr, snapshot(t, info));
    }
    if (pos) {
      this.store.event("paper_open", { address: addr, symbol: tr.symbol, price: pos.entryPrice, size: pos.size, cash: this.paper!.s.cash });
      const c = this.cfg.paper;
      text +=
        `\n📝 Paper buy $${pos.size.toFixed(2)} · TP ${usd(info.marketCap * c.takeProfit)} mcap (+${Math.round((c.takeProfit - 1) * 100)}%)` +
        ` · SL ${usd(info.marketCap * c.stopLoss)} (-${Math.round((1 - c.stopLoss) * 100)}%) · max ${c.maxHoldMin}m`;
    }
    await this.notify(text).catch((err) => this.log(`[alert] notify failed: ${(err as Error).message}`));
  }

  private async onPaperClose(c: PaperClose): Promise<void> {
    this.paper!.trackDrawdown();
    this.store.event("paper_close", { ...c });
    if (!this.cfg.journalAllAlerts && this.state.journaling[c.address]) {
      // Only held tokens are polled in this mode: stop once the position is closed.
      delete this.state.journaling[c.address];
      this.store.event("journal_done", { address: c.address, symbol: c.symbol });
    }
    const icon = c.ret > 0 ? "✅" : "❌";
    const why = { take_profit: "take-profit", stop_loss: "stop-loss", time_stop: "time stop" }[c.reason];
    await this.notify(
      `${icon} Paper sell **${c.symbol}** (${why}) after ${Math.round(c.heldMin)}m: ${c.ret >= 0 ? "+" : ""}${(c.ret * 100).toFixed(0)}% ` +
        `($${c.size.toFixed(2)} → $${c.proceeds.toFixed(2)})\n${this.paper!.summary()}`
    ).catch((err) => this.log(`[paper] notify failed: ${(err as Error).message}`));
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
        const info = await this.src.tokenInfo(this.cfg.chain, addr);
        this.store.journal(addr, snapshot(t, info));
        const closed = this.paper?.mark(addr, info.price, t);
        if (closed) await this.onPaperClose(closed);
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
      `tracking ${Object.keys(this.state.tracking).length}, journaling ${Object.keys(this.state.journaling).length}` +
      (this.paper ? ` | ${this.paper.summary()}` : "")
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

export function formatAlert(
  chain: string,
  addr: string,
  row: RankRow,
  info: TokenInfo,
  s: TrackSummary,
  h?: ReturnType<typeof holderSummary>
): string {
  const lines = [
    `🔔 **${info.symbol || row.symbol}** passed all 4 stages (${chain})`,
    `\`${addr}\``,
    `MC ${usd(info.marketCap)} · Liq ${usd(info.liquidity)} · Holders ${info.holders}`,
    `Tracked ${s.scans} scans / ${Math.round(s.trackedSec / 60)}m: holders ${pc(s.holderGrowthPct)}, ` +
      `liq ${pc(s.liquidityChangePct)}, price ${pc(s.priceChangePct)}, buy/sell ${s.buySellRatio.toFixed(2)}`,
    `Smart ${info.smartWallets} · KOL ${info.kolWallets} · Bot ${(info.botRate * 100).toFixed(0)}% · ` +
      `Rug ratio ${row.rugRatio.toFixed(2)} · Top10 ${(info.top10Rate * 100).toFixed(0)}%`,
  ];
  if (h) {
    const e = [...h.smartEntryMcaps].sort((a, b) => a - b);
    lines.push(
      `Smart/KOL still holding ${h.smartHolding} (${usd(h.smartHoldingUsd)})` +
        (e.length ? `, entries ${usd(e[0])}–${usd(e[e.length - 1])}` : "") +
        ` · Top-20 median entry ${usd(h.top20EntryMedian)}` +
        (h.biggestHolder ? ` · Biggest holder ${(h.biggestHolder.pct * 100).toFixed(1)}%` : "") +
        (h.systemPct > 0.01 ? ` · Vault/locked ${(h.systemPct * 100).toFixed(0)}%` : "")
    );
  }
  lines.push(`https://gmgn.ai/${chain}/token/${addr}`);
  return lines.join("\n");
}
