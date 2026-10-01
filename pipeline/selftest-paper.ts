/**
 * Offline test of the paper-trading book and the loose profile (run by npm run pipeline:selftest).
 */

import assert from "node:assert/strict";
import { cfg } from "./config.js";
import { Paper, emptyPaper, type PaperClose, type PaperPartial } from "./paper.js";

assert.equal(cfg.profile, "loose", "run with PIPELINE_PROFILE=loose");
assert.equal(cfg.paper.enabled, true);
assert.equal(cfg.s1.minMcap, 100_000);
assert.equal(cfg.s1.maxMcap, 1_000_000);
assert.equal(cfg.s3.runnerGate, true);
assert.equal(cfg.s3.fundingCheck, true);
assert.equal(cfg.s3.minHoldingSmart, 0);
assert.equal(cfg.s3.minKolPlusSmart, 0);
console.log("  ✓ loose profile: entry at the $100K cross through the runner gate + funding checks, no smart-money requirement, paper trading on");

assert.equal(cfg.paper.runner.enabled, true, "loose keeps half of every take-profit by default");
// cases 1-5: plain book (runner hold off)
const c = { ...cfg.paper, startCapital: 140, positionPct: 0.1, maxOpen: 8, takeProfit: 2, stopLoss: 0.7, maxHoldMin: 180, costPct: 1.5, runner: { ...cfg.paper.runner, enabled: false } };
const k = (1 - 0.015) / (1 + 0.015); // round-trip cost factor
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const p = new Paper(c, emptyPaper(140));
const T = 1_800_000_000;

// 1. take-profit fills at the level even when the poll overshoots
p.open("A", "A", 1, T);
assert.ok(close(p.s.cash, 126));
assert.equal(p.mark("A", 1.5, T + 60), undefined);
const tp = p.mark("A", 3.2, T + 120) as PaperClose;
assert.equal(tp.reason, "take_profit");
assert.ok(close(tp.ret, 2 * k - 1), `tp ret ${tp.ret}`);
assert.ok(close(p.s.cash, 126 + 14 * 2 * k));

// 2. stop-loss fills at the observed price when price gaps through it
const size2 = p.equity() * 0.1; // nothing open: equity = cash
p.open("B", "B", 1, T);
const sl = p.mark("B", 0.4, T + 60) as PaperClose;
assert.equal(sl.reason, "stop_loss");
assert.ok(close(sl.ret, 0.4 * k - 1));
assert.ok(close(sl.size, size2), "size is 10% of equity at entry (compounding)");

// 3. time stop after maxHoldMin at the polled price
p.open("C", "C", 1, T);
assert.equal(p.mark("C", 1.1, T + 179 * 60), undefined);
const ts = p.mark("C", 1.1, T + 180 * 60) as PaperClose;
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

// 6. runner hold (default): half sold at 2x, half kept with no target, out only at -30% from entry
const base = { enabled: true, keepPct: 0.5, stopX: 0.7, maxHoldMin: 7 * 1440, pollSec: 300, minHolderGrowth: 0, minVolume5m: 0, smartNotFewer: false, trailPct: 0, holderDropPct: 0 };
const entry = { holders: 1000, volume5m: 50000, smartPlusKol: 3 };
const r = new Paper({ ...c, runner: base }, emptyPaper(140));
r.open("R", "R", 1, T, entry);
const part = r.mark("R", 2.1, T + 60) as PaperPartial;
assert.ok(part && "soldFrac" in part, "every take-profit keeps half by default");
assert.ok(close(part.proceeds, 14 * 0.5 * 2 * k), "half sold at the take-profit level");
assert.ok(close(r.equity(), 126 + part.proceeds + 7), "kept half valued at cost");
assert.equal(r.mark("R", 50, T + 600), undefined, "rides to 50x");
assert.equal(r.mark("R", 3, T + 900), undefined, "no trailing stop: a fall from 50x to 3x is still held");
const rs = r.mark("R", 0.65, T + 1200) as PaperClose;
assert.equal(rs.reason, "runner_stop", "kept half exits at -30% from entry");
assert.ok(close(rs.proceeds, part.proceeds + 7 * 0.65 * k), "whole-position proceeds");
assert.ok(close(rs.ret, rs.proceeds / 14 - 1));
assert.ok(rs.ret > 0, "half sold at +100% covers the kept half falling to -35%");
assert.equal(r.s.trades, 1);

// 7. kept runners do not block new trades
const m = new Paper({ ...c, maxOpen: 2, runner: base }, emptyPaper(140));
m.open("M1", "M1", 1, T); m.open("M2", "M2", 1, T);
assert.equal(m.open("M3", "M3", 1, T), undefined, "full");
m.mark("M1", 2, T + 60);
assert.ok(m.open("M3", "M3", 1, T + 120), "M1 is now a kept runner and frees its slot");

// 8. optional strength checks: weak at the take-profit sells everything
const strict = new Paper({ ...c, runner: { ...base, minHolderGrowth: 0.2, minVolume5m: 30000, smartNotFewer: true } }, emptyPaper(140));
strict.open("W", "W", 1, T, entry);
const weak = strict.mark("W", 2.2, T + 60, { holders: 1050, volume5m: 90000, smartPlusKol: 5 }) as PaperClose;
assert.equal(weak.reason, "take_profit", "holders up only 5%");
strict.open("S", "S", 1, T, entry);
assert.ok("soldFrac" in (strict.mark("S", 2.2, T + 60, { holders: 1300, volume5m: 90000, smartPlusKol: 3 }) as PaperPartial), "strong is kept");

// 9. optional extra exits: trailing and holders leaving
const ex = new Paper({ ...c, runner: { ...base, trailPct: 0.3, holderDropPct: 0.15 } }, emptyPaper(140));
ex.open("T", "T", 1, T, entry);
ex.mark("T", 2, T + 60, { holders: 1500, volume5m: 0, smartPlusKol: 0 });
ex.mark("T", 5, T + 120, { holders: 2000, volume5m: 0, smartPlusKol: 0 });
assert.equal((ex.mark("T", 3.4, T + 180, { holders: 2000, volume5m: 0, smartPlusKol: 0 }) as PaperClose).reason, "runner_trail");
ex.open("H", "H", 1, T, entry);
ex.mark("H", 2, T + 60, { holders: 2000, volume5m: 0, smartPlusKol: 0 });
assert.equal((ex.mark("H", 2.1, T + 120, { holders: 1690, volume5m: 0, smartPlusKol: 0 }) as PaperClose).reason, "runner_holders_leaving");
console.log("  ✓ runner hold: half at 2x, half held to -30% from entry with no trailing, kept halves free their slot; optional checks/exits work");
console.log("all paper checks passed");
