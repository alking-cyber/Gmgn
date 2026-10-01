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

/**
 * PIPELINE_PROFILE picks a set of defaults; any variable below still overrides it.
 *   trending  (default) established trending tokens, the 4-stage design from the post
 *   newlaunch launchpad tokens under an hour old in a small market-cap band, alerting
 *             only when smart money / KOLs still hold and the holder base is not underwater
 *   loose     the replay-tested runner strategy: launchpad tokens under an hour old that crossed
 *             $100K market cap, entered only if that cross passes the runner gate and the funding
 *             checks (gate.ts); paper-traded with half sold at +100% and half held to −30% from
 *             entry (break-even in the replay blend at one $10M runner per 100 trades — unproven
 *             live, which is what the paper trading and `pipeline:runners` are for)
 */
const PROFILE = process.env.PIPELINE_PROFILE || "trending";
if (!["trending", "newlaunch", "loose"].includes(PROFILE)) {
  throw new Error(`PIPELINE_PROFILE must be "trending", "newlaunch" or "loose", got "${PROFILE}"`);
}
/** Profile-dependent default: `t` for trending, `nl` for newlaunch, `lo` for loose (defaults to `nl`). */
function pd<T>(t: T, nl: T, lo: T = nl): T {
  return PROFILE === "trending" ? t : PROFILE === "newlaunch" ? nl : lo;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v == null || v === "") return def;
  return v === "1" || v.toLowerCase() === "true";
}

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
  profile: PROFILE,
  chain: str("PIPELINE_CHAIN", "sol"),
  dataDir: str("PIPELINE_DATA_DIR", new URL(pd("./data", "./data-newlaunch", "./data-loose"), import.meta.url).pathname),
  scanIntervalSec: num("SCAN_INTERVAL_SEC", pd(30, 20)),
  journalIntervalSec: num("JOURNAL_INTERVAL_SEC", 30),
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || "",

  // ---- Stage 1: discovery ----
  // "rank" polls /v1/market/rank; "trenches" polls launchpad lists (/v1/trenches).
  source: str("PIPELINE_SOURCE", pd("rank", "trenches")) as "rank" | "trenches",
  // Trenches query. The band is wider than the entry band in s1 so tokens stay
  // visible (and trackable) after they move out of it.
  trenches: {
    types: list("TRENCH_TYPES", ["new_creation", "near_completion", "completed"]),
    limit: num("TRENCH_LIMIT", 80),
    minMcap: num("TRENCH_MIN_MCAP", pd(10_000, 10_000, 80_000)),
    maxMcap: num("TRENCH_MAX_MCAP", pd(300_000, 300_000, 1_000_000)),
    maxCreated: str("TRENCH_MAX_CREATED", "120m"),
    // Launchpads the service leaves out of its default list, polled with one extra call each.
    // stonkfun is not in the default list, yet it launched 7 of the 15 tokens that ran from
    // $100K to $10M+ in the 30 days before 2026-10-01. Empty to skip.
    extraPlatforms: list("TRENCH_EXTRA_PLATFORMS", ["stonkfun"]),
  },
  // Each scan polls every interval below and merges the results.
  rankIntervals: list("RANK_INTERVALS", ["1m", "5m"]),
  rankLimit: num("RANK_LIMIT", 100),
  // Server-side age cap so the universe is fresh tokens only.
  rankMaxCreated: str("RANK_MAX_CREATED", "24h"),
  // A value of 0 turns a "max" rule off (and 1 for rate caps).
  s1: {
    minAgeMin: num("S1_MIN_AGE_MIN", pd(5, 2)),
    maxAgeMin: num("S1_MAX_AGE_MIN", pd(24 * 60, 60)),
    minHolders: num("S1_MIN_HOLDERS", pd(150, 80, 50)),
    minLiquidityUsd: num("S1_MIN_LIQUIDITY_USD", pd(10_000, 8_000, 5_000)),
    // loose: the tested entry is the first $100K cross (checked by the runner gate in stage 3)
    minMcap: num("S1_MIN_MCAP", pd(0, 30_000, 100_000)),
    maxMcap: num("S1_MAX_MCAP", pd(0, 60_000, 1_000_000)),
    maxTop10Rate: num("S1_MAX_TOP10_RATE", pd(0.3, 0.3, 0.7)),
    maxDevHoldRate: num("S1_MAX_DEV_HOLD_RATE", pd(0.05, 0.05, 0.3)),
    maxBundlerRate: num("S1_MAX_BUNDLER_RATE", pd(1, 0.3, 1)),
    maxSniperHoldRate: num("S1_MAX_SNIPER_HOLD_RATE", pd(1, 0.15, 1)),
    maxInsiderRate: num("S1_MAX_INSIDER_RATE", pd(1, 0.15, 1)),
    maxRugRatio: num("S1_MAX_RUG_RATIO", pd(1, 0.3, 1)),
    // Serial launchers: creators with this many tokens or more are skipped.
    maxDevTokens: num("S1_MAX_DEV_TOKENS", pd(0, 10, 0)),
    // "leader": a token sharing image/twitter/website with others passes only if it has
    // the most holders among the same-symbol tokens in the scan (the original of a narrative).
    copycat: str("S1_COPYCAT", pd("off", "leader", "off")) as "off" | "leader",
  },

  // ---- Stage 2: tracking (across repeated rank scans) ----
  s2: {
    minObservations: num("S2_MIN_OBSERVATIONS", pd(4, 3)),
    minTrackSec: num("S2_MIN_TRACK_SEC", pd(120, 40)),
    maxTrackSec: num("S2_MAX_TRACK_SEC", pd(30 * 60, 10 * 60)),
    maxMissedScans: num("S2_MAX_MISSED_SCANS", 3),
    minHolderGrowthPct: num("S2_MIN_HOLDER_GROWTH_PCT", pd(2, 2, -100)),
    maxHolderDropPct: num("S2_MAX_HOLDER_DROP_PCT", pd(5, 5, 100)),
    maxLiquidityDropPct: num("S2_MAX_LIQUIDITY_DROP_PCT", 25),
    minBuySellRatio: num("S2_MIN_BUY_SELL_RATIO", pd(1, 1, 0)),
    maxBundlerRate: num("S2_MAX_BUNDLER_RATE", pd(0.3, 0.3, 1)),
    maxBundlerRise: num("S2_MAX_BUNDLER_RISE", pd(0.05, 0.05, 1)),
    maxBotRate: num("S2_MAX_BOT_RATE", pd(0.7, 0.7, 1)),
  },

  // ---- Stage 3: deep dive (/v1/token/info + values carried from rank) ----
  s3: {
    maxRugRatio: num("S3_MAX_RUG_RATIO", pd(0.5, 0.5, 1)),
    maxEntrapment: num("S3_MAX_ENTRAPMENT", pd(0.3, 0.3, 1)),
    maxTop10Rate: num("S3_MAX_TOP10_RATE", pd(0.3, 0.3, 1)),
    maxDevHoldRate: num("S3_MAX_DEV_HOLD_RATE", pd(0.05, 0.05, 1)),
    maxBundlerTraderPct: num("S3_MAX_BUNDLER_TRADER_PCT", pd(0.3, 0.3, 1)),
    // KOL presence: renowned + smart wallets holding the token.
    minKolPlusSmart: num("S3_MIN_KOL_PLUS_SMART", pd(1, 1, 0)),
    // Social duplicates: how many OTHER tokens reuse this image / twitter / website.
    // newlaunch handles copycats in stage 1 (S1_COPYCAT=leader), so these are off there.
    maxImageDup: num("S3_MAX_IMAGE_DUP", pd(0, Infinity)),
    maxTwitterDup: num("S3_MAX_TWITTER_DUP", pd(0, Infinity)),
    maxWebsiteDup: num("S3_MAX_WEBSITE_DUP", pd(0, Infinity)),
    maxDevTokens: num("S3_MAX_DEV_TOKENS", pd(0, 10, 0)),
    // Holder checks (need /v1/market/token_top_holders; 0 = off):
    // smart money / KOL wallets still holding more than holderMinUsd,
    minHoldingSmart: num("S3_MIN_HOLDING_SMART", pd(0, 2, 0)),
    holderMinUsd: num("S3_HOLDER_MIN_USD", 20),
    // median entry of the top 20 holders at most this multiple of the current market cap
    // (above 1 the holder base is underwater and sells into every bounce),
    maxTop20EntryMult: num("S3_MAX_TOP20_ENTRY_MULT", pd(0, 1.3, 0)),
    // and no single non-pool wallet above this share of supply.
    maxSingleHolderPct: num("S3_MAX_SINGLE_HOLDER_PCT", pd(0, 0.15, 0)),
    // Runner gate (gate.ts) at the token's first $100K cross: volume, not instant, not vertical,
    // not a bot ramp; plus the wallet-funding checks (wallets funded together / by one funder).
    runnerGate: bool("S3_RUNNER_GATE", pd(false, false, true)),
    fundingCheck: bool("S3_FUNDING_CHECK", pd(false, false, true)),
    maxChaseMult: num("S3_MAX_CHASE_MULT", 2), // skip when market cap is already above 2x the cross
  },

  // ---- Stage 4: journal ----
  journalHours: num("JOURNAL_HOURS", pd(6, 6, 3)),
  // false: only journal alerts that hold a paper position (loose alerts far too often to poll them all)
  journalAllAlerts: bool("JOURNAL_ALL_ALERTS", pd(true, true, false)),

  // ---- Paper trading: simulated positions on every alert, no real orders ----
  paper: {
    enabled: bool("PAPER", pd(false, false, true)),
    startCapital: num("PAPER_CAPITAL", 140),
    positionPct: num("PAPER_POSITION_PCT", 0.1), // share of equity per trade
    maxOpen: num("PAPER_MAX_OPEN", 8), // alerts arriving while this many are open are skipped
    takeProfit: num("PAPER_TP", 2.0), // multiple of entry: 2.0 = +100%
    stopLoss: num("PAPER_SL", 0.7), // multiple of entry: 0.7 = -30%
    maxHoldMin: num("PAPER_MAX_HOLD_MIN", 180),
    costPct: num("PAPER_COST_PCT", 1.5), // slippage + fee, charged on entry and exit
    // Runner hold: at the take-profit sell half and keep half with no target, so a runner can pay for the losers
    runner: {
      enabled: bool("PAPER_RUNNER", pd(false, false, true)),
      keepPct: num("RUNNER_KEEP_PCT", 0.5), // share kept; the rest is sold at the take-profit
      stopX: num("RUNNER_STOP_X", 0.7), // kept part exits at this multiple of the entry price (0.7 = -30%)
      maxHoldMin: num("RUNNER_MAX_HOLD_MIN", 7 * 1440), // ...or after this long
      pollSec: num("RUNNER_POLL_SEC", 300), // kept parts are priced every 5 minutes, not every journal tick
      // optional, off by default (0 / false): keep only strong tokens, extra exits
      minHolderGrowth: num("RUNNER_MIN_HOLDER_GROWTH", 0), // e.g. 0.2 = holders up 20% since the buy
      minVolume5m: num("RUNNER_MIN_VOLUME_5M", 0), // e.g. 30000 = $30K traded in the last 5 minutes
      smartNotFewer: bool("RUNNER_SMART_NOT_FEWER", false),
      trailPct: num("RUNNER_TRAIL_PCT", 0), // e.g. 0.3 = also exit 30% below the high
      holderDropPct: num("RUNNER_HOLDER_DROP_PCT", 0), // e.g. 0.15 = also exit when holders fall 15% from their high
    },
  },
};

export type PipelineConfig = typeof cfg;
