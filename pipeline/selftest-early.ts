/**
 * Offline test of PIPELINE_PROFILE=early (run by npm run pipeline:selftest): the first $10K cross
 * inside the first hour with $5K+ traded into it is bought on first sight, with the trailing exit.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfg } from "./config.js";
import type { Candle, GmgnSource, RankRow, TokenInfo } from "./gmgn.js";
import { Pipeline } from "./pipeline.js";
import { Store, readJsonl } from "./store.js";

assert.equal(cfg.profile, "early", "run with PIPELINE_PROFILE=early");
assert.equal(cfg.gate.crossMcap, 10_000);
assert.equal(cfg.gate.minVolume5m, 5_000);
assert.equal(cfg.gate.maxCrossAgeMin, 60);
assert.equal(cfg.s2.minObservations, 1);
assert.equal(cfg.paper.trailArm, 3);
assert.equal(cfg.paper.startCapital, 50);

let clock = 1_800_000_000;
const SUPPLY = 1e9;
const addr = (tag: string) => (tag + "x".repeat(44)).slice(0, 44);
const CREATED: Record<string, number> = { GOOD: clock - 8 * 60, THIN: clock - 8 * 60, HIGHSTART: clock - 8 * 60 };

function row(tag: string): RankRow {
  const mcap = 11_000;
  return {
    address: addr(tag), symbol: tag, name: tag, price: mcap / SUPPLY, marketCap: mcap, liquidity: 8_000, volume: 9_000,
    holders: 40, buys: 120, sells: 60, createdAt: CREATED[tag], top10Rate: 0.3, devHoldRate: 0.05, isWashTrading: false,
    bundlerRate: 0.3, botRate: 0.3, insiderRate: 0, entrapmentRatio: 0, rugRatio: 0, imageDup: 0, twitterDup: 0,
    websiteDup: 0, telegramDup: 0, smartCount: 0, kolCount: 0, launchpad: "Pump.fun", sniperHoldRate: 0.05, devTokens: 1,
  };
}
// $10K = price 0.00001
const k = (created: number, min: number, close: number, volume: number, open = close): Candle => ({ t: created + min * 60, o: open, h: Math.max(open, close), l: Math.min(open, close), c: close, volume });
function candles(tag: string): Candle[] {
  const c0 = CREATED[tag];
  if (tag === "GOOD") return [k(c0, 0, 0.000005, 500), k(c0, 1, 0.000006, 1500), k(c0, 2, 0.000008, 1500), k(c0, 3, 0.0000105, 2500), k(c0, 4, 0.000011, 1000)];
  if (tag === "THIN") return [k(c0, 0, 0.000005, 300), k(c0, 1, 0.000006, 300), k(c0, 2, 0.000008, 300), k(c0, 3, 0.0000105, 400), k(c0, 4, 0.000011, 300)];
  return [k(c0, 0, 0.000011, 9000, 0.000011), k(c0, 1, 0.000011, 9000)]; // HIGHSTART: opened above $10K
}

const fake: GmgnSource = {
  async rank() { throw new Error("rank must not be called in trenches mode"); },
  async trenches(_chain, q) { return q.platforms ? [] : Object.keys(CREATED).map(row); },
  async tokenInfo(_chain, address): Promise<TokenInfo> {
    const r = row(address.replace(/x+$/, ""));
    return {
      address, symbol: r.symbol, price: r.price, marketCap: r.marketCap, liquidity: r.liquidity, holders: r.holders,
      top10Rate: r.top10Rate, devHoldRate: 0.05, botRate: 0.3, bundlerTraderPct: 0.3, entrapmentTraderPct: 0,
      insiderTraderPct: 0, freshWalletRate: 0.1, smartWallets: 0, kolWallets: 0, whaleWallets: 0, bundlerWallets: 3,
      sniperWallets: 2, imageDupCount: 0, buys1m: 30, sells1m: 20, buyVolume1m: 2000, sellVolume1m: 1000,
      volume1m: 3000, volume5m: 6000, supply: SUPPLY, devTokens: 1,
    };
  },
  async klines(_chain, address) { return candles(address.replace(/x+$/, "")); },
};

const dir = mkdtempSync(join(tmpdir(), "gmgn-early-test-"));
const store = new Store(dir, () => clock);
const p = new Pipeline(cfg, fake, store, async () => {}, () => clock, undefined, () => {});
await p.scan();
clock += cfg.scanIntervalSec;
await p.scan();

const events = readJsonl<{ type: string; address: string; reasons?: string[] }>(join(dir, "events.jsonl"));
const final = (tag: string) => [...events].reverse().find((e) => e.address === addr(tag) && e.type !== "paper_open");
const expect = (tag: string, type: string, reason?: string) => {
  const e = final(tag);
  assert.equal(e?.type, type, `${tag}: expected ${type}, got ${e?.type} ${JSON.stringify(e?.reasons)}`);
  if (reason) assert.ok(e?.reasons?.includes(reason), `${tag}: expected ${reason}, got ${JSON.stringify(e?.reasons)}`);
  console.log(`  ✓ ${tag.padEnd(9)} → ${type}${reason ? ` (${reason})` : ""}`);
};
console.log("early entry paths:");
expect("GOOD", "alert");
expect("THIN", "s3_fail", "low_volume");
expect("HIGHSTART", "s3_fail", "gate_ignored");
assert.ok(events.some((e) => e.type === "paper_open" && e.address === addr("GOOD")), "bought on the first scan it was seen");
assert.equal(events.filter((e) => e.type === "paper_open").length, 1);
rmSync(dir, { recursive: true, force: true });
console.log("all early checks passed");
