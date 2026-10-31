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

  global.LabEngine = { simulateTrade, summarize, wilson };
})(window);
