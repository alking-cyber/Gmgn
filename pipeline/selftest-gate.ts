/**
 * Offline test of the runner gate and the tracker report (run by npm run pipeline:selftest).
 */

import assert from "node:assert/strict";
import type { Candle } from "./gmgn.js";
import { peakMcap, runnerGate } from "./gate.js";
import { report } from "./runner-tracker.js";

const T0 = 1_800_000_000; // creation time
const SUPPLY = 1_000_000_000; // price 0.0001 = $100K market cap
const c = (min: number, close: number, volume: number, open = close): Candle => ({ t: T0 + min * 60, o: open, h: Math.max(open, close), l: Math.min(open, close), c: close, volume });

// steady climb, crosses $100K at minute 5 with $20K of volume in the last 5 candles -> pass
const steady = [c(0, 0.00004, 2000), c(1, 0.000045, 3000), c(2, 0.00005, 4000), c(3, 0.00006, 4000), c(4, 0.00008, 5000), c(5, 0.000105, 4000), c(6, 0.00011, 5000)];
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

// not crossed yet: pending inside the first hour, ignored after it; inflated launches ignored
assert.equal(runnerGate([c(0, 0.00005, 1000)], SUPPLY, T0, T0 + 600).status, "pending");
assert.equal(runnerGate([c(0, 0.00005, 1000)], SUPPLY, T0, T0 + 7200).status, "ignored");
assert.equal(runnerGate([c(0, 0.0003, 1000, 0.00025)], SUPPLY, T0, T0 + 600).status, "ignored");
console.log("  ✓ runner gate: pass on a steady cross with volume; fails instant, thin and vertical crosses; pending / ignored");

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
assert.ok(text.includes("gate PASS      recorded    51 | resolved    50 | reached $1M    1 | reached $10M   1 (1 in 50)"), text);
assert.ok(text.includes("gate FAIL      recorded   100 | resolved   100 | reached $1M    2 | reached $10M   0 (0 of 100)"), text);
console.log("  ✓ tracker report: runner rate per gate group");
console.log("all gate checks passed");
