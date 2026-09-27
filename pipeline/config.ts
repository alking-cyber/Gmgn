/**
 * Pipeline settings. Every threshold can be overridden from the environment
 * (e.g. S1_MIN_HOLDERS=300 in ~/.config/gmgn/.env or ./.env).
 *
 * The defaults are starting points calibrated against one live snapshot of
 * SOL trending data — not proven. Run the pipeline for a few days and let
 * `npm run pipeline:evaluate` tell you which rules actually separate runners
 * from losers.
 */

// Side effect: loads ~/.config/gmgn/.env and ./.env, so the overrides below see them.
import "../src/config.js";

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v == null || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
}

function str(name: string, def: string): string {
  return process.env[name] || def;
}

function list(name: string, def: string[]): string[] {
  const v = process.env[name];
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : def;
}

export const cfg = {
  chain: str("PIPELINE_CHAIN", "sol"),
  dataDir: str("PIPELINE_DATA_DIR", new URL("./data", import.meta.url).pathname),
  scanIntervalSec: num("SCAN_INTERVAL_SEC", 30),
  journalIntervalSec: num("JOURNAL_INTERVAL_SEC", 30),
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || "",

  // ---- Stage 1: discovery (on /v1/market/rank rows) ----
  // Each scan polls every interval below and merges the results.
  rankIntervals: list("RANK_INTERVALS", ["1m", "5m"]),
  rankLimit: num("RANK_LIMIT", 100),
  // Server-side age cap so the universe is fresh tokens only.
  rankMaxCreated: str("RANK_MAX_CREATED", "24h"),
  s1: {
    minAgeMin: num("S1_MIN_AGE_MIN", 5),
    maxAgeMin: num("S1_MAX_AGE_MIN", 24 * 60),
    minHolders: num("S1_MIN_HOLDERS", 150),
    minLiquidityUsd: num("S1_MIN_LIQUIDITY_USD", 10_000),
    maxTop10Rate: num("S1_MAX_TOP10_RATE", 0.3),
    maxDevHoldRate: num("S1_MAX_DEV_HOLD_RATE", 0.05),
  },

  // ---- Stage 2: tracking (across repeated rank scans) ----
  s2: {
    minObservations: num("S2_MIN_OBSERVATIONS", 4),
    minTrackSec: num("S2_MIN_TRACK_SEC", 120),
    maxTrackSec: num("S2_MAX_TRACK_SEC", 30 * 60),
    maxMissedScans: num("S2_MAX_MISSED_SCANS", 3),
    minHolderGrowthPct: num("S2_MIN_HOLDER_GROWTH_PCT", 2),
    maxHolderDropPct: num("S2_MAX_HOLDER_DROP_PCT", 5),
    maxLiquidityDropPct: num("S2_MAX_LIQUIDITY_DROP_PCT", 25),
    minBuySellRatio: num("S2_MIN_BUY_SELL_RATIO", 1.0),
    maxBundlerRate: num("S2_MAX_BUNDLER_RATE", 0.3),
    maxBundlerRise: num("S2_MAX_BUNDLER_RISE", 0.05),
    maxBotRate: num("S2_MAX_BOT_RATE", 0.7),
  },

  // ---- Stage 3: deep dive (/v1/token/info + values carried from rank) ----
  s3: {
    maxRugRatio: num("S3_MAX_RUG_RATIO", 0.5),
    maxEntrapment: num("S3_MAX_ENTRAPMENT", 0.3),
    maxTop10Rate: num("S3_MAX_TOP10_RATE", 0.3),
    maxDevHoldRate: num("S3_MAX_DEV_HOLD_RATE", 0.05),
    maxBundlerTraderPct: num("S3_MAX_BUNDLER_TRADER_PCT", 0.3),
    // KOL presence: renowned + smart wallets holding the token.
    minKolPlusSmart: num("S3_MIN_KOL_PLUS_SMART", 1),
    // Social duplicates: how many OTHER tokens reuse this image / twitter / website.
    maxImageDup: num("S3_MAX_IMAGE_DUP", 0),
    maxTwitterDup: num("S3_MAX_TWITTER_DUP", 0),
    maxWebsiteDup: num("S3_MAX_WEBSITE_DUP", 0),
  },

  // ---- Stage 4: journal ----
  journalHours: num("JOURNAL_HOURS", 6),
};

export type PipelineConfig = typeof cfg;
