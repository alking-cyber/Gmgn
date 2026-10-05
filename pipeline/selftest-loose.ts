/**
 * Offline test of the loose profile's entry (run by npm run pipeline:selftest): tokens that
 * crossed $100K are bought only when the cross passes the runner gate and the funding checks.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfg } from "./config.js";
import type { Candle, GmgnSource, RankRow, TokenInfo } from "./gmgn.js";
import type { Funding } from "./gate.js";
import { Pipeline } from "./pipeline.js";
import { Store, readJsonl } from "./store.js";

assert.equal(cfg.profile, "loose", "run with PIPELINE_PROFILE=loose");

let clock = 1_800_000_000;
const T0 = clock;
const CREATED = T0 - 10 * 60; // every token is 10 minutes old at the first scan
const SUPPLY = 1e9;
const addr = (tag: string) => (tag + "x".repeat(44)).slice(0, 44);

const NOW_MCAP: Record<string, number> = { ORGANIC: 130_000, RAMP: 130_000, FUNDED: 130_000, CHASED: 260_000 };
function row(tag: string): RankRow {
  const mcap = NOW_MCAP[tag];
  return {
    address: addr(tag), symbol: tag, name: tag, price: mcap / SUPPLY, marketCap: mcap, liquidity: 20_000, volume: 50_000,
    holders: 300, buys: 400, sells: 300, createdAt: CREATED, top10Rate: 0.2, devHoldRate: 0, isWashTrading: false,
    bundlerRate: 0.35, botRate: 0.3, insiderRate: 0, entrapmentRatio: 0.05, rugRatio: 0.1, imageDup: 0, twitterDup: 0,
    websiteDup: 0, telegramDup: 0, smartCount: 0, kolCount: 0, launchpad: "Pump.fun", sniperHoldRate: 0.02, devTokens: 1,
  };
}

// 1m candles from launch; the cross ($100K = price 0.0001) happens at minute 5
const k = (min: number, close: number): Candle => ({ t: CREATED + min * 60, o: close, h: close, l: close, c: close, volume: 5_000 });
const organic = [k(0, 0.00004), k(1, 0.000045), k(2, 0.00005), k(3, 0.000048), k(4, 0.00008), k(5, 0.000105), k(6, 0.00012)];
const ramp = [k(0, 0.00004), k(1, 0.000045), k(2, 0.00005), k(3, 0.000055), k(4, 0.00008), k(5, 0.000105), k(6, 0.00012)];

const fake: GmgnSource = {
  async rank() {
    throw new Error("rank must not be called in trenches mode");
  },
  async trenches() {
    return Object.keys(NOW_MCAP).map(row);
  },
  async tokenInfo(_chain, address): Promise<TokenInfo> {
    const r = row(address.replace(/x+$/, ""));
    return {
      address, symbol: r.symbol, price: r.price, marketCap: r.marketCap, liquidity: r.liquidity, holders: r.holders,
      top10Rate: r.top10Rate, devHoldRate: 0, botRate: 0.3, bundlerTraderPct: 0.35, entrapmentTraderPct: 0.05,
      insiderTraderPct: 0, freshWalletRate: 0.1, smartWallets: 0, kolWallets: 0, whaleWallets: 0, bundlerWallets: 30,
      sniperWallets: 2, imageDupCount: 0, buys1m: 30, sells1m: 20, buyVolume1m: 2000, sellVolume1m: 1000,
      volume1m: 3000, volume5m: 15000, supply: SUPPLY, devTokens: 1,
    };
  },
  async klines(_chain, address) {
    return address.startsWith("RAMP") ? ramp : organic;
  },
  async traderFunding(_chain, address): Promise<Funding[]> {
    if (address.startsWith("FUNDED")) return [0, 30, 60, 90, 120].map((d) => ({ at: CREATED - 1800 + d, from: `w${d}`, exchange: "Binance" }));
    return [0, 1, 2, 3, 4].map((i) => ({ at: CREATED - 30 * 86400 - i * 86400, from: `w${i}`, exchange: "Coinbase" }));
  },
};

const dir = mkdtempSync(join(tmpdir(), "gmgn-loose-test-"));
const store = new Store(dir, () => clock);
const p = new Pipeline(cfg, fake, store, async () => {}, () => clock, undefined, () => {});
for (let i = 0; i < 6; i++) {
  await p.scan();
  clock += cfg.scanIntervalSec;
}

const events = readJsonl<{ type: string; address: string; reasons?: string[] }>(join(dir, "events.jsonl"));
const final = (tag: string) => [...events].reverse().find((e) => e.address === addr(tag) && e.type !== "paper_open");
const expect = (tag: string, type: string, reason?: string) => {
  const e = final(tag);
  assert.equal(e?.type, type, `${tag}: expected ${type}, got ${e?.type} ${JSON.stringify(e?.reasons)}`);
  if (reason) assert.ok(e?.reasons?.includes(reason), `${tag}: expected ${reason}, got ${JSON.stringify(e?.reasons)}`);
  console.log(`  ✓ ${tag.padEnd(8)} → ${type}${reason ? ` (${reason})` : ""}`);
};
console.log("loose entry paths:");
expect("ORGANIC", "alert"); // bundle rate 35% is not a reason to skip: runners were bundled more often, not less
expect("RAMP", "s3_fail", "bot_ramp");
expect("FUNDED", "s3_fail", "funded_together");
expect("CHASED", "s3_fail", "chased");
assert.ok(events.some((e) => e.type === "paper_open" && e.address === addr("ORGANIC")), "the passing token is paper-bought");
rmSync(dir, { recursive: true, force: true });
console.log("all loose checks passed");
