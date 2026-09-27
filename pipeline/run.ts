/**
 * Entry point: npm run pipeline
 *
 * Runs discovery/tracking every SCAN_INTERVAL_SEC and the journal every
 * JOURNAL_INTERVAL_SEC until stopped (Ctrl+C / SIGTERM from pm2).
 * Pass --once to run a single scan and exit (useful for smoke tests).
 */

import { cfg } from "./config.js";
import { GmgnApi } from "./gmgn.js";
import { Pipeline, emptyState, type Notify } from "./pipeline.js";
import { Store, now } from "./store.js";

const once = process.argv.includes("--once");

const discord: Notify = async (text) => {
  console.log("\n" + text + "\n");
  if (!cfg.discordWebhookUrl) return;
  const res = await fetch(cfg.discordWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // allowed_mentions: none, so a token name can never ping @everyone.
    body: JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }),
  });
  if (!res.ok) throw new Error(`Discord webhook HTTP ${res.status}`);
};

const store = new Store(cfg.dataDir);
const pipeline = new Pipeline(cfg, new GmgnApi(), store, discord, now, store.loadState(emptyState()));

const ts = () => new Date().toISOString().slice(11, 19);
let stopping = false;
let lastStatus = 0;

async function loop(name: string, everySec: number, fn: () => Promise<void>): Promise<void> {
  while (!stopping) {
    const started = Date.now();
    try {
      await fn();
    } catch (err) {
      console.error(`[${ts()}] ${name} crashed: ${(err as Error).stack ?? err}`);
    }
    store.saveState(pipeline.state);
    if (once) return;
    const wait = everySec * 1000 - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1);
    stopping = true;
    store.saveState(pipeline.state);
    console.log(`\n[${ts()}] stopping — state saved. ${pipeline.statusLine()}`);
    process.exit(0);
  });
}

console.log(
  `[${ts()}] pipeline started: chain=${cfg.chain} intervals=${cfg.rankIntervals.join("+")} ` +
    `scan=${cfg.scanIntervalSec}s data=${cfg.dataDir}${cfg.discordWebhookUrl ? " discord=on" : ""}`
);

await Promise.all([
  loop("scan", cfg.scanIntervalSec, async () => {
    await pipeline.scan();
    // Heartbeat line every 5 minutes (every scan in --once mode).
    if (once || Date.now() - lastStatus > 5 * 60_000) {
      lastStatus = Date.now();
      console.log(`[${ts()}] ${pipeline.statusLine()}`);
    }
  }),
  loop("journal", cfg.journalIntervalSec, () => pipeline.journalTick()),
]);
