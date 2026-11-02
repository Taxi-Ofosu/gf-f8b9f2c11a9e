/* Fibonacci-strategie voor goud, in JavaScript (zelfde regels als goldfib/ in Python).
 *
 * De logica is één keer geschreven voor BUY-setups. SELL-setups gebruiken
 * dezelfde code op gespiegelde prijzen (alle prijzen x -1, high en low
 * omgewisseld). Zo zijn BUY en SELL gegarandeerd elkaars spiegelbeeld.
 *
 * Candles: arrays {time, open, high, low, close} met time in seconden (UTC).
 */
(function (root) {
  "use strict";

  const RETRACEMENTS = [0.236, 0.382, 0.5, 0.618, 0.786];
  const EXTENSIONS = [1.272, 1.618, 2.618];

  const DEFAULTS = {
    directions: "both", emaFast: 50, emaSlow: 200,
    pivotBars: 5, minSwingAtr: 1.5, maxSwingAge: 60, lookback: 150,
    atrPeriod: 14, rsiPeriod: 14, rsiThreshold: 40,
    slAtrBuffer: 0.5, minRr: 1.5, accountSize: 10000, riskPct: 1.0, ozPerLot: 100,
    roundNumberStep: 50, cost: 0.30,
  };

  // Python round(): bij precies .5 naar het even getal.
  function pyRound(x) {
    const f = Math.floor(x);
    const diff = x - f;
    if (diff === 0.5) return f % 2 === 0 ? f : f + 1;
    return Math.round(x);
  }

  // ---- Indicatoren ---------------------------------------------------------

  // Exponentieel gemiddelde zoals pandas ewm(adjust=False, min_periods).
  function ewm(values, alpha, minPeriods) {
    const out = new Array(values.length).fill(NaN);
    let prev = NaN, count = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      prev = count === 0 ? v : (1 - alpha) * prev + alpha * v;
      count++;
      if (count >= minPeriods) out[i] = prev;
    }
    return out;
  }

  function ema(values, period) {
    return ewm(values, 2 / (period + 1), period);
  }

  // Relative Strength Index volgens Wilder.
  function rsi(close, period) {
    const gain = [NaN], loss = [NaN];
    for (let i = 1; i < close.length; i++) {
      const d = close[i] - close[i - 1];
      gain.push(Math.max(d, 0));
      loss.push(Math.max(-d, 0));
    }
    const g = ewm(gain, 1 / period, period), l = ewm(loss, 1 / period, period);
    return g.map((gv, i) => {
      if (!Number.isFinite(gv)) return NaN;
      if (l[i] === 0) return 100;
      return 100 - 100 / (1 + gv / l[i]);
    });
  }

  // Average True Range volgens Wilder.
  function atr(high, low, close, period) {
    const tr = high.map((h, i) => i === 0
      ? h - low[i]
      : Math.max(h - low[i], Math.abs(h - close[i - 1]), Math.abs(low[i] - close[i - 1])));
    return ewm(tr, 1 / period, period);
  }

  // Indexen van pivot highs/lows: hoogste (laagste) punt van i-bars .. i+bars.
  // Een pivot is pas bevestigd op candle i+bars.
  function pivots(values, bars, kind) {
    const out = [];
    for (let i = bars; i < values.length - bars; i++) {
      let ext = values[i - bars];
      for (let k = i - bars + 1; k <= i + bars; k++) {
        ext = kind === "high" ? Math.max(ext, values[k]) : Math.min(ext, values[k]);
      }
      if (values[i] === ext) out.push(i);
    }
    return out;
  }

  // ---- Fibonacci & positiegrootte ------------------------------------------

  // Niveaus voor een swing van `start` (100%) naar `end` (0%).
  function fibLevels(start, end) {
    const rng = end - start;
    const levels = { "0%": end };
    for (const r of RETRACEMENTS) levels[fmtPct(r)] = end - r * rng;
    levels["100%"] = start;
    for (const e of EXTENSIONS) levels[fmtPct(e)] = start + e * rng;
    return levels;
  }

  function fmtPct(r) {
    return `${parseFloat((r * 100).toFixed(1))}%`;
  }

  // Lotgrootte zodat een stop-out precies riskPct% van de balance kost (naar beneden op 0,01).
  function positionSize(balance, riskPct, entry, stop, ozPerLot = 100) {
    const distance = Math.abs(entry - stop);
    if (distance <= 0 || balance <= 0 || riskPct <= 0) return 0;
    const lots = (balance * riskPct / 100) / (distance * ozPerLot);
    return Math.floor(lots * 100 + 1e-9) / 100;
  }

  // ---- Strategie-engine ----------------------------------------------------

  class Engine {
    constructor(candles, cfg, sign) {
      this.cfg = cfg;
      this.sign = sign;
      const pick = (k) => candles.map((c) => c[k]);
      if (sign === 1) {
        this.o = pick("open"); this.h = pick("high"); this.l = pick("low"); this.c = pick("close");
      } else {
        this.o = candles.map((c) => -c.open); this.h = candles.map((c) => -c.low);
        this.l = candles.map((c) => -c.high); this.c = candles.map((c) => -c.close);
      }
      this.emaF = ema(this.c, cfg.emaFast);
      this.emaS = ema(this.c, cfg.emaSlow);
      this.rsi = rsi(this.c, cfg.rsiPeriod);
      this.atr = atr(this.h, this.l, this.c, cfg.atrPeriod);
      this.ph = pivots(this.h, cfg.pivotBars, "high");
      this.pl = pivots(this.l, cfg.pivotBars, "low");
    }

    trendUp(t) {
      const ef = this.emaF[t], es = this.emaS[t];
      return Number.isFinite(ef) && Number.isFinite(es) && ef > es && this.c[t] > es;
    }

    // Laatste bevestigde swing [iL, iH, L, H] die op candle t bekend is.
    context(t) {
      const cfg = this.cfg, h = this.h, l = this.l;
      if (!Number.isFinite(this.atr[t])) return null;
      let iH = -1;
      for (let k = this.ph.length - 1; k >= 0; k--) {
        if (this.ph[k] <= t - cfg.pivotBars) { iH = this.ph[k]; break; }
      }
      if (iH < 0) return null;
      const H = h[iH];
      if (t - iH > cfg.maxSwingAge) return null;
      for (let k = iH + 1; k <= t; k++) if (h[k] > H) return null; // nieuwe high: geen pullback
      const minSize = cfg.minSwingAtr * this.atr[t];
      for (let p = this.pl.length - 1; p >= 0; p--) {
        const iL = this.pl[p];
        if (iL >= iH) continue;
        if (iH - iL > cfg.lookback) break;
        const L = l[iL];
        let lowest = Infinity;
        for (let k = iL; k <= iH; k++) lowest = Math.min(lowest, l[k]);
        if (lowest < L) continue; // niet het laagste punt van de swing
        if (H - L < minSize) continue;
        // Setup ongeldig zodra de prijs na de swing voorbij 100% is geweest.
        for (let k = iH + 1; k <= t; k++) if (l[k] <= L) return null;
        return [iL, iH, L, H];
      }
      return null;
    }

    evaluate(t) {
      const cfg = this.cfg;
      if (t < 1 || !this.trendUp(t)) return null;
      const ctx = this.context(t);
      if (!ctx) return null;
      const [iL, iH, L, H] = ctx;
      const R = H - L;
      const lv = (r) => H - r * R;
      const { o, h, l, c } = this;

      // Prijs moet de golden zone (50%-61,8%) raken en niet onder 78,6% sluiten.
      if (!(l[t] <= lv(0.5) && c[t] >= lv(0.786))) return null;

      const engulf = c[t] > o[t] && c[t - 1] < o[t - 1] && c[t] >= o[t - 1] && o[t] <= c[t - 1];
      const rng = h[t] - l[t];
      const lowerWick = Math.min(o[t], c[t]) - l[t];
      const body = Math.abs(c[t] - o[t]);
      const pin = rng > 0 && lowerWick >= 2 * body && lowerWick >= 0.6 * rng;
      const rsiTurn = Number.isFinite(this.rsi[t - 1]) && this.rsi[t - 1] < cfg.rsiThreshold
        && this.rsi[t] > this.rsi[t - 1];
      const reclaim = l[t] < lv(0.618) && c[t] > lv(0.618);
      if (!(engulf || pin || rsiTurn || reclaim)) return null;

      const entry = c[t];
      const sl = Math.min(lv(0.786), l[t]) - cfg.slAtrBuffer * this.atr[t];
      const tp1 = H, tp2 = L + 1.272 * R, tp3 = L + 1.618 * R;
      if (entry >= tp1 || entry <= sl) return null;
      const rr = (tp1 - entry) / (entry - sl);
      if (rr < cfg.minRr) return null;

      const [score, reasons] = this.score(t, L, H, engulf, pin, rsiTurn, reclaim);
      return { t, iL, iH, L, H, entry, sl, tp1, tp2, tp3, rr, score, reasons };
    }

    score(t, L, H, engulf, pin, rsiTurn, reclaim) {
      const cfg = this.cfg, a = this.atr[t];
      const buy = this.sign === 1;
      const reasons = [];

      const gap = (this.emaF[t] - this.emaS[t]) / a;
      const trendPts = 25 * Math.min(Math.max(gap / 2, 0), 1);
      reasons.push(`Duidelijke ${buy ? "uptrend" : "downtrend"} (EMA${cfg.emaFast} ${buy ? "boven" : "onder"} `
        + `EMA${cfg.emaSlow}).`);

      const depth = (H - this.l[t]) / (H - L);
      let levelPts, lvl;
      if (depth >= 0.58 && depth <= 0.70) { levelPts = 25; lvl = "61,8%"; }
      else if (depth < 0.58) { levelPts = 18; lvl = "50%"; }
      else { levelPts = 12; lvl = "78,6%"; }
      reasons.push(`Pullback tot rond het ${lvl}-niveau (golden zone).`);

      const conf = [];
      let confPts = 0;
      if (engulf) { confPts += 12; conf.push(`${buy ? "bullish" : "bearish"} engulfing`); }
      if (pin) { confPts += 10; conf.push("pin bar"); }
      if (reclaim) { confPts += 8; conf.push(`slot terug ${buy ? "boven" : "onder"} 61,8%`); }
      if (rsiTurn) { confPts += 8; conf.push(`RSI draait ${buy ? "omhoog" : "omlaag"}`); }
      confPts = Math.min(confPts, 25);
      reasons.push(`Bevestiging: ${conf.join(", ")}.`);

      const realRsi = buy ? this.rsi[t] : 100 - this.rsi[t];
      const rsiPts = this.rsi[t] < 45 ? 10 : 4;
      reasons.push(`RSI ${Number.isFinite(realRsi) ? pyRound(realRsi) : "nan"}.`);

      const fib618 = Math.abs(H - 0.618 * (H - L));
      const step = cfg.roundNumberStep;
      const nearest = pyRound(fib618 / step) * step;
      const dist = Math.abs(fib618 - nearest);
      const roundPts = dist <= 0.5 * a ? 15 : dist <= 1.5 * a ? 8 : 0;
      if (roundPts) {
        reasons.push(`61,8%-niveau ligt dicht bij rond getal $${nearest.toLocaleString("en-US", { maximumFractionDigits: 0 })}.`);
      }

      const total = trendPts + levelPts + confPts + rsiPts + roundPts;
      return [pyRound(Math.min(total, 100)), reasons];
    }
  }

  function allowed(cfg) {
    const both = [[1, "BUY"], [-1, "SELL"]];
    const choice = cfg.directions.toLowerCase();
    return both.filter((d) => choice === "both" || d[1].toLowerCase() === choice);
  }

  // Alle signalen zonder look-ahead: een signaal op candle t gebruikt alleen 0..t.
  // Per swing maximaal één signaal.
  function findSignals(candles, cfg) {
    const signals = [];
    const start = Math.max(cfg.emaSlow, cfg.atrPeriod, cfg.rsiPeriod) + 1;
    for (const [s, direction] of allowed(cfg)) {
      const eng = new Engine(candles, cfg, s);
      const used = new Set();
      for (let t = start; t < candles.length; t++) {
        const r = eng.evaluate(t);
        if (!r) continue;
        const key = `${r.iL},${r.iH}`;
        if (used.has(key)) continue;
        used.add(key);
        signals.push({
          time: candles[t].time, bar: t, direction,
          entry: s * r.entry, sl: s * r.sl, tp1: s * r.tp1, tp2: s * r.tp2, tp3: s * r.tp3,
          rr: pyRound(r.rr * 100) / 100, score: r.score,
          swingStart: s * r.L, swingEnd: s * r.H,
          swingStartTime: candles[r.iL].time, swingEndTime: candles[r.iH].time,
          reasons: r.reasons,
        });
      }
    }
    signals.sort((a, b) => a.bar - b.bar);
    return signals;
  }

  // De swing waarop de Fibonacci-niveaus nu getekend worden (ook zonder signaal).
  function currentContext(candles, cfg) {
    const t = candles.length - 1;
    for (const [s, direction] of allowed(cfg)) {
      const eng = new Engine(candles, cfg, s);
      if (!eng.trendUp(t)) continue;
      const ctx = eng.context(t);
      if (ctx) {
        const [iL, iH, L, H] = ctx;
        return { direction, swingStart: s * L, swingEnd: s * H,
          swingStartTime: candles[iL].time, swingEndTime: candles[iH].time };
      }
    }
    return null;
  }

  function trendLabel(candles, cfg) {
    const t = candles.length - 1;
    if (new Engine(candles, cfg, 1).trendUp(t)) return "Uptrend";
    if (new Engine(candles, cfg, -1).trendUp(t)) return "Downtrend";
    return "Neutraal";
  }

  // ---- Backtest ------------------------------------------------------------
  // Instap op de open van de volgende candle plus kosten; 1/3 op TP1/TP2/TP3;
  // na TP1 SL naar break-even; SL en TP in dezelfde candle = SL; één trade tegelijk.
  function simulate(candles, signals, cfg) {
    const n = candles.length;
    const trades = [];
    let busyUntil = -1;
    for (const sig of signals) {
      const e = sig.bar + 1;
      if (e >= n || sig.bar < busyUntil) continue;
      const d = sig.direction === "BUY" ? 1 : -1;
      const entry = candles[e].open + d * cfg.cost;
      const risk = (entry - sig.sl) * d;
      if (risk <= 0 || (sig.tp1 - entry) * d <= 0) continue; // gat over stop of TP1
      const tps = [sig.tp1, sig.tp2, sig.tp3];
      let stop = sig.sl, hits = 0, r = 0, outcome = "open", j = e, closed = false;
      for (j = e; j < n; j++) {
        const { high, low } = candles[j];
        const stopHit = d === 1 ? low <= stop : high >= stop;
        if (stopHit) {
          r += (3 - hits) / 3 * (stop - entry) * d / risk;
          outcome = hits === 0 ? "SL" : `TP${hits} + BE`;
          closed = true;
          break;
        }
        while (hits < 3 && (d === 1 ? high >= tps[hits] : low <= tps[hits])) {
          r += (tps[hits] - entry) * d / risk / 3;
          hits++;
          if (hits === 1) stop = entry;
        }
        if (hits === 3) { outcome = "TP3"; closed = true; break; }
      }
      if (!closed) {
        j = n - 1;
        r += (3 - hits) / 3 * (candles[n - 1].close - entry) * d / risk;
        outcome = "open";
      }
      busyUntil = j;
      trades.push({
        signalTime: sig.time, entryTime: candles[e].time, exitTime: candles[j].time,
        direction: sig.direction, entry, sl: sig.sl, tp1: sig.tp1,
        plannedRr: sig.rr, score: sig.score, outcome, r,
      });
    }

    const equity = [cfg.accountSize];
    let balance = cfg.accountSize;
    for (const t of trades) {
      balance *= 1 + cfg.riskPct / 100 * t.r;
      equity.push(balance);
    }
    return { trades, equity, stats: stats(trades, equity) };
  }

  function stats(trades, equity) {
    if (!trades.length) {
      return { trades: 0, winrate: 0, avgR: 0, avgPlannedRr: 0, profitFactor: 0,
        totalR: 0, maxDrawdown: 0, returnPct: 0 };
    }
    const rs = trades.map((t) => t.r);
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const gains = sum(rs.filter((r) => r > 0)), losses = -sum(rs.filter((r) => r < 0));
    let peak = equity[0], dd = 0;
    for (const v of equity) { peak = Math.max(peak, v); dd = Math.min(dd, (v - peak) / peak); }
    return {
      trades: trades.length,
      winrate: rs.filter((r) => r > 0).length / rs.length * 100,
      avgR: sum(rs) / rs.length,
      avgPlannedRr: sum(trades.map((t) => t.plannedRr)) / trades.length,
      profitFactor: losses > 0 ? gains / losses : Infinity,
      totalR: sum(rs),
      maxDrawdown: -dd * 100,
      returnPct: (equity[equity.length - 1] / equity[0] - 1) * 100,
    };
  }

  const api = { DEFAULTS, ema, rsi, atr, pivots, fibLevels, positionSize, findSignals,
    currentContext, trendLabel, simulate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GoldFib = api;
})(this);
