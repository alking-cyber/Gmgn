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
