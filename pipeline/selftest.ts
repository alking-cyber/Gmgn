/**
 * npm run pipeline:selftest
 *
 * Offline test: drives the pipeline with a fake GMGN source and a fake clock
 * through one token per path (pass, each stage-1/2/3 failure, API errors),
 * then checks the recorded events and journal. No network, no API key use.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfg } from "./config.js";
import type { GmgnSource, RankRow, TokenInfo } from "./gmgn.js";
import { Pipeline } from "./pipeline.js";
import { Store, readJsonl } from "./store.js";
import { STRATEGIES, runExit } from "./strategies.js";

let clock = 1_800_000_000;
const T0 = clock;

const addr = (tag: string) => (tag + "x".repeat(44)).slice(0, 44);

function row(tag: string, over: Partial<RankRow> = {}): RankRow {
  return {
    address: addr(tag), symbol: tag, name: tag, price: 0.001, marketCap: 500_000, liquidity: 50_000,
    volume: 100_000, holders: 1000, buys: 300, sells: 200, createdAt: T0 - 30 * 60, top10Rate: 0.18,
    devHoldRate: 0, isWashTrading: false, bundlerRate: 0.05, botRate: 0.4, insiderRate: 0,
    entrapmentRatio: 0.05, rugRatio: 0.2, imageDup: 0, twitterDup: 0, websiteDup: 0, telegramDup: 0,
    smartCount: 3, kolCount: 1, launchpad: "Pump.fun", ...over,
  };
}

function info(tag: string, price: number, over: Partial<TokenInfo> = {}): TokenInfo {
  return {
    address: addr(tag), symbol: tag, price, marketCap: price * 1e9, liquidity: 60_000, holders: 1200,
    top10Rate: 0.18, devHoldRate: 0, botRate: 0.4, bundlerTraderPct: 0.1, entrapmentTraderPct: 0.05,
    insiderTraderPct: 0, freshWalletRate: 0.1, smartWallets: 5, kolWallets: 2, whaleWallets: 1,
    bundlerWallets: 10, sniperWallets: 3, imageDupCount: 0, buys1m: 50, sells1m: 30, buyVolume1m: 5000,
    sellVolume1m: 3000, volume1m: 8000, volume5m: 40000, ...over,
  };
}

let scanNo = 0;
let failRank = false;
let infoFailuresLeft = 1; // first deep dive of RETRY fails once
const calls = { rank: 0, info: 0 };

// Per-token behaviour across scans.
function universe(): RankRow[] {
  const k = scanNo;
  const grow = (base: number) => base + k * 40;
  const rows: RankRow[] = [
    row("GOOD", { holders: grow(1000), price: 0.001 * (1 + k * 0.05) }),
    row("WASH", { isWashTrading: true, holders: grow(1000) }),
    row("TOP10", { top10Rate: 0.6 }),
    // Too young on the first scans, old enough later.
    row("YOUNG", { createdAt: T0 - 3 * 60, holders: grow(1000) }),
    // Holders collapse after a few scans.
    row("DUMP", { holders: k < 3 ? grow(1000) : 700 }),
    // Holders flat: never meets the growth rule, times out.
    row("FLAT", { holders: 1000 }),
    row("COPY", { twitterDup: 12, imageDup: 4, holders: grow(1000) }),
    row("RUG", { rugRatio: 0.8, holders: grow(1000) }),
    row("CONC", { holders: grow(1000) }), // concentrated per token info
    row("RETRY", { holders: grow(1000) }),
  ];
  // GONE drops out of trending after scan 2.
  if (k < 2) rows.push(row("GONE", { holders: grow(1000) }));
  return rows;
}

const fake: GmgnSource = {
  async rank(_chain, interval) {
    calls.rank++;
    if (failRank) throw new Error("GET /v1/market/rank failed: HTTP 429 error=RATE_LIMIT_EXCEEDED");
    // Second interval returns a subset with different buys/sells; first interval must win.
    const rows = universe();
    return interval === cfg.rankIntervals[0] ? rows : rows.slice(0, 3).map((r) => ({ ...r, buys: 1, sells: 999 }));
  },
  async tokenInfo(_chain, address) {
    calls.info++;
    const tag = address.replace(/x+$/, "");
    if (tag === "RETRY" && infoFailuresLeft-- > 0) throw new Error("GET /v1/token/info failed: HTTP 502");
    if (tag === "CONC") return info(tag, 0.001, { top10Rate: 0.7 });
    // GOOD pumps 3x within the journal window, then fades.
    const minsSinceStart = (clock - T0) / 60;
    const price = tag === "GOOD" ? 0.001 * (minsSinceStart < 60 ? 1 + minsSinceStart / 30 : 2) : 0.001;
    return info(tag, price, { holders: 1200 + Math.round(minsSinceStart * 10) });
  },
};

const dir = mkdtempSync(join(tmpdir(), "gmgn-pipeline-test-"));
const store = new Store(dir, () => clock);
const notified: string[] = [];
const logs: string[] = [];
const p = new Pipeline(cfg, fake, store, async (t) => void notified.push(t), () => clock, undefined, (m) => void logs.push(m));

// ~35 minutes of scans, journal every tick.
for (scanNo = 0; scanNo < 70; scanNo++) {
  failRank = scanNo === 5; // one scan where the API is rate limited
  await p.scan();
  await p.journalTick();
  clock += 30;
}
// Jump past the journal window.
clock += cfg.journalHours * 3600;
await p.journalTick();

const events = readJsonl<{ type: string; symbol: string; reasons?: string[] }>(join(dir, "events.jsonl"));
const final = (sym: string) => [...events].reverse().find((e) => e.symbol === sym && e.type !== "journal_done");
const expect = (sym: string, type: string, reason?: string) => {
  const e = final(sym);
  assert.equal(e?.type, type, `${sym}: expected ${type}, got ${e?.type} ${JSON.stringify(e?.reasons)}`);
  if (reason) assert.ok(e?.reasons?.includes(reason), `${sym}: expected reason ${reason}, got ${JSON.stringify(e?.reasons)}`);
  console.log(`  ✓ ${sym.padEnd(6)} → ${type}${reason ? ` (${reason})` : ""}`);
};

console.log("paths:");
expect("GOOD", "alert");
expect("RETRY", "alert"); // survived one deep-dive API error
expect("YOUNG", "alert"); // rejected as too_young first, re-checked, then passed
assert.ok(events.some((e) => e.symbol === "YOUNG" && e.reasons?.includes("too_young")));
expect("WASH", "s1_reject", "wash_trading");
expect("TOP10", "s1_reject", "top10_concentrated");
expect("DUMP", "s2_fail", "holders_falling");
expect("GONE", "s2_fail", "left_trending");
expect("FLAT", "s2_fail", "timeout");
expect("COPY", "s3_fail", "twitter_copycat");
expect("RUG", "s3_fail", "rug_ratio_high");
expect("CONC", "s3_fail", "top10_concentrated");

// Stage-1 rejections are logged once per reason set, not every scan.
assert.equal(events.filter((e) => e.symbol === "WASH").length, 1, "WASH logged once");

// Journal: GOOD has snapshots, and every journal finished after the window.
const journals = readdirSync(join(dir, "journal"));
assert.equal(journals.length, 3, "three alerted tokens journaled");
const good = readJsonl<{ price: number }>(join(dir, "journal", `${addr("GOOD")}.jsonl`));
assert.ok(good.length > 20, `GOOD journal has ${good.length} snapshots`);
assert.equal(Object.keys(p.state.journaling).length, 0, "journaling finished");
assert.equal(events.filter((e) => e.type === "journal_done").length, 3);
console.log(`  ✓ journal: ${good.length} snapshots for GOOD, all journals closed after ${cfg.journalHours}h`);

assert.equal(notified.length, 3, "3 alerts sent");
assert.ok(notified[0].includes("passed all 4 stages"));
assert.ok(logs.some((l) => l.includes("RATE_LIMIT_EXCEEDED")), "rank error logged, pipeline kept going");
assert.ok(logs.some((l) => l.includes("deep-dive") && l.includes("RETRY")), "deep dive error logged");
console.log("  ✓ rate-limited scan and deep-dive error were logged and survived");

// Exit strategies, checked by hand (no costs).
const A = STRATEGIES["A: 50% @+50%, 25% sisa/+25%, stop modal"]!;
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
// 50%@1.5 + 12.5%@1.75 + 9.375%@2.0, remaining 28.125% out at entry.
assert.ok(close(runExit([1, 1.5, 1.75, 2.0, 1.0], A, 0), 0.4375), "strategy A ladder");
assert.ok(close(runExit([1, 0.5], A, 0), -0.5), "stop gapped through fills at observed price");
assert.ok(close(runExit([1, 1.6, 0.1], STRATEGIES["jual semua +50%, SL -30%"]!, 0), 0.5), "full take-profit fills at its level");
assert.ok(close(runExit([1, 2], null, 0), 1), "hold");
const trail = runExit([1, 1.5, 3, 2.0, 1.0], STRATEGIES["A + trailing 30%, SL -30%"]!, 0);
assert.ok(trail > runExit([1, 1.5, 3, 2.0, 1.0], A, 0), "trailing stop keeps more than a stop at entry");
assert.ok(close(runExit([1, 1], null, 0.015), 0.985 / 1.015 - 1), "costs on both sides");
console.log("  ✓ exit strategies: ladder, gap-through stop, full TP, hold, trailing, costs");

console.log(`\n${p.statusLine()}`);
console.log(`API calls: ${calls.rank} rank, ${calls.info} token info`);
console.log(`\nall checks passed — test data kept at ${dir}`);
console.log(`inspect it with: PIPELINE_DATA_DIR=${dir} npm run pipeline:evaluate`);
if (process.argv.includes("--clean")) rmSync(dir, { recursive: true, force: true });
