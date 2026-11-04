"use strict";
/* Motor del Laboratorio de estrategias: funciones puras, sin DOM (se prueban desde la consola).

   Recorrido de cada selección (docs/data/paths.json): posición 0 = día de la selección, 1..N = sesiones
   siguientes, con apertura (o), máximo (h), mínimo (l) y cierre (c).

   Reglas de la simulación (deliberadamente conservadoras):
   - Entrada "next_open": en la APERTURA de la sesión siguiente (lo realista: el radar se publica de
     madrugada). "close": al cierre del día de la subida (teórico, no se puede hacer en la práctica).
   - Filtro de hueco (gap): con entrada en apertura, se puede exigir que la apertura esté entre
     gapMin% y gapMax% respecto al cierre anterior; si no, la operación no se hace.
   - Salidas, en este orden cada sesión:
       1) Hueco en la apertura (sesiones posteriores a la de entrada): si abre por debajo del stop se
          vende a esa apertura (peor que el stop); si abre por encima del objetivo, a esa apertura.
       2) Dentro de la sesión: si el mínimo toca el stop -> stop; si el máximo toca el objetivo -> objetivo.
          Si toca LOS DOS el mismo día no se sabe cuál fue antes: sameBar = "stop" (por defecto,
          pesimista) o "target".
       3) Si llega al número máximo de sesiones, se vende al cierre de la última.
   - Días: la sesión de entrada cuenta como día 1 (con entrada al cierre, el día 1 es la sesión siguiente).
   - Costes: `cost` % por operación completa (compra + venta: comisiones y deslizamiento), restado al resultado.
   - Si la selección aún no tiene todas las sesiones del periodo (aunque ya hubiera tocado objetivo o
     stop), queda "abierta" y NO cuenta: así no se cuelan solo las ganadoras rápidas de los días recientes.
*/
(function (global) {
  const pct = (a, b) => (a / b - 1) * 100;

  function simulateTrade(path, rule) {
    const n = path.d.length;
    const ei = rule.entry === "close" ? 0 : 1;
    if (n <= ei) return { status: "open" };
    const entry = ei === 0 ? path.c[0] : path.o[1];
    const gap = n > 1 ? pct(path.o[1], path.c[0]) : null;
    if (ei === 1) {
      if (rule.gapMin != null && gap < rule.gapMin) return { status: "skipped", gap };
      if (rule.gapMax != null && gap > rule.gapMax) return { status: "skipped", gap };
    }
    const tp = rule.target != null ? entry * (1 + rule.target / 100) : null;
    const sl = rule.stop != null ? entry * (1 - rule.stop / 100) : null;
    const days = Math.max(1, Math.round(rule.days));
    // Solo cuentan selecciones con el periodo COMPLETO ya disponible, aunque la operación salga antes.
    // Si no, entre las recientes solo contarían las que tocaron pronto el objetivo (las ganadoras rápidas)
    // y las que aún no lo han tocado quedarían fuera: el % de aciertos saldría inflado.
    if (n <= days) return { status: "open", gap };

    for (let i = 1; i <= days; i++) {
      if (i >= n) return { status: "open", gap };
      const done = (price, reason, ambiguous = false) => ({
        status: "closed", entry, exit: price, reason, ambiguous, gap, days: i,
        entryDate: path.d[ei], exitDate: path.d[i],
        ret: pct(price, entry) - (rule.cost || 0),
      });
      const entryBar = ei === 1 && i === 1;
      if (!entryBar) {
        if (sl != null && path.o[i] <= sl) return done(path.o[i], "stop_gap");
        if (tp != null && path.o[i] >= tp) return done(path.o[i], "target_gap");
      }
      const hitS = sl != null && path.l[i] <= sl;
      const hitT = tp != null && path.h[i] >= tp;
      if (hitS && hitT) return rule.sameBar === "target" ? done(tp, "target", true) : done(sl, "stop", true);
      if (hitS) return done(sl, "stop");
      if (hitT) return done(tp, "target");
      if (i === days) return done(path.c[i], "time");
    }
    return { status: "open", gap };
  }

  // Intervalo de confianza del 95% (Wilson) para un % de aciertos con n casos
  function wilson(wins, n) {
    if (!n) return [0, 0];
    const z = 1.96, p = wins / n, z2 = z * z;
    const center = (p + z2 / (2 * n)) / (1 + z2 / n);
    const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n);
    return [Math.max(0, center - half) * 100, Math.min(1, center + half) * 100];
  }

  function summarize(trades) {
    const t = trades.filter((x) => x.status === "closed")
      .sort((a, b) => a.exitDate.localeCompare(b.exitDate) || a.entryDate.localeCompare(b.entryDate));
    const n = t.length;
    if (!n) return { n: 0 };
    const rets = t.map((x) => x.ret);
    const wins = rets.filter((r) => r > 0), losses = rets.filter((r) => r <= 0);
    const sum = (a) => a.reduce((s, v) => s + v, 0);
    const mean = sum(rets) / n;
    const sd = n > 1 ? Math.sqrt(sum(rets.map((r) => (r - mean) ** 2)) / (n - 1)) : 0;
    const sorted = [...rets].sort((a, b) => a - b);
    const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;

    // Curva acumulada: misma cantidad invertida en cada operación (suma de %), por fecha de salida
    let cum = 0, peak = 0, maxDD = 0;
    const curve = t.map((x) => {
      cum += x.ret; peak = Math.max(peak, cum); maxDD = Math.min(maxDD, cum - peak);
      return { date: x.exitDate, cum, trade: x };
    });
    const reasons = {};
    t.forEach((x) => { reasons[x.reason] = (reasons[x.reason] || 0) + 1; });

    return {
      n, wins: wins.length, winRate: (wins.length / n) * 100, winCI: wilson(wins.length, n),
      avgWin: wins.length ? sum(wins) / wins.length : 0,
      avgLoss: losses.length ? sum(losses) / losses.length : 0,
      expectancy: mean, expectancyMargin: n > 1 ? (1.96 * sd) / Math.sqrt(n) : null, median,
      profitFactor: losses.length && sum(losses) !== 0 ? sum(wins) / Math.abs(sum(losses)) : Infinity,
      total: cum, maxDrawdown: maxDD, best: sorted[n - 1], worst: sorted[0],
      avgDays: sum(t.map((x) => x.days)) / n, reasons,
      ambiguous: t.filter((x) => x.ambiguous).length, curve,
    };
  }

  /* Simulación con dinero (cartera real, no suma de %):
     - Capital inicial; cada operación usa un % del valor de la cartera o una cantidad fija.
     - Acciones ENTERAS; comisión fija por orden (compra y venta) + `slip`% de deslizamiento en la venta.
     - Máximo de posiciones abiertas a la vez. Si no hay hueco, la señal se salta. Si falta efectivo se
       compra con lo que queda, salvo que no llegue a la mitad del tamaño previsto (entonces se salta).
       Con varias señales el mismo día entran primero las mejor colocadas en el top (rank).
     - El dinero de una venta se puede reutilizar a partir de la sesión siguiente (prudente).
     - La cartera se valora cada día al cierre con las posiciones abiertas (peor caída real).
     trades: operaciones "closed" de simulateTrade con .path y .pick (rank). */
  function simulatePortfolio(trades, o) {
    const ts = trades.filter((t) => t.status === "closed" && t.path)
      .sort((a, b) => a.entryDate.localeCompare(b.entryDate) || (a.pick?.rank ?? 99) - (b.pick?.rank ?? 99));
    if (!ts.length) return { executed: [] };
    const closeOn = (t, d) => { const i = t.path.d.indexOf(d); return i >= 0 ? t.path.c[i] : null; };
    const byEntry = {};
    const dates = new Set();
    ts.forEach((t) => {
      (byEntry[t.entryDate] ||= []).push(t);
      t.path.d.forEach((d) => { if (d >= t.entryDate && d <= t.exitDate) dates.add(d); });
    });
    const days = [...dates].sort();

    let cash = o.capital, peak = o.capital, maxDD = 0, maxDDabs = 0, commissions = 0, exposureSum = 0;
    let open = [], skippedCash = 0, skippedMax = 0, minCash = o.capital;
    const executed = [], equityCurve = [];
    for (const d of days) {
      for (const t of byEntry[d] || []) {
        if (open.length >= o.maxPos) { skippedMax++; continue; }
        const book = cash + open.reduce((s, p) => s + p.invested, 0);
        const alloc = o.sizing === "fixed" ? o.size : (book * o.size) / 100;
        // Si falta un poco de efectivo (p. ej. por comisiones) se compra con lo que queda;
        // si queda menos de la mitad del tamaño previsto, la señal se salta por falta de dinero.
        const usable = Math.min(alloc, cash - o.commission);
        const shares = Math.floor(usable / t.entry);
        if (usable < alloc * 0.5 || shares < 1) { skippedCash++; continue; }
        const invested = shares * t.entry;
        cash -= invested + o.commission; commissions += o.commission;
        open.push({ t, shares, invested });
      }
      minCash = Math.min(minCash, cash);
      // valoración al cierre: las que salen hoy, a su precio de salida; el resto, al cierre del día
      let value = 0;
      for (const p of open) value += p.shares * (p.t.exitDate === d ? p.t.exit : closeOn(p.t, d) ?? p.t.entry);
      const equity = cash + value;
      exposureSum += equity > 0 ? value / equity : 0;
      peak = Math.max(peak, equity);
      maxDD = Math.min(maxDD, (equity / peak - 1) * 100);
      maxDDabs = Math.min(maxDDabs, equity - peak);
      equityCurve.push({ date: d, equity });
      // ventas de hoy: el dinero queda disponible desde mañana (ya no hay más entradas hoy)
      open = open.filter((p) => {
        if (p.t.exitDate !== d) return true;
        const gross = p.shares * p.t.exit;
        const proceeds = gross - gross * (o.slip || 0) / 100 - o.commission;
        commissions += o.commission;
        cash += proceeds;
        executed.push({ ...p, proceeds, pnl: proceeds - p.invested - o.commission, pnlPct: ((proceeds - o.commission) / p.invested - 1) * 100 });
        return false;
      });
    }
    const final = cash;
    const wins = executed.filter((e) => e.pnl > 0).length;
    return {
      capital: o.capital, final, ret: (final / o.capital - 1) * 100, pnl: final - o.capital,
      maxDD, maxDDabs, commissions, executed, skippedCash, skippedMax,
      wins, winRate: executed.length ? (wins / executed.length) * 100 : 0,
      exposure: days.length ? (exposureSum / days.length) * 100 : 0,
      from: days[0], to: days[days.length - 1], sessions: days.length, minCash, equityCurve,
    };
  }

  global.LabEngine = { simulateTrade, summarize, wilson, simulatePortfolio };
})(window);
