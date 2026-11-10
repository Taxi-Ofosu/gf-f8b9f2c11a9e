/* Breakout-strategie voor goud op 1H (zelfde regels als goldfib/breakout.py).
 *
 * - weekenduren (goudmarkt dicht) tellen niet mee: PAXG handelt 24/7, echt goud niet;
 * - BUY als een candle sluit boven de hoogste high van de vorige 150 candles (SELL: onder de
 *   laagste low); alleen de eerste candle die uitbreekt telt;
 * - instap op de open van de volgende candle, stop-loss 1x ATR(14), take-profit 5x ATR;
 * - na max. 96 candles zonder SL/TP sluiten; SL en TP in één candle = SL; één trade tegelijk.
 */
(function (root) {
  "use strict";
  const G = root.GoldFib;
  const BO = { lookback: 150, slAtr: 1, tpAtr: 5, maxBars: 96, cost: 0.30 };

  // Goudmarkt dicht (UTC): vrijdag vanaf 21u, zaterdag, zondag voor 22u.
  function marketClosed(time) {
    const d = new Date(time * 1000), day = d.getUTCDay(), h = d.getUTCHours();
    return (day === 5 && h >= 21) || day === 6 || (day === 0 && h < 22);
  }

  const dropWeekend = (candles) => candles.filter((c) => !marketClosed(c.time));

  function plan(sig, entry) {
    const d = sig.direction === "BUY" ? 1 : -1;
    return { sl: entry - d * BO.slAtr * sig.atr, tp: entry + d * BO.tpAtr * sig.atr };
  }

  // Huidige grenzen: hoogste high en laagste low van de laatste `lookback` candles.
  function range(candles, end = candles.length) {
    let hi = -Infinity, lo = Infinity;
    for (let i = Math.max(0, end - BO.lookback); i < end; i++) {
      hi = Math.max(hi, candles[i].high);
      lo = Math.min(lo, candles[i].low);
    }
    return { hi, lo };
  }

  function findBreakouts(candles) {
    const n = candles.length;
    const a = G.atr(candles.map((c) => c.high), candles.map((c) => c.low), candles.map((c) => c.close), 14);
    const out = [];
    let prevUp = false, prevDn = false;
    for (let t = 0; t < n; t++) {
      let up = false, dn = false, hi = NaN, lo = NaN;
      if (t >= BO.lookback) {
        ({ hi, lo } = range(candles, t));
        up = candles[t].close > hi;
        dn = candles[t].close < lo;
      }
      if (Number.isFinite(a[t]) && ((up && !prevUp) || (dn && !prevDn))) {
        const buy = up && !prevUp;
        out.push({ bar: t, time: candles[t].time, direction: buy ? "BUY" : "SELL",
          close: candles[t].close, level: buy ? hi : lo, atr: a[t] });
      }
      prevUp = up; prevDn = dn;
    }
    return out;
  }

  function simulate(candles, signals, accountSize, riskPct) {
    const n = candles.length;
    const trades = [];
    let busy = -1;
    for (const s of signals) {
      const e = s.bar + 1;
      if (e >= n || s.bar <= busy) continue;
      const d = s.direction === "BUY" ? 1 : -1;
      const entry = candles[e].open + d * BO.cost;
      const { sl, tp } = plan(s, entry);
      const risk = BO.slAtr * s.atr;
      let outcome = "open", exit = candles[n - 1].close, j = e, done = false;
      const last = Math.min(n, e + BO.maxBars);
      for (j = e; j < last; j++) {
        const c = candles[j];
        if (d === 1 ? c.low <= sl : c.high >= sl) {
          exit = d === 1 ? Math.min(sl, c.open) : Math.max(sl, c.open); // gat over de stop
          outcome = "SL"; done = true; break;
        }
        if (d === 1 ? c.high >= tp : c.low <= tp) { exit = tp; outcome = "TP"; done = true; break; }
      }
      if (!done) {
        j = last - 1;
        if (e + BO.maxBars <= n) { outcome = "tijd"; exit = candles[j].close; }
        else { j = n - 1; exit = candles[j].close; }
      }
      busy = j;
      trades.push({ signal: s, signalTime: s.time, entryTime: candles[e].time, exitTime: candles[j].time,
        direction: s.direction, entry, sl, tp, outcome, r: (exit - entry) * d / risk, open: outcome === "open" });
    }
    const equity = [accountSize];
    let balance = accountSize, peak = accountSize, dd = 0;
    for (const t of trades) {
      if (t.open) continue;
      balance *= 1 + riskPct / 100 * t.r;
      equity.push(balance);
      peak = Math.max(peak, balance);
      dd = Math.min(dd, (balance - peak) / peak);
    }
    const closed = trades.filter((t) => !t.open);
    const rs = closed.map((t) => t.r);
    const sum = (x) => x.reduce((p, q) => p + q, 0);
    const gains = sum(rs.filter((r) => r > 0)), losses = -sum(rs.filter((r) => r < 0));
    let streak = 0, worst = 0;
    for (const r of rs) { streak = r < 0 ? streak + 1 : 0; worst = Math.max(worst, streak); }
    const stats = {
      trades: rs.length,
      winrate: rs.length ? rs.filter((r) => r > 0).length / rs.length * 100 : 0,
      avgR: rs.length ? sum(rs) / rs.length : 0,
      totalR: sum(rs),
      profitFactor: losses > 0 ? gains / losses : Infinity,
      maxDrawdown: -dd * 100,
      returnPct: (balance / accountSize - 1) * 100,
      worstStreak: worst,
    };
    return { trades, equity, stats };
  }

  root.Breakout = { BO, marketClosed, dropWeekend, findBreakouts, simulate, plan, range };
})(this);
