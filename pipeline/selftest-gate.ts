/**
 * Offline test of the runner gate and the tracker report (run by npm run pipeline:selftest).
 */

import assert from "node:assert/strict";
import type { Candle } from "./gmgn.js";
import { fundingFlags, peakMcap, runnerGate } from "./gate.js";
import { report } from "./runner-tracker.js";

const T0 = 1_800_000_000; // creation time
const SUPPLY = 1_000_000_000; // price 0.0001 = $100K market cap
const c = (min: number, close: number, volume: number, open = close): Candle => ({ t: T0 + min * 60, o: open, h: Math.max(open, close), l: Math.min(open, close), c: close, volume });

// organic climb with a pullback, crosses $100K at minute 5 with $20K of volume in the last 5 candles -> pass
const steady = [c(0, 0.00004, 2000), c(1, 0.000045, 3000), c(2, 0.00005, 4000), c(3, 0.000048, 4000), c(4, 0.00008, 5000), c(5, 0.000105, 4000), c(6, 0.00011, 5000)];
const g1 = runnerGate(steady, SUPPLY, T0, T0 + 3600);
assert.equal(g1.status, "pass");
if (g1.status === "pass") {
  assert.equal(g1.ageMin, 6);
  assert.equal(g1.volume5m, 20000);
  assert.ok(Math.abs(g1.change5m - (0.000105 / 0.00004 - 1)) < 1e-9);
}

// crossed in the very first candle with no volume -> fail (instant + low volume)
const g2 = runnerGate([c(0, 0.00012, 500, 0.00002), c(1, 0.00013, 800)], SUPPLY, T0 + 30, T0 + 3600);
assert.equal(g2.status, "fail");
if (g2.status === "fail") assert.deepEqual(g2.reasons, ["low_volume", "instant"]);

// +400% in the 5 minutes into the cross -> fail (vertical), even with plenty of volume
const vertical = [c(0, 0.00002, 9000), c(1, 0.00002, 9000), c(2, 0.00002, 9000), c(3, 0.00002, 9000), c(4, 0.00002, 9000), c(5, 0.00002, 9000), c(6, 0.0001, 30000)];
const g3 = runnerGate(vertical, SUPPLY, T0, T0 + 3600);
assert.equal(g3.status, "fail");
if (g3.status === "fail") assert.deepEqual(g3.reasons, ["vertical"]);

// smooth staircase: every candle green into the cross -> fail (bot ramp)
const ramp = [c(0, 0.00004, 9000), c(1, 0.000045, 9000), c(2, 0.00005, 9000), c(3, 0.000055, 9000), c(4, 0.00008, 9000), c(5, 0.000105, 9000)];
const g4 = runnerGate(ramp, SUPPLY, T0, T0 + 3600);
assert.equal(g4.status, "fail");
if (g4.status === "fail") { assert.deepEqual(g4.reasons, ["bot_ramp"]); assert.equal(g4.greenShare, 1); }

// not crossed yet: pending inside the first hour, ignored after it; inflated launches ignored
assert.equal(runnerGate([c(0, 0.00005, 1000)], SUPPLY, T0, T0 + 600).status, "pending");
assert.equal(runnerGate([c(0, 0.00005, 1000)], SUPPLY, T0, T0 + 7200).status, "ignored");
assert.equal(runnerGate([c(0, 0.0003, 1000, 0.00025)], SUPPLY, T0, T0 + 600).status, "ignored");
console.log("  ✓ runner gate: pass on an organic cross with volume; fails instant, thin, vertical and bot-ramp crosses; pending / ignored");

// funding: 5 wallets funded inside 10 minutes before the cross -> red flag; old or post-cross funding ignored
const cross = T0 + 600;
const fund = (at: number, from = "A" + at, exchange: string | null = "Binance") => ({ at, from, exchange });
const together = [0, 60, 120, 180, 240].map((d) => fund(T0 - 3600 + d));
assert.deepEqual(fundingFlags(together, T0, cross).reasons, ["funded_together"]);
assert.deepEqual(fundingFlags(together.slice(0, 4), T0, cross).reasons, [], "4 is fine");
assert.deepEqual(fundingFlags([0, 900, 1800, 2700, 3600].map((d) => fund(T0 - 7200 + d)), T0, cross).reasons, [], "spread out over an hour");
assert.deepEqual(fundingFlags(together.map((x) => ({ ...x, at: x.at - 2 * 86400 })), T0, cross).reasons, [], "funded days earlier: normal wallets");
const oneFunder = [0, 1, 2, 3, 4].map((i) => fund(T0 - 80000 + i * 3000, "OPERATOR", null));
assert.deepEqual(fundingFlags(oneFunder, T0, cross).reasons, ["one_funder"]);
assert.deepEqual(fundingFlags(oneFunder.map((x) => ({ ...x, exchange: "Coinbase" })), T0, cross).reasons, [], "an exchange hot wallet is not one operator");
console.log("  ✓ funding: 5+ wallets funded within 10 minutes, or 5+ from one non-exchange address, before the cross");

// peak uses closes of hours with real volume only (a lone print cannot fake a runner)
const H = [c(0, 0.001, 50_000), c(60, 0.5, 100), c(120, 0.02, 20_000)];
assert.equal(peakMcap(H, SUPPLY), 0.02 * SUPPLY);
console.log("  ✓ outcome: highest hourly close with ≥ $5K volume");

// report counts runners per group among resolved tokens
const day = 86400;
const rec = (status: "pass" | "fail", peak?: number) => ({ symbol: "X", launchpad: "Pump.fun", createdAt: T0, supply: SUPPLY, status, crossAt: T0 + 300, peakMcap: peak, resolvedAt: peak == null ? undefined : T0 + 8 * day });
const db: Record<string, ReturnType<typeof rec>> = {};
for (let i = 0; i < 50; i++) db[`p${i}`] = rec("pass", i === 0 ? 2e7 : 5e4);
for (let i = 0; i < 100; i++) db[`f${i}`] = rec("fail", i < 2 ? 3e6 : 5e4);
db.open = rec("pass");
const text = report(db as never, T0 + 8 * day);
assert.ok(text.includes("gate PASS          recorded    51 | resolved    50 | reached $1M    1 | reached $10M   1 (1 in 50)"), text);
assert.ok(text.includes("gate FAIL          recorded   100 | resolved   100 | reached $1M    2 | reached $10M   0 (0 of 100)"), text);
console.log("  ✓ tracker report: runner rate per gate group");
console.log("all gate checks passed");
