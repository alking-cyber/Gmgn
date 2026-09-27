/**
 * Offline test of PIPELINE_PROFILE=newlaunch (run by npm run pipeline:selftest).
 * Drives the pipeline with a fake trenches + holders source through one token
 * per new rule: market-cap band, serial launcher, bundling, narrative copycats,
 * smart money not holding, underwater holder base and a single whale holder.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfg } from "./config.js";
import type { GmgnSource, Holder, RankRow, TokenInfo, TrenchQuery } from "./gmgn.js";
import { Pipeline } from "./pipeline.js";
import { Store, readJsonl } from "./store.js";

assert.equal(cfg.profile, "newlaunch", "run with PIPELINE_PROFILE=newlaunch");
assert.equal(cfg.source, "trenches");

let clock = 1_800_000_000;
const T0 = clock;
const addr = (tag: string) => (tag + "x".repeat(44)).slice(0, 44);
const SUPPLY = 1e9;

// price = mcap / supply; every token starts 3 minutes old.
function row(tag: string, sym: string, mcap: number, over: Partial<RankRow> = {}): RankRow {
  return {
    address: addr(tag), symbol: sym, name: sym, price: mcap / SUPPLY, marketCap: mcap, liquidity: 20_000, volume: 50_000,
    holders: 300, buys: 400, sells: 300, createdAt: T0 - 3 * 60, top10Rate: 0.2, devHoldRate: 0, isWashTrading: false,
    bundlerRate: 0.05, botRate: 0.3, insiderRate: 0, entrapmentRatio: 0.05, rugRatio: 0.1, imageDup: 0, twitterDup: 0,
    websiteDup: 0, telegramDup: 0, smartCount: 5, kolCount: 1, launchpad: "Pump.fun", sniperHoldRate: 0.02, devTokens: 1,
    ...over,
  };
}

let scanNo = 0;
const lastQuery: TrenchQuery[] = [];
function universe(): RankRow[] {
  const g = (base: number) => base + scanNo * 15; // holders keep growing
  return [
    row("GOOD", "GOOD", 42_000, { holders: g(300) }),
    row("BIG", "BIG", 150_000, { holders: g(300) }),
    row("SERIAL", "SERIAL", 40_000, { holders: g(300), devTokens: 2785 }),
    row("BUNDLED", "BUNDLED", 40_000, { holders: g(300), bundlerRate: 0.4 }),
    // Two clones of one narrative: the one with more holders is the leader.
    row("CLONEA", "⋈", 45_000, { holders: g(500), twitterDup: 3 }),
    row("CLONEB", "⋈", 35_000, { holders: g(120), twitterDup: 3 }),
    row("NOSMART", "NOSMART", 38_000, { holders: g(300) }),
    row("WHALE", "WHALE", 50_000, { holders: g(300) }),
  ];
}

const h = (a: string, pct: number, usd: number, entryMcap: number, extra: Partial<Holder> = {}): Holder => ({
  address: a, pct, usd, avgCost: entryMcap / SUPPLY, soldPct: 0, isPool: false, isSystem: false, name: "", tags: [], ...extra,
});

const fake: GmgnSource = {
  async rank() {
    throw new Error("rank must not be called in trenches mode");
  },
  async trenches(_chain, q) {
    lastQuery.push(q);
    return universe();
  },
  async tokenInfo(_chain, address): Promise<TokenInfo> {
    const r = universe().find((x) => x.address === address)!;
    return {
      address, symbol: r.symbol, price: r.price, marketCap: r.marketCap, liquidity: r.liquidity, holders: r.holders,
      top10Rate: r.top10Rate, devHoldRate: 0, botRate: 0.3, bundlerTraderPct: 0.05, entrapmentTraderPct: 0.05,
      insiderTraderPct: 0, freshWalletRate: 0.1, smartWallets: 5, kolWallets: 1, whaleWallets: 0, bundlerWallets: 3,
      sniperWallets: 2, imageDupCount: 0, buys1m: 30, sells1m: 20, buyVolume1m: 2000, sellVolume1m: 1000,
      volume1m: 3000, volume5m: 15000, supply: SUPPLY, devTokens: r.devTokens,
    };
  },
  async holders(_chain, address, tag) {
    const tagName = address.replace(/x+$/, "");
    const mc = universe().find((x) => x.address === address)!.marketCap;
    if (tag === "smart_degen") {
      if (tagName === "NOSMART") return [h("s1", 0.01, 3, mc)]; // below the $20 floor: dust, not a position
      return [h("s1", 0.01, 150, mc * 0.8), h("s2", 0.01, 90, mc * 1.1)];
    }
    if (tag === "renowned") return [];
    // top holders: a pool (ignored), then traders
    // a pool and a labelled bonding-curve vault (both ignored by the whale check), then traders
    const top = [h("pool", 0.3, 12_000, 0, { isPool: true }), h("vault", 0.5, 20_000, 0, { isSystem: true, name: "DBC Vault" })];
    if (tagName === "WHALE") top.push(h("w", 0.24, 12_000, 0));
    const entry = tagName === "CLONEA" ? mc * 3 : mc * 0.7; // CLONEA's holders bought far higher
    for (let i = 0; i < 20; i++) top.push(h(`t${i}`, 0.02, 800, entry));
    return top;
  },
};

const dir = mkdtempSync(join(tmpdir(), "gmgn-newlaunch-test-"));
const store = new Store(dir, () => clock);
const notified: string[] = [];
const p = new Pipeline(cfg, fake, store, async (t) => void notified.push(t), () => clock, undefined, () => {});

for (scanNo = 0; scanNo < 30; scanNo++) {
  await p.scan();
  clock += cfg.scanIntervalSec;
}

const events = readJsonl<{ type: string; symbol: string; address: string; reasons?: string[] }>(join(dir, "events.jsonl"));
const final = (tag: string) => [...events].reverse().find((e) => e.address === addr(tag));
const expect = (tag: string, type: string, reason?: string) => {
  const e = final(tag);
  assert.equal(e?.type, type, `${tag}: expected ${type}, got ${e?.type} ${JSON.stringify(e?.reasons)}`);
  if (reason) assert.ok(e?.reasons?.includes(reason), `${tag}: expected ${reason}, got ${JSON.stringify(e?.reasons)}`);
  console.log(`  ✓ ${tag.padEnd(8)} → ${type}${reason ? ` (${reason})` : ""}`);
};

console.log("newlaunch paths:");
expect("GOOD", "alert");
expect("BIG", "s1_reject", "mcap_above_band");
expect("SERIAL", "s1_reject", "serial_launcher");
expect("BUNDLED", "s1_reject", "bundled");
expect("CLONEB", "s1_reject", "copycat");
expect("CLONEA", "s3_fail", "holders_underwater"); // leader passes stage 1, then fails on holders
expect("NOSMART", "s3_fail", "smart_money_not_holding");
expect("WHALE", "s3_fail", "whale_holder");

assert.deepEqual(lastQuery[0].filters, { min_marketcap: cfg.trenches.minMcap, max_marketcap: cfg.trenches.maxMcap, max_created: cfg.trenches.maxCreated });
assert.ok(notified[0].includes("Smart/KOL still holding 2"), "alert shows who still holds");
assert.ok(notified[0].includes("Vault/locked 50%"), "alert shows supply parked in vaults");
console.log("  ✓ trenches query uses the configured band; alert lists smart money still holding");
console.log(`\n${p.statusLine()}\nall newlaunch checks passed`);
rmSync(dir, { recursive: true, force: true });
