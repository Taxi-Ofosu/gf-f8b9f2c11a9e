/* Scherm van de Goud Fibonacci web-app: data ophalen, signalen tonen, grafiek, backtest. */
(function () {
  "use strict";
  const G = window.GoldFib;

  // timeframe -> [Binance-interval, aantal candles, candle-duur in seconden]
  const TIMEFRAMES = {
    "15m": ["15m", 5000, 900],
    "1H": ["1h", 8000, 3600],
    "4H": ["4h", 4500, 14400],
    "1D": ["1d", 3000, 86400],
  };
  const API = "https://data-api.binance.vision/api/v3/klines?symbol=PAXGUSDT";
  const LEVEL_COLORS = {
    "0%": "#8b8f96", "23.6%": "#8b8f96", "38.2%": "#60a5fa", "50%": "#e8b64c", "61.8%": "#e8b64c",
    "78.6%": "#f87171", "100%": "#8b8f96", "127.2%": "#86efac", "161.8%": "#22c55e",
  };
  // Originele strategie (zelfde als config.yaml van de Python-app).
  const ORIGINAL = {
    tf: "1H", minRr: G.DEFAULTS.minRr, directions: G.DEFAULTS.directions, pivotBars: G.DEFAULTS.pivotBars,
    minSwingAtr: G.DEFAULTS.minSwingAtr, minScore: 0,
  };
  // Beste variant uit de backtest van 324 varianten (nov 2026): hoogste winrate die in
  // beide helften van de data standhield.
  const BEST = { tf: "4H", minRr: 1.0, directions: "buy", pivotBars: 3, minSwingAtr: 1.5, minScore: 60 };
  const SETTING_DEFAULTS = {
    ...BEST, accountSize: G.DEFAULTS.accountSize, riskPct: G.DEFAULTS.riskPct, bars: 300,
  };
  const STORE_KEY = "goudfib.settings";

  const $ = (id) => document.getElementById(id);
  const cache = {};           // tf -> candles
  let settings = loadSettings();
  let chart = null;
  let loading = false;

  // ---- Instellingen ---------------------------------------------------------

  function loadSettings() {
    try {
      return { ...SETTING_DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || "{}") };
    } catch (e) {
      return { ...SETTING_DEFAULTS };
    }
  }

  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) { /* niet erg */ }
  }

  // ---- Funded account -------------------------------------------------------
  // Regels van een prop-firm-challenge en de ingevoerde trades (alleen op dit toestel).

  const FUNDED_KEY = "goudfib.funded";
  const FUNDED_DEFAULTS = { on: false, size: 10000, target: 8, daily: 5, max: 10, risk: 1, trades: [] };
  let fd = loadFunded();

  function loadFunded() {
    try {
      return { ...FUNDED_DEFAULTS, ...JSON.parse(localStorage.getItem(FUNDED_KEY) || "{}") };
    } catch (e) {
      return { ...FUNDED_DEFAULTS, trades: [] };
    }
  }

  function saveFunded() {
    try { localStorage.setItem(FUNDED_KEY, JSON.stringify(fd)); } catch (e) { /* niet erg */ }
  }

  const dayKey = (ms) => new Date(ms).toLocaleDateString("sv-SE"); // JJJJ-MM-DD in lokale tijd

  // Stand van de challenge: saldo, ruimte tot de limieten en een veilig risico voor de volgende trade.
  function fundedState() {
    const pnl = fd.trades.reduce((s, t) => s + t.pnl, 0);
    const today = dayKey(Date.now());
    const todayPnl = fd.trades.filter((t) => dayKey(t.ts) === today).reduce((s, t) => s + t.pnl, 0);
    const balance = fd.size + pnl;
    const roomToday = fd.daily / 100 * fd.size + todayPnl;     // tot de daglimiet
    const roomTotal = balance - fd.size * (1 - fd.max / 100);  // tot het maximale verlies
    const room = Math.min(roomToday, roomTotal);
    const riskUsd = fd.risk / 100 * balance;
    const targetUsd = fd.target / 100 * fd.size;
    const reached = fd.target > 0 && pnl >= targetUsd;
    let status, level;
    if (roomTotal <= 0) {
      level = "bad"; status = "Maximaal verlies bereikt: de challenge is verloren.";
    } else if (roomToday <= 0) {
      level = "bad"; status = "Daglimiet bereikt: vandaag niet meer traden.";
    } else if (reached) {
      level = "ok"; status = "🎉 Winstdoel gehaald! Stop met traden en vraag de volgende fase aan.";
    } else if (room < riskUsd) {
      level = "bad"; status = `Te weinig ruimte voor een volle trade. Riskeer hooguit $${fmt(room * 0.8, 0)}, of stop voor vandaag.`;
    } else if (room < 2 * riskUsd) {
      level = "warn2"; status = "Nog maar ruimte voor 1 verlies. Overweeg te stoppen voor vandaag.";
    } else {
      level = "ok"; status = `Alles in orde. Ruimte voor ${Math.floor(room / riskUsd)} verliezen op rij.`;
    }
    // Veilig risico: nooit meer dan 80% van de resterende ruimte, en 0 als je moet stoppen.
    const canTrade = roomTotal > 0 && roomToday > 0 && !reached;
    const safeRisk = canTrade ? Math.min(riskUsd, room * 0.8) : 0;
    return { pnl, todayPnl, balance, roomToday, roomTotal, riskUsd, targetUsd, reached, status, level, safeRisk };
  }

  function meter(label, value, frac, color) {
    const pct = Math.max(0, Math.min(1, frac)) * 100;
    return `<div class="meter"><div class="meter-top"><span class="muted">${label}</span><b>${value}</b></div>
      <div class="bar"><i style="width:${pct.toFixed(1)}%;background:${color}"></i></div></div>`;
  }

  function renderFunded() {
    const s = fundedState();
    const dailyUsd = fd.daily / 100 * fd.size, maxUsd = fd.max / 100 * fd.size;
    const sign = (v) => `${v >= 0 ? "+" : "−"}$${fmt(Math.abs(v))}`;
    $("fd-status").innerHTML = `
      <div class="card">
        <div class="sig-head" style="margin-bottom:10px">
          <div><div class="muted small">Saldo</div><div class="price">$${fmt(s.balance)}</div></div>
          <div class="score"><b style="color:var(${s.pnl >= 0 ? "--buy" : "--sell"})">${sign(s.pnl)}</b>
            <div class="muted small">${fmt(s.pnl / fd.size * 100, 2)}% totaal</div></div>
        </div>
        <div class="alert ${s.level}">${s.status}</div>
        ${fd.target > 0 ? meter("Winstdoel", `${sign(s.pnl)} van $${fmt(s.targetUsd, 0)}`, s.pnl / s.targetUsd, "var(--gold)") : ""}
        ${meter("Mag nog verliezen vandaag", `$${fmt(Math.max(s.roomToday, 0), 0)} <span class="muted">(limiet $${fmt(dailyUsd, 0)})</span>`, s.roomToday / dailyUsd,
          s.roomToday < 2 * s.riskUsd ? "var(--sell)" : "var(--buy)")}
        ${meter("Mag nog verliezen in totaal", `$${fmt(Math.max(s.roomTotal, 0), 0)} <span class="muted">(limiet $${fmt(maxUsd, 0)})</span>`, s.roomTotal / maxUsd,
          s.roomTotal < 2 * s.riskUsd ? "var(--sell)" : "var(--buy)")}
        <p class="small" style="margin:12px 0 0">Vandaag: <b class="${s.todayPnl >= 0 ? "r-pos" : "r-neg"}">${sign(s.todayPnl)}</b>
          · Risico volgende trade: <b>$${fmt(s.safeRisk, 0)}</b></p>
      </div>`;

    $("fd-log").innerHTML = fd.trades.length ? fd.trades.map((t, i) => [t, i]).reverse().map(([t, i]) => `
      <div class="row"><div class="row-top">
        <span class="${t.pnl >= 0 ? "r-pos" : "r-neg"}">${sign(t.pnl)}</span>
        <span class="muted small">${new Date(t.ts).toLocaleString("nl-BE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
          <button class="x" data-del="${i}" aria-label="Verwijderen">×</button></span>
      </div></div>`).join("") : '<p class="muted small" style="margin:0">Nog geen trades ingevoerd.</p>';

    $("fd-on").checked = fd.on;
    for (const k of ["size", "target", "daily", "max", "risk"]) $(`fd-${k}`).value = fd[k];

    $("fd-strip").innerHTML = fd.on ? `
      <button class="card strip" data-goto="funded">
        <div class="meter-top"><span><b>Funded</b> · <span class="${s.pnl >= 0 ? "r-pos" : "r-neg"}">${fmt(s.pnl / fd.size * 100, 2)}%</span>${fd.target > 0 ? ` van ${fmt(fd.target, 1)}%` : ""}</span>
          <span class="muted">vandaag nog $${fmt(Math.max(s.roomToday, 0), 0)} ruimte</span></div>
        ${s.level !== "ok" || s.reached ? `<div class="alert ${s.level}" style="margin-top:8px">${s.status}</div>` : ""}
      </button>` : "";
  }

  function fundedChanged() {
    saveFunded();
    renderFunded();
    rerender();
  }

  function config() {
    return { ...G.DEFAULTS, accountSize: settings.accountSize, riskPct: settings.riskPct, minRr: settings.minRr,
      directions: settings.directions, pivotBars: settings.pivotBars, minSwingAtr: settings.minSwingAtr };
  }

  // ---- Opmaak ---------------------------------------------------------------

  const fmt = (n, d = 2) => Number.isFinite(n)
    ? n.toLocaleString("nl-BE", { minimumFractionDigits: d, maximumFractionDigits: d }) : "–";
  const fmtTime = (t) => new Date(t * 1000).toLocaleString("nl-BE",
    { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // Lightweight Charts toont UTC; schuif de tijd op naar de tijdzone van de gsm.
  const local = (t) => t - new Date(t * 1000).getTimezoneOffset() * 60;

  // ---- Data -----------------------------------------------------------------

  async function fetchKlines(interval, total, endTime) {
    let rows = [];
    let end = endTime;
    while (rows.length < total) {
      const limit = Math.min(1000, total - rows.length);
      const url = `${API}&interval=${interval}&limit=${limit}${end ? `&endTime=${end}` : ""}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`Koersserver gaf fout ${res.status}`);
      const k = await res.json();
      if (!k.length) break;
      rows = k.concat(rows);
      end = k[0][0] - 1;
      if (k.length < limit) break;
    }
    const now = Date.now();
    return rows
      .filter((r) => r[6] < now) // laatste candle weglaten als die nog niet gesloten is
      .map((r) => ({ time: r[0] / 1000, open: +r[1], high: +r[2], low: +r[3], close: +r[4] }));
  }

  async function getCandles(tf, refresh) {
    const [interval, total] = TIMEFRAMES[tf];
    if (!cache[tf]) {
      cache[tf] = await fetchKlines(interval, total);
    } else if (refresh) {
      const fresh = await fetchKlines(interval, 1000);
      const first = fresh.length ? fresh[0].time : Infinity;
      cache[tf] = cache[tf].filter((c) => c.time < first).concat(fresh).slice(-total);
    }
    return cache[tf];
  }

  async function load(refresh = false) {
    if (loading) return;
    loading = true;
    const tf = settings.tf;
    const before = cache[tf] ? cache[tf][cache[tf].length - 1].time : null;
    $("updated").innerHTML = '<span class="spin"></span> laden…';
    try {
      const candles = await getCandles(tf, refresh);
      if (tf !== settings.tf) return;
      const last = candles[candles.length - 1].time;
      if (!refresh || last !== before) render(candles);
      $("updated").textContent = `bijgewerkt ${new Date().toLocaleTimeString("nl-BE", { hour: "2-digit", minute: "2-digit" })}`;
    } catch (e) {
      $("updated").textContent = "geen verbinding";
      if (!cache[tf]) {
        $("signal").innerHTML = `<div class="card err">Kon de koers niet ophalen (${esc(e.message)}). Controleer je internet en probeer opnieuw.<button class="btn ghost" onclick="location.reload()">Opnieuw proberen</button></div>`;
      }
    } finally {
      loading = false;
      if (tf !== settings.tf) load(!!cache[settings.tf]); // ondertussen ander timeframe gekozen
    }
  }

  // ---- Weergave -------------------------------------------------------------

  function render(candles) {
    const cfg = config();
    const n = candles.length;
    const signals = G.findSignals(candles, cfg).filter((s) => s.score >= settings.minScore);
    const ctx = G.currentContext(candles, cfg);
    const last = candles[n - 1];
    const active = signals.length && signals[signals.length - 1].bar >= n - 3 ? signals[signals.length - 1] : null;

    // Kop
    $("price").textContent = `$${fmt(last.close)}`;
    const chg = last.close - candles[n - 2].close;
    $("chg").textContent = `${chg >= 0 ? "+" : ""}${fmt(chg)} (${settings.tf})`;
    $("chg").className = `chg ${chg >= 0 ? "up" : "down"}`;
    const trend = G.trendLabel(candles, cfg);
    $("trend").textContent = trend;
    $("trend").className = `pill ${trend === "Uptrend" ? "up" : trend === "Downtrend" ? "down" : ""}`;

    renderSignal(active, ctx, cfg, last, trend);
    renderChart(candles, cfg, signals, ctx);
    renderHistory(signals);
    renderBacktest(candles, signals, cfg);
  }

  function renderSignal(sig, ctx, cfg, last, trend) {
    if (sig) {
      const buy = sig.direction === "BUY";
      let lots = G.positionSize(cfg.accountSize, cfg.riskPct, sig.entry, sig.sl, cfg.ozPerLot);
      const riskUsd = cfg.accountSize * cfg.riskPct / 100;
      let sizing = `<b>Positie:</b> ${fmt(lots)} lot
            <span class="muted">(risico ≈ $${fmt(riskUsd, 0)} = ${fmt(cfg.riskPct, 2)}% van $${fmt(cfg.accountSize, 0)}, stop ${fmt(Math.abs(sig.entry - sig.sl))} $/oz)</span>`;
      if (fd.on) {
        const f = fundedState();
        lots = f.safeRisk > 0 ? G.positionSize(f.balance, f.safeRisk / f.balance * 100, sig.entry, sig.sl, cfg.ozPerLot) : 0;
        sizing = f.safeRisk > 0
          ? `<b>Positie (funded):</b> ${fmt(lots)} lot
            <span class="muted">(risico ≈ $${fmt(f.safeRisk, 0)} van saldo $${fmt(f.balance, 0)}, stop ${fmt(Math.abs(sig.entry - sig.sl))} $/oz)</span>`
          : `<b>Funded: niet traden.</b> <span class="muted">${f.status}</span>`;
      }
      $("signal").innerHTML = `
        <div class="card signal ${buy ? "buy" : "sell"}">
          <div class="sig-head">
            <div><div class="sig-dir">${buy ? "▲ BUY" : "▼ SELL"}</div>
              <div class="muted small">${fmtTime(sig.time)} · ${settings.tf}</div></div>
            <div class="score"><b>${sig.score}</b><span class="muted">/100</span><div class="muted small">score</div></div>
          </div>
          <div class="grid">
            <div class="kv"><div class="k">Entry</div><div class="v">${fmt(sig.entry)}</div></div>
            <div class="kv sl"><div class="k">Stop-loss</div><div class="v">${fmt(sig.sl)}</div></div>
            <div class="kv"><div class="k">R:R</div><div class="v">${fmt(sig.rr)}</div></div>
            <div class="kv tp"><div class="k">TP1</div><div class="v">${fmt(sig.tp1)}</div></div>
            <div class="kv tp"><div class="k">TP2</div><div class="v">${fmt(sig.tp2)}</div></div>
            <div class="kv tp"><div class="k">TP3</div><div class="v">${fmt(sig.tp3)}</div></div>
          </div>
          <p class="small" style="margin:12px 0 0">${sizing}</p>
          <ul class="why small">${sig.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
        </div>`;
      return;
    }
    let body;
    if (ctx) {
      const lv = G.fibLevels(ctx.swingStart, ctx.swingEnd);
      const lo = Math.min(lv["50%"], lv["61.8%"]), hi = Math.max(lv["50%"], lv["61.8%"]);
      const dist = ctx.direction === "BUY" ? last.close - hi : lo - last.close;
      body = `
        <p class="small muted" style="margin:0 0 6px">Golden zone voor een mogelijk <b>${ctx.direction}</b>-signaal</p>
        <div class="zone">${fmt(lo)} – ${fmt(hi)}</div>
        <p class="small muted" style="margin:8px 0 0">Swing ${fmt(ctx.swingStart)} → ${fmt(ctx.swingEnd)}
          (${ctx.direction === "BUY" ? "uptrend" : "downtrend"}).
          ${dist > 0 ? `De prijs moet nog ${fmt(dist)} $ ${ctx.direction === "BUY" ? "zakken" : "stijgen"} tot de zone.` : "De prijs zit in of voorbij de zone."}
          Een signaal volgt als er daar bevestiging komt (engulfing, pin bar, RSI-draai of slot terug voorbij 61,8%).</p>`;
    } else if (cfg.directions === "buy" && trend === "Downtrend") {
      body = '<p class="small muted" style="margin:0">Goud zit in een daling. Je staat op <b>alleen BUY</b>, dus er komen pas weer signalen als goud stijgt. Afwachten.</p>';
    } else if (cfg.directions === "sell" && trend === "Uptrend") {
      body = '<p class="small muted" style="margin:0">Goud zit in een stijging. Je staat op <b>alleen SELL</b>, dus er komen pas weer signalen als goud daalt. Afwachten.</p>';
    } else {
      body = '<p class="small muted" style="margin:0">Geen geldige swing in de trendrichting, of de trend is neutraal. Afwachten.</p>';
    }
    $("signal").innerHTML = `<div class="card"><h2>Geen actief signaal</h2>${body}</div>`;
  }

  function renderChart(candles, cfg, signals, ctx) {
    const el = $("chart");
    if (chart) { chart.remove(); chart = null; }
    if (!window.LightweightCharts) {
      el.innerHTML = '<p class="muted small">Grafiek kon niet laden (geen internet?).</p>';
      return;
    }
    const view = candles.slice(-settings.bars);
    const start = view[0].time;
    chart = LightweightCharts.createChart(el, {
      autoSize: true,
      layout: { background: { type: "solid", color: "#1a1c20" }, textColor: "#9aa1ab", fontSize: 11 },
      grid: { vertLines: { color: "#22252a" }, horzLines: { color: "#22252a" } },
      rightPriceScale: { borderColor: "#2e3238" },
      timeScale: { borderColor: "#2e3238", timeVisible: settings.tf !== "1D", rightOffset: 4 },
      crosshair: { mode: 0 },
    });
    const series = chart.addCandlestickSeries({
      upColor: "#22c55e", downColor: "#ef4444", borderVisible: false,
      wickUpColor: "#22c55e", wickDownColor: "#ef4444",
    });
    series.setData(view.map((c) => ({ ...c, time: local(c.time) })));

    const closes = candles.map((c) => c.close);
    const offset = candles.length - view.length;
    for (const [period, color] of [[cfg.emaFast, "#60a5fa"], [cfg.emaSlow, "#c084fc"]]) {
      const e = G.ema(closes, period);
      const line = chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
        crosshairMarkerVisible: false });
      line.setData(view.map((c, i) => ({ time: local(c.time), value: e[offset + i] }))
        .filter((p) => Number.isFinite(p.value)));
    }

    if (ctx) {
      const lv = G.fibLevels(ctx.swingStart, ctx.swingEnd);
      for (const [name, price] of Object.entries(lv)) {
        if (name === "261.8%") continue;
        series.createPriceLine({ price, color: LEVEL_COLORS[name] || "#8b8f96", lineWidth: 1,
          lineStyle: name === "50%" || name === "61.8%" ? 0 : 2, axisLabelVisible: true, title: name });
      }
      if (ctx.swingStartTime >= start) {
        const swing = chart.addLineSeries({ color: "#e8b64c", lineWidth: 1, lineStyle: 2, priceLineVisible: false,
          lastValueVisible: false, crosshairMarkerVisible: false });
        swing.setData([
          { time: local(ctx.swingStartTime), value: ctx.swingStart },
          { time: local(ctx.swingEndTime), value: ctx.swingEnd },
        ]);
      }
    }

    series.setMarkers(signals.filter((s) => s.time >= start).map((s) => s.direction === "BUY"
      ? { time: local(s.time), position: "belowBar", color: "#22c55e", shape: "arrowUp", text: `${s.score}` }
      : { time: local(s.time), position: "aboveBar", color: "#ef4444", shape: "arrowDown", text: `${s.score}` }));
    chart.timeScale().fitContent();
  }

  function renderHistory(signals) {
    if (!signals.length) { $("hist").innerHTML = '<p class="muted small">Nog geen signalen in deze data.</p>'; return; }
    $("hist").innerHTML = signals.slice().reverse().map((s) => `
      <div class="row">
        <div class="row-top"><span class="${s.direction === "BUY" ? "b" : "s"}">${s.direction === "BUY" ? "▲" : "▼"} ${s.direction}</span>
          <span class="muted small">${fmtTime(s.time)}</span></div>
        <div class="small">Entry ${fmt(s.entry)} · SL ${fmt(s.sl)} · TP1 ${fmt(s.tp1)}</div>
        <div class="small muted">TP2 ${fmt(s.tp2)} · TP3 ${fmt(s.tp3)} · R:R ${fmt(s.rr)} · score ${s.score}</div>
        <details><summary>Waarom?</summary><div class="small">${esc(s.reasons.join(" "))}</div></details>
      </div>`).join("");
  }

  function renderBacktest(candles, signals, cfg) {
    const bt = G.simulate(candles, signals, cfg);
    const s = bt.stats;
    const d = (t) => new Date(t * 1000).toLocaleDateString("nl-BE");
    $("bt-info").textContent = `Periode ${d(candles[0].time)} t/m ${d(candles[candles.length - 1].time)} (${settings.tf}, ${candles.length} candles), ${fmt(cfg.riskPct)}% risico per trade.`;
    const kpi = (k, v, cls = "") => `<div class="kv"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
    const sign = (v, dd = 2) => `${v >= 0 ? "+" : ""}${fmt(v, dd)}`;
    $("kpis").innerHTML = [
      kpi("Trades", s.trades),
      kpi("Winrate", `${fmt(s.winrate, 1)}%`),
      kpi("Gem. R", sign(s.avgR), s.avgR >= 0 ? "r-pos" : "r-neg"),
      kpi("Profit factor", Number.isFinite(s.profitFactor) ? fmt(s.profitFactor) : "∞"),
      kpi("Rendement", `${sign(s.returnPct, 1)}%`, s.returnPct >= 0 ? "r-pos" : "r-neg"),
      kpi("Max drawdown", `${fmt(s.maxDrawdown, 1)}%`),
    ].join("");

    const eq = bt.equity;
    const svg = $("eq");
    if (eq.length > 1) {
      const W = 300, H = 100;
      const min = Math.min(...eq), max = Math.max(...eq), span = max - min || 1;
      const y = (v) => H - 4 - (v - min) / span * (H - 8);
      const pts = eq.map((v, i) => `${(i / (eq.length - 1) * W).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.innerHTML = `
        <line x1="0" x2="${W}" y1="${y(eq[0])}" y2="${y(eq[0])}" stroke="#2e3238" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>
        <polyline points="${pts}" fill="none" stroke="#e8b64c" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
    } else {
      svg.innerHTML = "";
    }

    $("trades").innerHTML = bt.trades.length ? bt.trades.slice().reverse().slice(0, 100).map((t) => `
      <div class="row">
        <div class="row-top"><span class="${t.direction === "BUY" ? "b" : "s"}">${t.direction} · ${esc(t.outcome)}</span>
          <span class="${t.r >= 0 ? "r-pos" : "r-neg"}">${sign(t.r)} R</span></div>
        <div class="small muted">${fmtTime(t.entryTime)} → ${fmtTime(t.exitTime)} · entry ${fmt(t.entry)} · score ${t.score}</div>
      </div>`).join("") : '<p class="muted small">Geen trades in deze periode.</p>';
  }

  // ---- Bediening ------------------------------------------------------------

  function syncControls() {
    document.querySelectorAll("#tfs button").forEach((b) => b.classList.toggle("on", b.dataset.tf === settings.tf));
    for (const id of ["accountSize", "riskPct", "minRr", "directions", "pivotBars", "minSwingAtr", "minScore", "bars"]) {
      $(id).value = settings[id];
      if ($(`${id}-v`)) $(`${id}-v`).textContent = settings[id];
    }
  }

  function rerender() {
    const candles = cache[settings.tf];
    if (candles) render(candles);
  }

  document.querySelectorAll("#tfs button").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.tf === settings.tf) return;
    settings.tf = b.dataset.tf;
    saveSettings();
    syncControls();
    if (cache[settings.tf]) { rerender(); load(true); } else load();
  }));

  function showTab(name) {
    document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("on", x.dataset.tab === name));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.id === `tab-${name}`));
    window.scrollTo(0, 0);
  }

  document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("open-info").addEventListener("click", () => showTab("info"));
  $("fd-strip").addEventListener("click", () => showTab("funded"));

  $("fd-on").addEventListener("change", () => { fd.on = $("fd-on").checked; fundedChanged(); });
  for (const k of ["size", "target", "daily", "max", "risk"]) {
    $(`fd-${k}`).addEventListener("change", () => {
      const v = parseFloat($(`fd-${k}`).value);
      if (Number.isFinite(v) && v >= 0 && (k === "target" || v > 0)) fd[k] = v;
      fundedChanged();
    });
  }
  function addTrade(sign) {
    const v = parseFloat($("fd-amount").value.replace(",", "."));
    if (!Number.isFinite(v) || v <= 0) { $("fd-amount").focus(); return; }
    fd.trades.push({ ts: Date.now(), pnl: sign * v });
    $("fd-amount").value = "";
    fundedChanged();
  }
  $("fd-win").addEventListener("click", () => addTrade(1));
  $("fd-loss").addEventListener("click", () => addTrade(-1));
  $("fd-log").addEventListener("click", (e) => {
    const i = e.target.dataset && e.target.dataset.del;
    if (i === undefined || !confirm("Deze trade verwijderen?")) return;
    fd.trades.splice(+i, 1);
    fundedChanged();
  });
  $("fd-reset").addEventListener("click", () => {
    if (!confirm("Nieuwe challenge starten? Alle ingevoerde trades worden gewist.")) return;
    fd.trades = [];
    fundedChanged();
  });

  for (const id of ["accountSize", "riskPct", "minRr", "directions", "pivotBars", "minSwingAtr", "minScore", "bars"]) {
    const el = $(id);
    el.addEventListener("input", () => { if ($(`${id}-v`)) $(`${id}-v`).textContent = el.value; });
    el.addEventListener("change", () => {
      const v = id === "directions" ? el.value : parseFloat(el.value);
      if (id !== "directions" && !Number.isFinite(v)) { syncControls(); return; }
      settings[id] = v;
      saveSettings();
      rerender();
    });
  }

  function applyPreset(preset) {
    const tfChanged = preset.tf !== settings.tf;
    settings = { ...settings, ...preset };
    saveSettings();
    syncControls();
    if (!tfChanged) rerender();
    else if (cache[settings.tf]) { rerender(); load(true); } else load();
  }

  $("best").addEventListener("click", () => applyPreset(BEST));
  $("reset").addEventListener("click", () => applyPreset(ORIGINAL));

  // Elke minuut kijken of er een nieuwe candle gesloten is, zolang de app open staat.
  setInterval(() => { if (document.visibilityState === "visible") load(true); }, 60000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && cache[settings.tf]) load(true);
  });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  syncControls();
  renderFunded();
  load();
})();
