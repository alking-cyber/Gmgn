/**
 * Offline test of the paper-trading book and the loose profile (run by npm run pipeline:selftest).
 */

import assert from "node:assert/strict";
import { cfg } from "./config.js";
import { Paper, emptyPaper, type PaperClose, type PaperPartial } from "./paper.js";

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

// 6. runner hold: strong at the take-profit -> sell half, keep half with a trailing stop
const rc = { ...c, runner: { enabled: true, minHolderGrowth: 0.2, minVolume5m: 30000, keepPct: 0.5, trailPct: 0.3, holderDropPct: 0.15, maxHoldMin: 720 } };
const entry = { holders: 1000, volume5m: 50000, smartPlusKol: 3 };
const r = new Paper(rc, emptyPaper(140));
r.open("R", "R", 1, T, entry);
const part = r.mark("R", 2.1, T + 60, { holders: 1300, volume5m: 80000, smartPlusKol: 3 }) as PaperPartial;
assert.ok(part && "soldFrac" in part, "strong token turns into a runner");
assert.ok(close(part.proceeds, 14 * 0.5 * 2 * k), "half sold at the take-profit level");
assert.ok(close(r.equity(), 126 + part.proceeds + 7), "kept half valued at cost");
assert.equal(r.mark("R", 5, T + 600, { holders: 2000, volume5m: 1e5, smartPlusKol: 4 }), undefined, "keeps riding");
const tr = r.mark("R", 3.4, T + 900, { holders: 2000, volume5m: 1e5, smartPlusKol: 4 }) as PaperClose;
assert.equal(tr.reason, "runner_trail", "exits 30% below the high (5 -> 3.5)");
assert.ok(close(tr.proceeds, part.proceeds + 7 * 3.4 * k), "whole-position proceeds");
assert.ok(close(tr.ret, tr.proceeds / 14 - 1));
assert.equal(r.s.trades, 1);
assert.equal(r.s.wins, 1);

// 7. weak at the take-profit (holders flat) -> sells everything as before
r.open("W", "W", 1, T, entry);
const weak = r.mark("W", 2.2, T + 60, { holders: 1050, volume5m: 90000, smartPlusKol: 5 }) as PaperClose;
assert.equal(weak.reason, "take_profit");
assert.ok(close(weak.ret, 2 * k - 1));

// 8. runner exits when holders leave, and never below the entry price
r.open("H", "H", 1, T, entry);
r.mark("H", 2, T + 60, { holders: 1500, volume5m: 40000, smartPlusKol: 3 });
r.mark("H", 2.2, T + 120, { holders: 2000, volume5m: 40000, smartPlusKol: 3 });
const hl = r.mark("H", 2.1, T + 180, { holders: 1690, volume5m: 40000, smartPlusKol: 3 }) as PaperClose;
assert.equal(hl.reason, "runner_holders_leaving", "holders fell more than 15% from 2000");
r.open("F", "F", 1, T, entry);
r.mark("F", 2, T + 60, { holders: 1500, volume5m: 40000, smartPlusKol: 3 });
const fl = r.mark("F", 0.5, T + 120, { holders: 1500, volume5m: 40000, smartPlusKol: 3 }) as PaperClose;
assert.equal(fl.reason, "runner_trail");
assert.ok(fl.ret > 0, "half was sold at +100%, so a runner that collapses still ends up positive");
console.log("  ✓ runner hold: strong at TP keeps 50% with a 30% trail (floor at entry), weak sells all, holders leaving exits");
console.log("all paper checks passed");
