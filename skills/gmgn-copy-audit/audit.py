#!/usr/bin/env python3
"""
gmgn-copy-audit — "am I buying their exit?"

One question, asked of one wallet the user is tempted to copy RIGHT NOW: if I buy what
it holds today, at today's price, with a smaller wallet and slower hands, do I have an
edge, or am I the liquidity it sells into?

It does not rank the trader. A huge PnL is not evidence here. It measures:
  timing       first buy vs. the buy you are looking at — a thesis, or an add after the pump
  track record how many tokens made the PnL; one coin > 60% is a lottery ticket
  speed        swaps/day and average hold — above 20/day or under 24h cannot be copied by hand
  entry gap    current price / their average entry, per open position: <2x, 2-10x, >10x
  exits        cost recovery, ladder vs. one click, riding losers — the only transferable habit
  thesis       optional: price at the time of their post vs. their first entry
  red flags    tries to kill the copy and names the single fact that ends it

Usage (live):
    python3 audit.py <wallet> <chain> [--thesis-at <unix> --thesis-token <address>]
Usage (offline, for verification):
    python3 audit.py --fixture <file.json>

Read-only. Never signs, never trades, never says buy.
"""

import json
import math
import statistics
import subprocess
import sys
import time

MIN_OPEN_USD = 50.0          # below this an open position is dust, not something to copy
FIRST_BUY_LOOKUPS = 2        # per-token buy history pulls (weight 3 each)
LOTTERY_SHARE = 0.60         # one token above this share of profit = lottery ticket
MAX_SWAPS_PER_DAY = 20.0
MIN_HOLD_S = 86400.0
YOUNG_DAYS = 30
EXIT_IMPACT = 0.20           # their position / pool liquidity — their exit alone moves the pool
ADD_AFTER_PUMP = 2.0         # latest visible buy at >= 2x the first buy = an add, not a thesis
THESIS_MARKETING = 5.0       # post written after a 5x = marketing


class Gap(Exception):
    pass


# ─────────────────────────── plumbing ───────────────────────────


def f(v, default=0.0):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    return x if x == x else default


def i(v, default=0):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def cli(args, timeout=45):
    r = subprocess.run(["gmgn-cli"] + args + ["--raw"], capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise Gap((r.stderr or r.stdout or "gmgn-cli failed").strip()[:300])
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        raise Gap("non-JSON response from gmgn-cli")


def unwrap(resp):
    if isinstance(resp, dict) and "data" in resp:
        return resp["data"]
    return resp


def first_row(resp):
    d = unwrap(resp)
    if isinstance(d, dict) and isinstance(d.get("list"), list):
        return d["list"][0] if d["list"] else {}
    if isinstance(d, list):
        return d[0] if d else {}
    return d if isinstance(d, dict) else {}


def ev_type(a):
    return str(a.get("event_type") or a.get("type") or "").lower()


def tok_addr(a):
    t = a.get("token") or {}
    return t.get("address") or t.get("token_address") or ""


def usd(v):
    v = f(v)
    s = "-" if v < 0 else ""
    v = abs(v)
    if v >= 1e9:
        return f"{s}${v / 1e9:.2f}B"
    if v >= 1e6:
        return f"{s}${v / 1e6:.2f}M"
    if v >= 1e3:
        return f"{s}${v / 1e3:.1f}K"
    if v >= 1:
        return f"{s}${v:,.2f}"
    return f"{s}${v:.3g}"


def price(v):
    v = f(v)
    if v <= 0:
        return "$0"
    if v >= 1:
        return f"${v:,.4f}".rstrip("0").rstrip(".")
    digits = max(2, -math.floor(math.log10(v)) + 3)
    return "$" + f"{v:.{digits}f}".rstrip("0").rstrip(".")


def pct(x, digits=0):
    return f"{x * 100:+.{digits}f}%"


def share(x):
    return f"{x * 100:.0f}%"


def mult(x):
    if x is None:
        return "n/a"
    return f"{x:.1f}x" if x < 100 else f"{x:,.0f}x"


def dur(sec):
    sec = f(sec)
    if sec < 60:
        return f"{sec:.0f}s"
    if sec < 3600:
        return f"{sec / 60:.0f}m"
    if sec < 86400:
        return f"{sec / 3600:.1f}h"
    return f"{sec / 86400:.1f}d"


def day(ts):
    return time.strftime("%Y-%m-%d", time.gmtime(ts)) if ts else "not visible"


def safe_div(a, b):
    return a / b if b else None


# ─────────────────────────── data pull ───────────────────────────


def buy_history(chain, wallet, addr):
    raw = unwrap(cli(["portfolio", "activity", "--chain", chain, "--wallet", wallet,
                      "--token", addr, "--type", "buy", "--limit", "100"]))
    return (raw or {}).get("activities") or []


def collect(chain, wallet, thesis_token, gaps):
    """Weight budget (bucket 20 on Plus): stats_7d 3 + profits_all 3 + holdings 5 = 11,
    first-buy lookups 2 x 3 = 17, activity 3 = 20. stats_30d, thesis kline and
    created-tokens are best-effort depth after that."""
    d = {"first_buys": {}}
    d["stats_7d"] = first_row(cli(["portfolio", "stats", "--chain", chain, "--wallet", wallet, "--period", "7d"]))

    try:
        d["profits_all"] = first_row(cli(["portfolio", "profits", "--chain", chain, "--wallet", wallet, "--period", "all"]))
    except Gap as e:
        d["profits_all"] = {}
        gaps.append(f"all-time profits not visible ({e})")

    # Closed positions are included so the profit concentration covers every coin that
    # produced the PnL, not only the ones still held.
    try:
        raw = unwrap(cli(["portfolio", "holdings", "--chain", chain, "--wallet", wallet, "--limit", "50",
                          "--order-by", "total_profit", "--direction", "desc", "--hide-closed", "false"]))
        d["holdings"] = (raw or {}).get("list") or []
    except Gap as e:
        d["holdings"] = None
        txt = str(e)
        if "429" in txt or "RATE_LIMIT" in txt:
            gaps.append(f"holdings refused by the rate limiter ({e}) — re-run after the reset")
        elif "SIGNATURE_INVALID" in txt:
            gaps.append(f"holdings refused: GMGN_PRIVATE_KEY is set but its signature was rejected ({e})")
        else:
            gaps.append(f"holdings not visible — needs GMGN_PRIVATE_KEY (critical auth) ({e})")

    opens = open_positions(d["holdings"] or [])
    wanted = [p["addr"] for p in opens[:FIRST_BUY_LOOKUPS]]
    if thesis_token and thesis_token not in wanted:
        wanted.append(thesis_token)
    for addr in wanted:
        try:
            d["first_buys"][addr] = buy_history(chain, wallet, addr)
        except Gap as e:
            gaps.append(f"buy history for {addr[:8]}… not visible ({e})")

    try:
        raw = unwrap(cli(["portfolio", "activity", "--chain", chain, "--wallet", wallet, "--limit", "100"]))
        d["activity"] = (raw or {}).get("activities") or []
    except Gap as e:
        d["activity"] = None
        gaps.append(f"recent activity not visible — 24h trims unchecked ({e})")

    try:
        d["stats_30d"] = first_row(cli(["portfolio", "stats", "--chain", chain, "--wallet", wallet, "--period", "30d"]))
    except Gap as e:
        d["stats_30d"] = {}
        gaps.append(f"30D stats not visible ({e})")

    # Only pay for created-tokens when a held coin carries the trader's name.
    if named_after(d["holdings"] or [], (d["stats_7d"].get("common") or {})):
        try:
            d["created_tokens"] = unwrap(cli(["portfolio", "created-tokens", "--chain", chain, "--wallet", wallet]))
        except Gap as e:
            d["created_tokens"] = None
            gaps.append(f"created-tokens not visible — name-match launch check skipped ({e})")
    return d


def thesis_price(chain, addr, at, gaps):
    try:
        raw = unwrap(cli(["market", "kline", "--chain", chain, "--address", addr, "--resolution", "5m",
                          "--from", str(at - 900), "--to", str(at + 900)]))
    except Gap as e:
        gaps.append(f"price at the thesis time not visible ({e})")
        return None
    rows = raw.get("list") if isinstance(raw, dict) else raw
    rows = [r for r in (rows or []) if isinstance(r, dict) and f(r.get("close")) > 0]
    if not rows:
        gaps.append("no candles around the thesis time")
        return None
    return f(min(rows, key=lambda r: abs(i(r.get("time")) - at)).get("close"))


# ─────────────────────────── metrics ───────────────────────────


def position(row):
    tok = row.get("token") or {}
    bal = f(row.get("balance"))
    accu = f(row.get("accu_cost"))
    avg_entry = accu / bal if bal > 0 and accu > 0 else None
    px = f(tok.get("price"))
    return {
        "addr": tok.get("token_address") or tok.get("address") or "",
        "symbol": str(tok.get("symbol") or "?")[:24],
        "name": str(tok.get("name") or ""),
        "price": px,
        "balance": bal,
        "usd_value": f(row.get("usd_value")),
        "avg_entry": avg_entry,
        "gap": (px / avg_entry) if avg_entry and px > 0 else None,
        "bought": f(row.get("history_bought_cost")),
        "sold": f(row.get("history_sold_income")),
        "realized": f(row.get("realized_profit")),
        "total_profit": f(row.get("total_profit")),
        "pnl": f(row.get("total_profit_pnl")),
        "buys": i(row.get("history_total_buys")),
        "sells": i(row.get("history_total_sells")),
        "start": i(row.get("start_holding_at")),
        "liquidity": f(tok.get("liquidity")),
        "supply": f(tok.get("total_supply")),
    }


def open_positions(rows):
    ps = [position(r) for r in rows]
    ps = [p for p in ps if p["balance"] > 0 and p["usd_value"] >= MIN_OPEN_USD]
    return sorted(ps, key=lambda p: -p["usd_value"])


def handle_words(common):
    out = []
    for k in ("twitter_username", "name", "twitter_name"):
        w = str(common.get(k) or "").strip().lstrip("@").lower()
        if len(w) >= 3 and w not in out:
            out.append(w)
    return out


def named_after(rows, common):
    words = handle_words(common)
    hits = []
    for r in rows:
        p = position(r)
        label = f"{p['symbol']} {p['name']}".lower()
        if any(w in label for w in words):
            hits.append(p)
    return hits


def timing(p, buys):
    """First buy vs. latest buy for one open position."""
    t = {"first_ts": None, "first_px": None, "last_px": None, "complete": False, "n": len(buys)}
    rows = [b for b in buys if i(b.get("timestamp")) and f(b.get("price_usd")) > 0]
    if not rows:
        return t
    first = min(rows, key=lambda b: i(b.get("timestamp")))
    last = max(rows, key=lambda b: i(b.get("timestamp")))
    t["first_ts"] = i(first.get("timestamp"))
    t["first_px"] = f(first.get("price_usd"))
    t["last_px"] = f(last.get("price_usd"))
    # A full page whose oldest row is well after the position opened has not reached the
    # first buy — the "first" we see is itself a later add.
    t["complete"] = len(buys) < 100 or (p["start"] and t["first_ts"] <= p["start"] + 3600)
    t["since_first"] = p["price"] / t["first_px"] if p["price"] > 0 else None
    t["add_ratio"] = t["last_px"] / t["first_px"]
    return t


def roi(row, cost_keys, profit_key):
    if not row:
        return None
    cost = next((f(row.get(k)) for k in cost_keys if f(row.get(k)) > 0), 0.0)
    return f(row.get(profit_key)) / cost if cost > 0 else None


def compute(d, now):
    m = {"gaps": d.get("gaps", [])}
    s7 = d.get("stats_7d") or {}
    s30 = d.get("stats_30d") or {}
    pall = d.get("profits_all") or {}
    pnl = s7.get("pnl_stat") or {}
    common = s7.get("common") or {}

    m["handle"] = common.get("twitter_username") or common.get("name") or ""
    m["created_at"] = i(common.get("created_at"))
    m["age_days"] = (now - m["created_at"]) / 86400 if m["created_at"] else None
    m["trades_all"] = i(pall.get("buy")) + i(pall.get("sell")) if pall else None

    buys7 = i(s7.get("buy", s7.get("buy_count")))
    sells7 = i(s7.get("sell", s7.get("sell_count")))
    m["active_7d"] = buys7 + sells7 > 0 or i(pnl.get("token_num")) > 0
    m["per_day"] = (buys7 + sells7) / 7.0
    m["avg_hold"] = f(pnl.get("avg_holding_period")) or None
    m["avg_buy"] = safe_div(f(s7.get("bought_cost", s7.get("total_cost"))), buys7)
    m["speed_bad"] = m["per_day"] > MAX_SWAPS_PER_DAY or (m["avg_hold"] is not None and m["avg_hold"] < MIN_HOLD_S)

    m["roi_7d"] = roi(s7, ("bought_cost", "total_cost"), "realized_profit")
    m["roi_30d"] = roi(s30, ("bought_cost", "total_cost"), "realized_profit")
    m["roi_all"] = roi(pall, ("total_realized_profit_cost",), "total_realized_profit")
    r7, r30, ra = m["roi_7d"], m["roi_30d"], m["roi_all"]
    m["cooled"] = ra is not None and r7 is not None and ra > 0.10 and r7 <= -0.10
    m["consistent"] = all(x is not None and x > 0 for x in (r7, r30, ra))

    # ── track record: how many coins made the money
    hold_rows = d.get("holdings")
    m["holdings_visible"] = hold_rows is not None
    allp = [position(r) for r in (hold_rows or [])]
    winners = sorted([p for p in allp if p["total_profit"] > 0], key=lambda p: -p["total_profit"])
    gain = sum(p["total_profit"] for p in winners)
    m["n_winners"] = len(winners)
    m["top"] = winners[0] if winners else None
    m["top_share"] = winners[0]["total_profit"] / gain if gain > 0 else None
    m["lottery"] = m["top_share"] is not None and m["top_share"] > LOTTERY_SHARE
    m["young_story"] = m["age_days"] is not None and m["age_days"] < YOUNG_DAYS and m["n_winners"] <= 2

    # ── open book
    opens = open_positions(hold_rows or [])
    fb = d.get("first_buys") or {}
    for p in opens:
        p["timing"] = timing(p, fb[p["addr"]]) if p["addr"] in fb else None
        p["impact"] = safe_div(p["usd_value"], p["liquidity"])
        p["entry_mcap"] = p["avg_entry"] * p["supply"] if p["avg_entry"] and p["supply"] else None
    m["opens"] = opens
    m["book"] = sum(p["usd_value"] for p in opens)

    acts = d.get("activity")
    m["activity_visible"] = acts is not None
    trimmed = {}
    for a in acts or []:
        if ev_type(a) == "sell" and now - i(a.get("timestamp")) <= 86400:
            trimmed[tok_addr(a)] = trimmed.get(tok_addr(a), 0.0) + f(a.get("cost_usd"))
    for p in opens:
        p["trim_24h"] = trimmed.get(p["addr"], 0.0)

    # ── exits
    sold = [p for p in allp if p["sells"] > 0]
    m["n_sold"] = len(sold)
    won = [p for p in allp if p["bought"] > 0 and (p["realized"] > 0 or p["total_profit"] > 0)]
    m["cost_out"] = safe_div(sum(1 for p in won if p["sold"] >= 0.95 * p["bought"]), len(won))
    m["house_money"] = sum(1 for p in won if p["sold"] >= 0.95 * p["bought"] and p["balance"] > 0)
    m["ladder"] = safe_div(sum(1 for p in sold if p["sells"] >= 3), len(sold))
    m["one_click"] = safe_div(sum(1 for p in sold if p["sells"] == 1), len(sold))
    m["med_sells"] = statistics.median([p["sells"] for p in sold]) if sold else None
    m["ridden_down"] = [p for p in allp if p["sells"] == 0 and p["bought"] > 0 and p["pnl"] <= -0.5]
    m["exit_good"] = (m["n_sold"] >= 3 and (m["cost_out"] or 0) >= 0.30
                      and (m["ladder"] or 0) >= 0.40 and len(m["ridden_down"]) < 3)
    m["exit_bad"] = m["n_sold"] >= 3 and ((m["one_click"] or 0) >= 0.60 or len(m["ridden_down"]) >= 3)

    # ── named after the trader, not launched by them
    ct = d.get("created_tokens")
    launched = set()
    if isinstance(ct, dict):
        launched = {str(t.get("token_address") or t.get("address") or "") for t in (ct.get("tokens") or [])}
    m["named"] = [p for p in named_after(hold_rows or [], common)
                  if ct is not None and p["addr"] not in launched]

    # ── thesis
    th = d.get("thesis")
    if th and th.get("price"):
        tb = timing({"price": th["price"], "start": 0}, fb.get(th["token"]) or [])
        th["first_px"] = tb["first_px"]
        th["first_ts"] = tb["first_ts"]
        th["move"] = th["price"] / tb["first_px"] if tb["first_px"] else None
        th["after_entry"] = tb["first_ts"] is not None and tb["first_ts"] < th["at"]
    m["thesis"] = th
    return m


# ─────────────────────────── judgement ───────────────────────────


def kill_facts(m):
    """Every measured fact that ends the copy, most decisive first."""
    k = []
    lead = m["opens"][0] if m["opens"] else None
    if m["speed_bad"]:
        k.append(f"{m['per_day']:.0f} swaps/day, avg hold {dur(m['avg_hold']) if m['avg_hold'] else 'not visible'} "
                 "— the trade can be over before you see the buy")
    if lead and lead["gap"] is not None and lead["gap"] > 10:
        k.append(f"their largest position {lead['symbol']} is {mult(lead['gap'])} above their entry — you are their liquidity")
    for p in m["opens"]:
        if p["trim_24h"] > 0:
            k.append(f"they sold {usd(p['trim_24h'])} of {p['symbol']} in the last 24h — the position you'd copy is being distributed")
            break
    if m["lottery"]:
        k.append(f"one coin ({m['top']['symbol']}) is {share(m['top_share'])} of the profit — a lottery ticket, not a system")
    if lead and lead.get("timing"):
        t = lead["timing"]
        if not t["complete"]:
            k.append(f"their first {lead['symbol']} buy is not in the visible history — every buy you can see is an add")
        elif t["add_ratio"] >= ADD_AFTER_PUMP:
            k.append(f"their latest {lead['symbol']} buy was at {mult(t['add_ratio'])} their first — you are copying an add, not a thesis")
    if m["young_story"]:
        k.append(f"a {m['age_days']:.0f}-day-old account with {m['n_winners']} winning coin(s) — a story, not a track record")
    if m["cooled"]:
        k.append(f"7D realized ROI {pct(m['roi_7d'])} against all-time {pct(m['roi_all'])} — the edge stopped working")
    if lead and lead["impact"] is not None and lead["impact"] >= EXIT_IMPACT:
        k.append(f"their {lead['symbol']} position is {share(lead['impact'])} of pool liquidity — their exit alone moves the price through you")
    th = m.get("thesis")
    if th and th.get("move") is not None and th["move"] >= THESIS_MARKETING:
        k.append(f"the thesis was posted after a {mult(th['move'])} from their first entry — marketing, not conviction")
    for p in m["named"]:
        k.append(f"{p['symbol']} is named after the trader but was not launched by this wallet")
        break
    return k


def underwater(m):
    """If this trader sold everything in the next hour, where would a copy opened now be?"""
    why = []
    lead = m["opens"][0] if m["opens"] else None
    if lead and lead["gap"] is not None and lead["gap"] >= 2:
        why.append(f"their {lead['symbol']} cost basis is {mult(lead['gap'])} below yours")
    if lead and lead["impact"] is not None and lead["impact"] >= 0.10:
        why.append(f"their exit is {share(lead['impact'])} of the {lead['symbol']} pool")
    if any(p["trim_24h"] > 0 for p in m["opens"][:3]):
        why.append("they are already selling")
    if m["speed_bad"]:
        why.append("they move faster than you can follow")
    return why


def verdict(m, kills):
    if not m["holdings_visible"] or not m["opens"]:
        conf = "low"
    elif m["gaps"]:
        conf = "medium"
    else:
        conf = "high"
    # Without the book the coin count is unknown, so a consistent curve alone earns STUDY.
    enough_coins = m["n_winners"] >= 5 or not m["holdings_visible"]
    transferable = m["exit_good"] or (m["consistent"] and not m["lottery"] and enough_coins)
    lead = m["opens"][0] if m["opens"] else None
    copyable = (not kills and lead is not None and lead["gap"] is not None and lead["gap"] < 2
                and conf != "low" and m["activity_visible"])
    if copyable:
        return "COPY", conf
    if transferable:
        return "STUDY", conf
    return "IGNORE", conf


def skill_line(m):
    parts = []
    for lbl, v in (("7D", m["roi_7d"]), ("30D", m["roi_30d"]), ("all-time", m["roi_all"])):
        parts.append(f"{lbl} {pct(v) if v is not None else 'not visible'}")
    curve = " / ".join(parts)
    age = f"{m['age_days']:.0f}d old" if m["age_days"] is not None else "age not visible"
    trades = f"{m['trades_all']:,} trades" if m["trades_all"] else "trade count not visible"
    if m["top_share"] is None:
        return f"NOT VISIBLE — no profitable positions visible ({curve}; {age}, {trades})"
    head = "LUCK" if m["lottery"] or m["young_story"] else ("SKILL" if m["consistent"] else "MIXED")
    return (f"{head} — {m['top']['symbol']} is {share(m['top_share'])} of profit across {m['n_winners']} "
            f"winning coins; {curve}; {age}, {trades}")


def speed_line(m):
    hold = dur(m["avg_hold"]) if m["avg_hold"] else "not visible"
    return f"{m['per_day']:.1f} swaps/day, avg hold {hold} — copyable: {'no' if m['speed_bad'] else 'yes'}"


def gap_band(g):
    if g is None:
        return "no cost basis visible (received by transfer, or cost not reported)"
    if g < 2:
        return "you are roughly where they are"
    if g <= 10:
        return "you are late; their stop is your loss"
    return "you are their liquidity"


def gap_lines(m):
    if not m["holdings_visible"]:
        return ["not visible — holdings need GMGN_PRIVATE_KEY"]
    if not m["opens"]:
        return [f"no open positions above {usd(MIN_OPEN_USD)} — nothing to copy right now"]
    out = []
    for p in m["opens"][:5]:
        line = (f"{p['symbol']}: avg entry {price(p['avg_entry']) if p['avg_entry'] else 'n/a'} → "
                f"now {price(p['price'])} = {mult(p['gap'])} ({gap_band(p['gap'])}); position {usd(p['usd_value'])}")
        t = p.get("timing")
        if t and t["first_ts"]:
            first = day(t["first_ts"]) if t["complete"] else f"before {day(t['first_ts'])}"
            line += f"; first buy {first}, price {mult(t['since_first'])} since"
        if p["trim_24h"] > 0:
            line += f"; sold {usd(p['trim_24h'])} in last 24h"
        out.append(line)
    if len(m["opens"]) > 5:
        out.append(f"+{len(m['opens']) - 5} smaller open positions")
    return out


def exit_line(m):
    if not m["holdings_visible"]:
        return "not visible — holdings need GMGN_PRIVATE_KEY"
    if m["n_sold"] < 3:
        return f"not visible — only {m['n_sold']} position(s) with sells"
    bits = [f"recovers cost on {share(m['cost_out'] or 0)} of winners",
            f"ladders (3+ sells) on {share(m['ladder'] or 0)}, one-click on {share(m['one_click'] or 0)} "
            f"(median {m['med_sells']:.0f} sells/position)"]
    if m["house_money"]:
        bits.append(f"{m['house_money']} position(s) riding house money")
    if m["ridden_down"]:
        bits.append(f"{len(m['ridden_down'])} held down 50%+ with zero sells")
    tail = "; round-tripped winners not visible (no peak data)"
    return "; ".join(bits) + tail


def worth_copying(m):
    if not m["holdings_visible"]:
        return "Not visible — the exit habit lives in their holdings, which need GMGN_PRIVATE_KEY."
    if m["exit_good"]:
        return (f"The exit: they take their cost out on {share(m['cost_out'])} of winners and ladder out over "
                f"~{m['med_sells']:.0f} sells — copy that rule, not their entries.")
    bands = sorted(p["entry_mcap"] for p in m["opens"] if p.get("entry_mcap"))
    if bands and not m["lottery"]:
        return (f"Their entry band: open positions were built around {usd(statistics.median(bands))} market cap — "
                "screen for that yourself, at your own pace.")
    if m["n_sold"] >= 3 and m["one_click"] is not None and m["one_click"] < 0.6 and not m["ridden_down"]:
        return "They do not hold losers to zero — the stop habit, not the picks."
    return "Nothing measurable transfers to a smaller wallet."


def walk_away(m, kills):
    if kills:
        return kills[0][0].upper() + kills[0][1:] + "."
    if not m["holdings_visible"]:
        return "Their open book is not visible — you cannot see what their cost is on the coin you'd buy."
    if m["opens"] and m["opens"][0]["gap"] is not None and m["opens"][0]["gap"] >= 2:
        p = m["opens"][0]
        return f"{p['symbol']} is already {mult(p['gap'])} over their entry: their stop is your loss."
    if m["avg_buy"]:
        return f"Nothing kills it yet — sizing above their average buy ({usd(m['avg_buy'])}) gets you worse fills than their record was built on."
    return "Nothing measured ends the copy; the confidence is what's missing."


def copying_what(m, kills):
    lead = m["opens"][0] if m["opens"] else None
    if not m["holdings_visible"]:
        return ("You cannot tell. Without their open book you would be copying a trade you cannot see the cost of — "
                "configure GMGN_PRIVATE_KEY and re-run before acting on anything.")
    if not lead:
        return "Nothing: they hold no open position worth following. Anything you buy now is your own trade, not a copy."
    what = "their first entry"
    t = lead.get("timing")
    if t and (not t["complete"] or t["add_ratio"] >= ADD_AFTER_PUMP):
        what = "an add made after the pump"
    if lead["trim_24h"] > 0:
        what = "a position they are already selling"
    s = (f"You are copying {what} in {lead['symbol']}, from someone sitting {mult(lead['gap'])} "
         f"on it with {usd(lead['usd_value'])} to sell")
    if lead["impact"] is not None and lead["impact"] >= 0.01:
        s += f" ({share(lead['impact'])} of the pool)"
    s += "."
    if m["speed_bad"]:
        s += f" They trade {m['per_day']:.0f} times a day, so by the time you see it the trade can be over."
    if m["lottery"]:
        s += f" The PnL that made them look good is mostly one coin ({m['top']['symbol']})."
    if not kills and lead["gap"] is not None and lead["gap"] < 2:
        s += " Today you would enter near their price — the edge, if it holds, is the same one they have."
    return s


def report(m):
    kills = kill_facts(m)
    v, conf = verdict(m, kills)
    uw = underwater(m)
    out = []
    if uw:
        out.append(f"UNDERWATER — if this trader sold everything in the next hour, a copy opened now would be underwater: "
                   f"{'; '.join(uw)}.")
        out.append("")
    out.append(f"VERDICT: {v} (confidence: {conf})")
    out.append(f"SKILL OR LUCK: {skill_line(m)}")
    out.append(f"SPEED: {speed_line(m)}")
    gl = gap_lines(m)
    if len(gl) == 1:
        out.append(f"ENTRY GAP: {gl[0]}")
    else:
        out.append("ENTRY GAP:")
        out += [f"  - {g}" for g in gl]
    out.append(f"EXIT HABIT: {exit_line(m)}")
    out.append(f"THE ONE THING WORTH COPYING: {worth_copying(m)}")
    out.append(f"REASON TO WALK AWAY: {walk_away(m, kills)}")

    out.append("")
    out.append("RED FLAGS (measured):")
    out += [f"  - {k}" for k in kills] or ["  - none measured"]
    th = m.get("thesis")
    if th is None:
        out.append("THESIS: not checked — pass the post's timestamp and token to test it")
    elif th.get("move") is None:
        out.append("THESIS: not visible — no price or first buy around the post")
    else:
        order = "after" if th["after_entry"] else "before"
        out.append(f"THESIS: posted {order} their first entry, at {mult(th['move'])} from it")
    if m["gaps"]:
        out.append("NOT VISIBLE:")
        out += [f"  - {g}" for g in m["gaps"]]

    out.append("")
    out.append("WHAT AM I ACTUALLY COPYING?")
    out.append(copying_what(m, kills))
    return "\n".join(out)


# ─────────────────────────── entry ───────────────────────────


def main(argv):
    args = list(argv)

    def opt(name):
        if name in args:
            k = args.index(name)
            val = args[k + 1] if k + 1 < len(args) else None
            del args[k:k + 2]
            return val
        return None

    fixture = opt("--fixture")
    thesis_at = opt("--thesis-at")
    thesis_token = opt("--thesis-token")
    if fixture:
        with open(fixture) as fh:
            d = json.load(fh)
        now = f(d.get("now")) or time.time()
    else:
        if len(args) < 2:
            print(__doc__.strip())
            return 2
        wallet, chain = args[0], args[1]
        gaps = []
        try:
            d = collect(chain, wallet, thesis_token, gaps)
        except Gap as e:
            print(f"Data pull failed, no verdict possible: {e}\n"
                  "Check `gmgn-cli config --check`; on 429 wait for the stated reset; "
                  "on 401/403 with valid credentials check IPv6 (gmgn-cli is IPv4 only).")
            return 1
        if thesis_at and thesis_token:
            at = i(thesis_at)
            d["thesis"] = {"at": at, "token": thesis_token, "price": thesis_price(chain, thesis_token, at, gaps)}
        d["gaps"] = gaps
        now = time.time()

    m = compute(d, now)
    if not m["active_7d"] and not (d.get("holdings") or []):
        print("NO READ — this address shows no trades and no positions. It may be a token contract, "
              "not a wallet, or an empty wallet. No verdict issued.")
        return 0
    print(report(m))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
