# Research plan: find a pipeline that actually predicts a rise

Handoff note for the next session (the GMGN API key is available there as `GMGN_API_KEY`).
The user is Indonesian-speaking; reply in Indonesian. Use `gmgn-cli` / `src/client` only for GMGN data.

## What is already known (from the user's live paper trading, 2026-10-02 .. 10-05)

- Early profile (buy the first $10K cross, <60 min old, 5m volume >= $5K): 40 alerts, 32 closed paper
  trades, win 4/32, median trade -57%, $50 -> $0.84 cash. Every exit rule replayed on the 40 alerts
  loses (best: sell all at +25%, stop -12%: -10%/trade). 15/40 rose +30% after the alert, 8/40 hit 2x,
  17/40 never rose above the alert price. Stops fill far below -30% (rugs inside seconds).
- GMGN purges dead tokens: trenches lists and kline data for dead / ungraduated tokens disappear within
  hours, and graduated pump.fun tokens return no bonding-curve candles. Any backtest on past lists is
  survivor-biased. Only forward recording is honest.
- Free plan: ~5 units/s per key and IP; repeated 429s ban the IP. The user's PC runs pm2 jobs `early`
  and `runners` on the same key (loose is stopped). Keep this research at <= 1.5 units/s.
- Most "missed runners" were missed because the bot was off or banned, not because of filters.

## What the user asked for

Research before building: (A) wallets with high win rate / high profit % that can be copied,
(B) narrative / hype signals (X is not readable for free; use GMGN's social proxies), and only then
assemble the best pipeline.

## Plan

1. Wallet discovery: take recent runners (trenches `completed`, now >= $100K), pull their early buyers
   (`token traders` / holders with tags), keep wallets that bought early in several runners, then score
   them (`portfolio stats`, wallet-score skill: win rate, 7d/30d PnL, hold time). Drop snipers (bought in
   the first seconds), dev/insider/bundler wallets: their edge is speed or inside info, not copyable.
2. Out-of-sample check: pick wallets on days 1-3, measure following their buys on days 4-7 with entry
   delay + slippage. Most leaderboard wallets fail this; only keep ones that pass.
3. Signal recorder (forward, no lookahead): every time a signal fires (`track smartmoney` / `track kol`
   buy, `market signal` event, `hot-searches` entry, chosen wallet buys), log the token's state at that
   moment (mcap, age, holders, smart/KOL counts, dev twitter rename/delete counts, liquidity, signal type)
   and its outcome 1h / 6h / 24h later (hit +30%, hit 2x, max drawdown first, dead). After ~7 days, rank
   signals and combinations by lift over the base rate, and by the result of a fixed exit rule.
4. Build the pipeline from the signals that survive step 3, then paper-trade it with a fixed $5 size
   (no compounding) next to the current early bot before any real money.

## Step 1 status (2026-10-06, first pass)

Script: `npm run research:wallets` (`research/wallets.ts`, 1.5 units/s; `--score` re-scores saved data
without fetching runners). Data is appended under `research/data/` (gitignored); the table is written to
`research/wallets-step1.md`. Run it every ~12h (runners stay in the rank for 2 days) to build the
day-by-day sample step 2 needs.

First pass: 45 runners (Solana, <= 2 days old, ATH >= $300K, holders >= 300, liquidity >= $10K, not wash),
4,861 trader rows (top 100 by profit + top 100 smart_degen per runner), 767 wallets with an early entry
(entry mcap <= $100K and <= ATH/3, >= 15s after launch, own money, no sniper/bundler/dev/insider tag),
120 of them early in >= 2 runners. Of those 120:
- 94 are one coordinated group (entered Open AI / AIKOL / NVIDIA within minutes of each other, ~6 tokens
  traded in 30d): a farm pumping its own tokens, not copyable. Flagged `cluster(n)`.
- 6 trade 1,500+ tokens a month (`bot-volume`): bots, not copyable.
- 20 clean wallets; 16 have positive 30d realized PnL, only 5 >= +10%, none above +30%. Win rates 25-50%.
  Best: 8E4N…eTdS (+25% 30d, 829 tokens, 4h avg hold), 6kzs…Wn9S (+18%, 101 tokens, swing, holds days),
  GgDA…ZorSt (+27%, 162 tokens), CTDH…hwE1 (+17%, 266 tokens).
- Caveats: wallets were chosen *because* they won on these runners (selection bias), and wallet_stats
  PnL is realized only. Nothing here is copyable until step 2 shows following them (with entry delay and
  slippage) still pays on days they were not chosen on.
- API notes: `/v1/user/wallet_stats` takes several addresses but answers only the first (one call per
  wallet, weight 3); `/v1/user/wallet_profits` does batch (PnL only, no win rate). Trenches `completed`
  covers only ~2h and is full of fake-mcap meteora tokens; the rank with `history_highest_market_cap`
  is the better runner source.

## Step 3 status (2026-10-06): signal recorder running

`npm run research:record` (`research/recorder.ts`, pm2 job `research`, 1.2 units/s) logs every signal
source as an arm with the token's state at the trigger; `npm run research:analyze` scores them
(`--by mcap|age|half`, `--arm <name>`, `--min <n>`). Arms: sm1/sm2/sm3 and kol1/kol2/kol3 (1st/2nd/3rd
distinct smart-money / KOL buyer within 15 min), sig<N> (GMGN market signal types), hot (enters the 1h
hot-search top 100), wallet (step-1 wallets buy), base_new/base_near/base_done (launchpad base rates).
Outcome: entry = 1m close at trigger + 30 s (or when the recorder saw it), 1m path to +1h, 5m to +6h;
purged tokens = total loss; five exit rules net of 6% round-trip cost.

Budget lessons: unsampled, the feeds fire ~4,300 events/h (ATH ticks alone ~1,500/h) — candles for all
would need ~3.6 units/s. So busy arms (base_*, sig1/3/6/7/8/10/18) keep a fixed 1/8 of tokens by address
hash, sm1/kol1 1/2, everything under $8K mcap at the trigger is skipped, and feed rows older than 5 min
are ignored (feeds replay old events on start). That runs at ~0.9 units/s. The feeds only reach back
1-4 minutes, so the recorder must run continuously; a stopped recorder is a hole, not a backlog.
