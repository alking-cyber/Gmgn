/**
 * Offline test of the paper-trading book and the loose profile (run by npm run pipeline:selftest).
 */

import assert from "node:assert/strict";
import { cfg } from "./config.js";
import { Paper, emptyPaper } from "./paper.js";

assert.equal(cfg.profile, "loose", "run with PIPELINE_PROFILE=loose");
assert.equal(cfg.paper.enabled, true);
assert.equal(cfg.s1.minMcap, 20_000);
assert.equal(cfg.s1.maxMcap, 150_000);
assert.equal(cfg.s3.minHoldingSmart, 0);
assert.equal(cfg.s3.minKolPlusSmart, 0);
console.log("  ✓ loose profile: $20-150K band, no smart-money requirement, paper trading on");

const c = { ...cfg.paper, startCapital: 140, positionPct: 0.1, maxOpen: 8, takeProfit: 2, stopLoss: 0.7, maxHoldMin: 180, costPct: 1.5 };
const k = (1 - 0.015) / (1 + 0.015); // round-trip cost factor
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const p = new Paper(c, emptyPaper(140));
const T = 1_800_000_000;

// 1. take-profit fills at the level even when the poll overshoots
p.open("A", "A", 1, T);
assert.ok(close(p.s.cash, 126));
assert.equal(p.mark("A", 1.5, T + 60), undefined);
const tp = p.mark("A", 3.2, T + 120)!;
assert.equal(tp.reason, "take_profit");
assert.ok(close(tp.ret, 2 * k - 1), `tp ret ${tp.ret}`);
assert.ok(close(p.s.cash, 126 + 14 * 2 * k));

// 2. stop-loss fills at the observed price when price gaps through it
const size2 = p.equity() * 0.1; // nothing open: equity = cash
p.open("B", "B", 1, T);
const sl = p.mark("B", 0.4, T + 60)!;
assert.equal(sl.reason, "stop_loss");
assert.ok(close(sl.ret, 0.4 * k - 1));
assert.ok(close(sl.size, size2), "size is 10% of equity at entry (compounding)");

// 3. time stop after maxHoldMin at the polled price
p.open("C", "C", 1, T);
assert.equal(p.mark("C", 1.1, T + 179 * 60), undefined);
const ts = p.mark("C", 1.1, T + 180 * 60)!;
assert.equal(ts.reason, "time_stop");
assert.ok(close(ts.ret, 1.1 * k - 1));

// 4. no double entry, drawdown tracking
assert.ok(p.open("D", "D", 1, T));
assert.equal(p.open("D", "D", 1, T), undefined, "one position per token");
p.trackDrawdown();
assert.equal(p.s.trades, 3);
assert.equal(p.s.wins, 2);

// 5. at most maxOpen positions; later alerts are skipped, sizes stay ~10% of equity
for (let i = 0; i < 12; i++) p.open(`E${i}`, `E${i}`, 1, T);
assert.equal(Object.keys(p.s.positions).length, 8, "max 8 open");
assert.equal(p.s.skipped, 5, "D + 7 new opened, 5 skipped");
const sizes = Object.values(p.s.positions).map((x) => x.size);
assert.ok(Math.min(...sizes) > 0.09 * p.equity() * 0.9, "later positions are not dust");
console.log("  ✓ paper book: TP at level, SL at gapped price, time stop, 10% of equity per trade, max 8 open, costs both sides");
console.log("all paper checks passed");
