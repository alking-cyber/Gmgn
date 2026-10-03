/**
 * pm2 config: runs the paper-trading and tracking jobs in the background on Windows, macOS or Linux.
 *
 *   pm2 start pipeline/ecosystem.config.cjs            # all three
 *   pm2 start pipeline/ecosystem.config.cjs --only early
 *   pm2 logs / pm2 status / pm2 stop all
 *
 * All three share one API key, and the Free plan allows about 5 units/s per key and IP (faster
 * calls draw 30-second bans). The rates below add up to about 2.6 units/s. On a paid plan
 * (Plus 20, Pro 50) raise GMGN_RATE_LIMIT / TRACK_RATE_LIMIT and remove KLINE_MIN_GAP_MS.
 * Keep only GMGN_API_KEY in ~/.config/gmgn/.env: values set there override the ones below.
 */
const path = require("node:path");

const root = path.join(__dirname, "..");
// node loads tsx in-process (--import) instead of the tsx CLI, which starts a second node process
// that opens its own console window on Windows
const job = (name, script, args, env) => ({
  name,
  cwd: root,
  script: path.join(root, script),
  args,
  interpreter: "node",
  node_args: ["--import", "tsx"],
  windowsHide: true,
  autorestart: true,
  restart_delay: 30_000,
  env: { KLINE_MIN_GAP_MS: "2500", ...env },
});

module.exports = {
  apps: [
    // paper trading, entry at the first $10K cross (the priority: it needs speed)
    job("early", "pipeline/run.ts", "--profile early", { GMGN_RATE_LIMIT: "1.5" }),
    // paper trading, entry at the $100K cross through the runner gate (lost out of sample; optional)
    job("loose", "pipeline/run.ts", "--profile loose", { GMGN_RATE_LIMIT: "1" }),
    // records every $100K cross and checks it 7 days later (runner rate)
    job("runners", "pipeline/runner-tracker.ts", "", { TRACK_RATE_LIMIT: "0.8" }),
  ],
};
