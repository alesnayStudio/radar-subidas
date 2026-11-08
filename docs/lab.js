"use strict";
/* Laboratorio de estrategias: interfaz. La simulación está en lab-engine.js.
   Usa utilidades de app.js: $, esc, fmtPct, signCls, fmtDate, getJSON, rowsWithMore. */

const LAB_DEFAULT = {
  cats: [], ath: [], quality: [], scoreMin: null, scoreMax: null, chgMin: null, chgMax: null, rvolMin: null, rvolMax: null,
  rankMin: null, rankMax: null, closeMin: null, closeMax: null, market: "any",
  repeatOnly: false, entry: "next_open", gapMin: null, gapMax: null,
  target: null, stop: null, days: 5, cost: 0.2, sameBar: "stop",
  capital: 10000, sizing: "pct", size: 10, maxPos: 10, commission: 1,
};
const LAB_NUM = ["scoreMin", "scoreMax", "chgMin", "chgMax", "rvolMin", "rvolMax", "rankMin", "rankMax", "closeMin", "closeMax",
  "gapMin", "gapMax", "target", "stop", "days", "cost", "capital", "size", "maxPos", "commission"];

const LAB_PRESETS = [
  { name: "Todo el top · 5 sesiones", rule: {} },
  { name: "Resultados con mejora de previsiones", rule: { cats: ["earnings_guidance", "earnings"], target: 6, stop: 4, days: 5 } },
  { name: "OPA · objetivo +3%", rule: { cats: ["takeover"], target: 3, stop: 5, days: 10 } },
  { name: "Sin analistas ni pre-resultados", rule: { cats: ["earnings_guidance", "earnings", "fda", "contract", "capital", "corporate", "sector", "acquisition", "takeover"] } },
  { name: "Rupturas y cerca de máximos", rule: { ath: ["new_ath", "near"], stop: 5, days: 10 } },
  { name: "Sin perseguir huecos (máx. +3%)", rule: { gapMax: 3, target: 5, stop: 4, days: 5 } },
  { name: "Solo empresas de calidad (A o B)", rule: { quality: ["A", "B"], target: 3, stop: 5, days: 5 } },
  // Candidata de la auditoría del 8-nov: se mantuvo en las dos mitades del periodo (validar con datos nuevos)
  { name: "Resultados + cierre fuerte · +3%/−5%/3s", rule: { cats: ["earnings", "earnings_guidance"], closeMin: 80, chgMax: 24.99, target: 3, stop: 5, days: 3 } },
];

const ATH_LABELS = {
  new_ath: "🚀 Nuevo máximo", near: "🔝 Cerca (−5%)", mid: "↗️ Entre −5% y −50%",
  rebound: "↩️ Rebote (< −50%)", none: "Sin dato",
};
const REASONS = {
  target: "Objetivo", target_gap: "Objetivo (abrió por encima)", stop: "Stop",
  stop_gap: "Stop (abrió por debajo)", time: "Fin del tiempo",
};

let LAB = null;  // {picks, paths}

/* ---------- Estado <-> formulario <-> URL ---------- */

function labRuleFromForm() {
  const f = $("#lab-form"), r = { ...LAB_DEFAULT };
  LAB_NUM.forEach((k) => {
    const v = f.elements[k].value.trim();
    r[k] = v === "" ? null : Number(v);
  });
  if (r.days == null || r.days < 1) r.days = 1;
  if (r.days > 20) r.days = 20;
  if (r.cost == null) r.cost = 0;
  r.entry = f.elements.entry.value;
  r.sameBar = f.elements.sameBar.value;
  r.market = f.elements.market.value;
  r.sizing = f.elements.sizing.value;
  for (const [k, d] of [["capital", 10000], ["size", 10], ["maxPos", 10], ["commission", 0]]) if (r[k] == null || r[k] < 0) r[k] = d;
  if (r.maxPos < 1) r.maxPos = 1;
  r.repeatOnly = f.elements.repeatOnly.checked;
  r.cats = [...document.querySelectorAll("#lab-catalysts input:checked")].map((i) => i.value);
  r.ath = [...document.querySelectorAll("#lab-ath input:checked")].map((i) => i.value);
  r.quality = [...document.querySelectorAll("#lab-quality input:checked")].map((i) => i.value);
  return r;
}

function labRuleToForm(r) {
  const f = $("#lab-form");
  LAB_NUM.forEach((k) => (f.elements[k].value = r[k] == null ? "" : r[k]));
  f.elements.entry.value = r.entry;
  f.elements.sameBar.value = r.sameBar;
  f.elements.market.value = r.market || "any";
  f.elements.sizing.value = r.sizing || "pct";
  $("#lab-size-label").textContent = f.elements.sizing.value === "fixed" ? "$ por operación" : "% por operación";
  // abre "Más filtros" si alguno está en uso, para que no queden filtros activos escondidos
  const more = ["scoreMax", "rvolMax", "rankMin", "closeMin", "closeMax"].some((k) => r[k] != null) || (r.market && r.market !== "any");
  if (more) document.querySelector(".lab-more").open = true;
  f.elements.repeatOnly.checked = !!r.repeatOnly;
  document.querySelectorAll("#lab-catalysts input").forEach((i) => (i.checked = r.cats.includes(i.value)));
  document.querySelectorAll("#lab-ath input").forEach((i) => (i.checked = r.ath.includes(i.value)));
  document.querySelectorAll("#lab-quality input").forEach((i) => (i.checked = (r.quality || []).includes(i.value)));
}

// La regla se guarda en la dirección (#lab=...) para poder volver a ella o guardarla en favoritos
function labSaveToUrl(r) {
  const diff = Object.fromEntries(Object.entries(r).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(LAB_DEFAULT[k])));
  const hash = Object.keys(diff).length ? "#lab=" + encodeURIComponent(JSON.stringify(diff)) : "#lab";
  history.replaceState(null, "", hash);
}

function labLoadFromUrl() {
  const m = location.hash.match(/^#lab=(.+)$/);
  if (!m) return { ...LAB_DEFAULT };
  try { return { ...LAB_DEFAULT, ...JSON.parse(decodeURIComponent(m[1])) }; } catch { return { ...LAB_DEFAULT }; }
}

/* ---------- Filtro y simulación ---------- */

function labFilter(p, r) {
  if (r.cats.length && !r.cats.includes(p.catalyst)) return false;
  if (r.ath.length && !r.ath.includes(p.ath_status || "none")) return false;
  if (r.quality?.length && !r.quality.includes(p.quality || "none")) return false;
  if (r.scoreMin != null && p.score < r.scoreMin) return false;
  if (r.scoreMax != null && p.score > r.scoreMax) return false;
  if (r.rvolMax != null && p.rvol > r.rvolMax) return false;
  if (r.rankMin != null && p.rank < r.rankMin) return false;
  if (r.closeMin != null && (p.close_strength == null || p.close_strength * 100 < r.closeMin)) return false;
  if (r.closeMax != null && (p.close_strength == null || p.close_strength * 100 > r.closeMax)) return false;
  if (r.market && r.market !== "any") {
    if (p.spy_change == null) return false;
    const m = p.spy_change > 0.5 ? "up" : p.spy_change < -0.5 ? "down" : "flat";
    if (m !== r.market) return false;
  }
  if (r.chgMin != null && p.change_pct < r.chgMin) return false;
  if (r.chgMax != null && p.change_pct > r.chgMax) return false;
  if (r.rvolMin != null && p.rvol < r.rvolMin) return false;
  if (r.rankMax != null && p.rank > r.rankMax) return false;
  if (r.repeatOnly && (p.appearance || 1) < 2) return false;
  return true;
}

function labRun(r, onlyFiltered = true) {
  const picks = onlyFiltered ? LAB.picks.filter((p) => labFilter(p, r)) : LAB.picks;
  const trades = [];
  let noPath = 0;
  for (const p of picks) {
    const path = LAB.paths[`${p.date}|${p.symbol}`];
    if (!path) { noPath++; continue; }
    trades.push({ ...LabEngine.simulateTrade(path, r), pick: p, path });
  }
  return {
    picks: picks.length, noPath, trades,
    open: trades.filter((t) => t.status === "open").length,
    skipped: trades.filter((t) => t.status === "skipped").length,
    s: LabEngine.summarize(trades),
  };
}

/* ---------- Pintado de resultados ---------- */

const f1 = (v) => fmtPct(v, 1), f2 = (v) => fmtPct(v, 2);

function labVerdict(s) {
  if (!s.n) return `<div class="lab-verdict neutral">Ninguna operación cerrada con esta regla todavía.</div>`;
  const lo = s.expectancy - (s.expectancyMargin ?? Infinity), hi = s.expectancy + (s.expectancyMargin ?? Infinity);
  const size = s.n < 30 ? `Solo <b>${s.n}</b> operaciones: muy pocas para fiarse.`
    : s.n < 100 ? `${s.n} operaciones: resultado orientativo.` : `${s.n} operaciones: muestra razonable.`;
  if (lo > 0) return `<div class="lab-verdict good">✅ <b>Ventaja positiva con estos datos:</b> incluso en el peor caso del margen la esperanza es positiva. ${size}</div>`;
  if (hi < 0) return `<div class="lab-verdict bad">❌ <b>Pierde dinero con estos datos:</b> incluso en el mejor caso del margen la esperanza es negativa. ${size}</div>`;
  return `<div class="lab-verdict neutral">⚖️ <b>Sin ventaja demostrada todavía:</b> el margen de la esperanza (${f2(lo)} a ${f2(hi)}) incluye el 0. ${size}</div>`;
}

function kpi(label, value, sub = "", cls = "") {
  return `<div class="kpi"><span class="k">${label}</span><span class="v num ${cls}">${value}</span>${sub ? `<span class="sub">${sub}</span>` : ""}</div>`;
}

function labChart(curve) {
  if (curve.length < 2) return "";
  const W = 640, H = 200, P = { l: 44, r: 12, t: 12, b: 24 };
  const ys = curve.map((c) => c.cum).concat(0);
  let min = Math.min(...ys), max = Math.max(...ys);
  if (max - min < 1) { max += 0.5; min -= 0.5; }
  const x = (i) => P.l + (i / (curve.length - 1)) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b);
  const pts = curve.map((c, i) => `${x(i).toFixed(1)},${y(c.cum).toFixed(1)}`).join(" ");
  const fmtAxis = (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)}%`;
  return `
  <figure class="lab-chart">
    <figcaption>Resultado acumulado <small>(suma de % por operación, ordenadas por fecha de salida)</small></figcaption>
    <div class="chart-box">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Curva de resultado acumulado de ${curve.length} operaciones, termina en ${f1(curve[curve.length - 1].cum)}">
        <line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(max)}" y2="${y(max)}"/>
        <line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(min)}" y2="${y(min)}"/>
        <line class="zero" x1="${P.l}" x2="${W - P.r}" y1="${y(0)}" y2="${y(0)}"/>
        <text class="axis" x="${P.l - 6}" y="${y(max) + 4}" text-anchor="end">${fmtAxis(max)}</text>
        <text class="axis" x="${P.l - 6}" y="${y(0) + 4}" text-anchor="end">0%</text>
        <text class="axis" x="${P.l - 6}" y="${y(min) + 4}" text-anchor="end">${fmtAxis(min)}</text>
        <text class="axis" x="${P.l}" y="${H - 6}">${esc(curve[0].date)}</text>
        <text class="axis" x="${W - P.r}" y="${H - 6}" text-anchor="end">${esc(curve[curve.length - 1].date)}</text>
        <polyline class="line" points="${pts}"/>
        <line class="cross" x1="0" x2="0" y1="${P.t}" y2="${H - P.b}" visibility="hidden"/>
        <circle class="dot" r="4" visibility="hidden"/>
        <rect class="hit" x="${P.l}" y="0" width="${W - P.l - P.r}" height="${H}" data-n="${curve.length}"/>
      </svg>
      <div class="chart-tip" hidden></div>
    </div>
  </figure>`;
}

function labWireChart(curve) {
  const box = document.querySelector("#lab-results .chart-box");
  if (!box) return;
  const svg = box.querySelector("svg"), hit = svg.querySelector(".hit"), tip = box.querySelector(".chart-tip");
  const cross = svg.querySelector(".cross"), dot = svg.querySelector(".dot"), line = svg.querySelector(".line");
  const pts = line.getAttribute("points").split(" ").map((p) => p.split(",").map(Number));
  const show = (evt) => {
    const pt = svg.createSVGPoint(); pt.x = evt.clientX; pt.y = evt.clientY;
    const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
    let i = 0, best = Infinity;
    pts.forEach(([px], k) => { const d = Math.abs(px - loc.x); if (d < best) { best = d; i = k; } });
    const [px, py] = pts[i], c = curve[i], t = c.trade;
    cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", px); dot.setAttribute("cy", py); dot.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.innerHTML = `<b>${esc(t.pick.symbol)}</b> ${esc(c.date)}<br>Operación <span class="${signCls(t.ret)}">${f2(t.ret)}</span> · ${esc(REASONS[t.reason])}<br>Acumulado <b>${f1(c.cum)}</b>`;
    const r = box.getBoundingClientRect(), sx = r.width / svg.viewBox.baseVal.width;
    tip.style.left = `${Math.min(px * sx + 12, r.width - tip.offsetWidth - 4)}px`;
    tip.style.top = `${Math.max(0, py * sx - 40)}px`;
  };
  hit.addEventListener("pointermove", show);
  hit.addEventListener("pointerdown", show);
  hit.addEventListener("pointerleave", () => {
    tip.hidden = true; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden");
  });
}

function labTradesTable(trades) {
  const closed = trades.filter((t) => t.status === "closed").sort((a, b) => b.entryDate.localeCompare(a.entryDate));
  if (!closed.length) return "";
  const rows = closed.map((t) => `
    <tr><td>${esc(t.pick.date)}</td><td><button type="button" class="sym-link" data-fund="${esc(t.pick.symbol)}">${esc(t.pick.symbol)}</button></td><td>${esc(t.pick.catalyst_label)}</td>
      <td class="r num ${signCls(t.gap)}" title="Apertura del día siguiente frente al cierre del día de la subida">${t.gap == null ? "—" : f1(t.gap)}</td>
      <td class="r num">${t.entry.toFixed(2)}</td><td class="r num">${t.exit.toFixed(2)}</td>
      <td class="r num">${t.days}</td><td>${esc(REASONS[t.reason])}${t.ambiguous ? ' <span class="dim" title="Tocó objetivo y stop el mismo día">*</span>' : ""}</td>
      <td class="r num"><b class="${signCls(t.ret)}">${f2(t.ret)}</b></td></tr>`);
  return `
    <h3 class="section-title">Operaciones <small class="dim">(resultado ya con costes)</small></h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Selección</th><th>Acción</th><th>Catalizador</th><th class="r">Hueco</th><th class="r">Entrada</th>
        <th class="r">Salida</th><th class="r">Sesiones</th><th>Motivo de salida</th><th class="r">Resultado</th></tr></thead>
      <tbody>${rowsWithMore(rows, 20, "operaciones")}</tbody>
    </table></div>`;
}

/* ---------- Simulación con dinero ---------- */

const usd = (v, dec = 0) => `${v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("es-ES", { minimumFractionDigits: dec, maximumFractionDigits: dec })} $`;

function labMoney(trades, r) {
  const m = LabEngine.simulatePortfolio(trades, {
    capital: r.capital, sizing: r.sizing, size: r.size, maxPos: r.maxPos, commission: r.commission, slip: r.cost,
  });
  if (!m.executed.length) return `<h3 class="section-title">💰 Simulación con ${usd(r.capital)}</h3><p class="hint">Ninguna operación se pudo ejecutar con este capital y tamaño.</p>`;
  const skipped = m.skippedCash + m.skippedMax;
  const rows = [...m.executed].sort((a, b) => b.t.exitDate.localeCompare(a.t.exitDate)).map((e) => `
    <tr><td>${esc(e.t.entryDate)}</td><td>${esc(e.t.exitDate)}</td><td><button type="button" class="sym-link" data-fund="${esc(e.t.pick.symbol)}">${esc(e.t.pick.symbol)}</button></td>
      <td class="r num">${e.shares}</td><td class="r num">${e.t.entry.toFixed(2)}</td><td class="r num">${e.t.exit.toFixed(2)}</td>
      <td class="r num">${usd(e.invested)}</td><td class="r num"><b class="${signCls(e.pnl)}">${usd(e.pnl, 2)}</b></td>
      <td class="r num ${signCls(e.pnlPct)}">${f2(e.pnlPct)}</td></tr>`);
  return `
    <h3 class="section-title">💰 Simulación con ${usd(r.capital)}</h3>
    <div class="kpis">
      ${kpi("Capital final", usd(m.final), `${m.pnl >= 0 ? "ganado" : "perdido"} ${usd(Math.abs(m.pnl))}`, signCls(m.pnl))}
      ${kpi("Rentabilidad", f2(m.ret), `del ${fmtDate(m.from)} al ${fmtDate(m.to)}`, signCls(m.ret))}
      ${kpi("Peor caída", f1(m.maxDD), `${usd(m.maxDDabs)} desde el máximo`, "neg")}
      ${kpi("Operaciones hechas", m.executed.length, `${m.winRate.toFixed(0)}% ganadoras`)}
      ${kpi("Señales saltadas", skipped, `${m.skippedCash} por falta de dinero · ${m.skippedMax} por máx. posiciones`)}
      ${kpi("Capital invertido de media", `${m.exposure.toFixed(0)}%`, "el resto, en efectivo")}
      ${kpi("Comisiones pagadas", usd(m.commissions, 2), `${r.commission} $ por orden`)}
    </div>
    <p class="hint">Cuenta al contado, sin apalancamiento: nunca se invierte más dinero del que hay. La peor caída se mide con el valor de la cartera al cierre de cada día, incluidas las posiciones abiertas.${skipped ? " Las señales saltadas son normales: con dinero limitado no se puede entrar en todo." : ""}</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Compra</th><th>Venta</th><th>Acción</th><th class="r">Acciones</th><th class="r">Precio compra</th><th class="r">Precio venta</th>
        <th class="r">Invertido</th><th class="r">Resultado</th><th class="r">%</th></tr></thead>
      <tbody>${rowsWithMore(rows, 10, "operaciones")}</tbody>
    </table></div>`;
}

/* ---------- Explorador: ¿qué tienen en común las ganadoras? ---------- */

const rng = (lo, hi) => (v) => v != null && (lo == null || v >= lo) && (hi == null || v < hi);
const mkt = (m) => (p) => p.spy_change != null && (m === "up" ? p.spy_change > 0.5 : m === "down" ? p.spy_change < -0.5 : Math.abs(p.spy_change) <= 0.5);

// Cada grupo: etiqueta, prueba sobre la operación (t.pick = selección, t.gap = hueco de apertura) y
// cómo aplicarlo como filtro. Los rangos son [desde, hasta) y "hasta" se aplica restando 0,01.
const EXPLORE = [
  { name: "Catalizador", dynamic: "catalyst" },
  { name: "Máximo histórico", dynamic: "ath" },
  { name: "Calidad de la empresa", groups: ["A", "B", "C", "none"].map((g) =>
    [g === "none" ? "Sin nota" : `Calidad ${g}`, (t) => (t.pick.quality || "none") === g, { quality: [g] }]) },
  { name: "Puntuación", groups: [
    ["Menos de 40", (t) => rng(null, 40)(t.pick.score), { scoreMin: null, scoreMax: 39.99 }],
    ["40 a 55", (t) => rng(40, 55)(t.pick.score), { scoreMin: 40, scoreMax: 54.99 }],
    ["55 o más", (t) => rng(55, null)(t.pick.score), { scoreMin: 55, scoreMax: null }]] },
  { name: "Subida del día", groups: [
    ["6% a 10%", (t) => rng(null, 10)(t.pick.change_pct), { chgMin: null, chgMax: 9.99 }],
    ["10% a 15%", (t) => rng(10, 15)(t.pick.change_pct), { chgMin: 10, chgMax: 14.99 }],
    ["15% a 25%", (t) => rng(15, 25)(t.pick.change_pct), { chgMin: 15, chgMax: 24.99 }],
    ["25% o más", (t) => rng(25, null)(t.pick.change_pct), { chgMin: 25, chgMax: null }]] },
  { name: "Volumen relativo", groups: [
    ["Menos de 2,5×", (t) => rng(null, 2.5)(t.pick.rvol), { rvolMin: null, rvolMax: 2.49 }],
    ["2,5× a 4×", (t) => rng(2.5, 4)(t.pick.rvol), { rvolMin: 2.5, rvolMax: 3.99 }],
    ["4× a 8×", (t) => rng(4, 8)(t.pick.rvol), { rvolMin: 4, rvolMax: 7.99 }],
    ["8× o más", (t) => rng(8, null)(t.pick.rvol), { rvolMin: 8, rvolMax: null }]] },
  { name: "Puesto en el top", groups: [
    ["1 a 3", (t) => t.pick.rank <= 3, { rankMin: null, rankMax: 3 }],
    ["4 a 6", (t) => t.pick.rank >= 4 && t.pick.rank <= 6, { rankMin: 4, rankMax: 6 }],
    ["7 a 10", (t) => t.pick.rank >= 7, { rankMin: 7, rankMax: null }]] },
  { name: "Cierre en el rango del día", groups: [
    ["Lejos del máximo (< 50%)", (t) => rng(null, 0.5)(t.pick.close_strength), { closeMin: null, closeMax: 49.99 }],
    ["Medio (50% a 80%)", (t) => rng(0.5, 0.8)(t.pick.close_strength), { closeMin: 50, closeMax: 79.99 }],
    ["Cerca del máximo (≥ 80%)", (t) => rng(0.8, null)(t.pick.close_strength), { closeMin: 80, closeMax: null }]] },
  { name: "Hueco de apertura al día siguiente", entryOnly: "next_open", groups: [
    ["Abre bajando más de −3%", (t) => rng(null, -3)(t.gap), { gapMin: null, gapMax: -3.01 }],
    ["Entre −3% y 0%", (t) => rng(-3, 0)(t.gap), { gapMin: -3, gapMax: -0.01 }],
    ["Entre 0% y +3%", (t) => rng(0, 3)(t.gap), { gapMin: 0, gapMax: 2.99 }],
    ["Entre +3% y +6%", (t) => rng(3, 6)(t.gap), { gapMin: 3, gapMax: 5.99 }],
    ["Abre subiendo +6% o más", (t) => rng(6, null)(t.gap), { gapMin: 6, gapMax: null }]] },
  { name: "Mercado ese día (S&P 500)", groups: [
    ["Bajista (< −0,5%)", (t) => mkt("down")(t.pick), { market: "down" }],
    ["Plano (±0,5%)", (t) => mkt("flat")(t.pick), { market: "flat" }],
    ["Alcista (> +0,5%)", (t) => mkt("up")(t.pick), { market: "up" }]] },
  { name: "Aparición", groups: [
    ["Primera vez", (t) => (t.pick.appearance || 1) === 1, null],
    ["Repetidora", (t) => (t.pick.appearance || 1) >= 2, { repeatOnly: true }]] },
];

function labExploreGroups(def, rule) {
  if (def.dynamic === "catalyst") {
    const labels = Object.fromEntries(LAB.picks.map((p) => [p.catalyst, p.catalyst_label]));
    return Object.keys(labels).map((k) => [labels[k], (t) => t.pick.catalyst === k, { cats: [k] }]);
  }
  if (def.dynamic === "ath") {
    return Object.keys(ATH_LABELS).map((k) => [ATH_LABELS[k], (t) => (t.pick.ath_status || "none") === k, { ath: [k] }]);
  }
  if (def.entryOnly && rule.entry !== def.entryOnly) return [];
  return def.groups;
}

function labExplore(trades, rule) {
  const closed = trades.filter((t) => t.status === "closed");
  if (closed.length < 10) return "";
  const rows = [];
  EXPLORE.forEach((def, fi) => {
    labExploreGroups(def, rule).forEach(([label, test, apply], gi) => {
      const s = LabEngine.summarize(closed.filter(test));
      if (!s.n) return;
      const lo = s.expectancy - (s.expectancyMargin ?? Infinity), hi = s.expectancy + (s.expectancyMargin ?? Infinity);
      const tag = s.n < 15 ? `<span class="dim" title="Menos de 15 operaciones">pocos casos</span>`
        : lo > 0 ? `<span class="pos" title="Incluso en el peor caso del margen es positiva">✅ ventaja</span>`
        : hi < 0 ? `<span class="neg" title="Incluso en el mejor caso del margen es negativa">❌ pierde</span>` : `<span class="dim">sin demostrar</span>`;
      rows.push(`<tr${gi === 0 ? ' class="group-start"' : ""}><td>${gi === 0 ? `<b>${esc(def.name)}</b>` : ""}</td><td>${esc(label)}</td>
        <td class="r num">${s.n}</td><td class="r num">${s.winRate.toFixed(0)}%</td>
        <td class="r num"><b class="${signCls(s.expectancy)}">${f2(s.expectancy)}</b>${s.expectancyMargin != null ? ` <span class="dim">± ${s.expectancyMargin.toFixed(2)}</span>` : ""}</td>
        <td>${tag}</td>
        <td>${apply ? `<button type="button" class="lab-apply" data-f="${fi}" data-g="${gi}" title="Añadir este grupo como filtro">Aplicar</button>` : ""}</td></tr>`);
    });
  });
  return `
    <h3 class="section-title">🔍 Explorador: ¿qué tienen en común las ganadoras?</h3>
    <p class="hint">Las mismas operaciones de arriba, separadas por cada característica. Busca grupos con esperanza claramente mejor que el total y con bastantes casos. <b>Cuidado:</b> con tantos grupos, alguno saldrá bien por pura casualidad. Una pista solo es fiable si tiene sentido y se mantiene en las semanas siguientes.</p>
    <div class="table-wrap"><table class="lab-explore">
      <thead><tr><th>Característica</th><th>Grupo</th><th class="r">Ops.</th><th class="r">Aciertos</th><th class="r">Esperanza</th><th></th><th></th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table></div>`;
}

/* ---------- Descripción de la regla y regla guardada para el Top del día ---------- */

const SAVED_KEY = "radarRegla";

function labDescribe(r) {
  const parts = [];
  if (r.cats.length) parts.push(r.cats.map((k) => LAB.picks.find((p) => p.catalyst === k)?.catalyst_label || k).join(" o "));
  if (r.ath.length) parts.push(r.ath.map((k) => ATH_LABELS[k]).join(" o "));
  if (r.quality?.length) parts.push("calidad " + r.quality.map((g) => (g === "none" ? "sin nota" : g)).join(" o "));
  const range = (name, lo, hi, u = "") => (lo != null || hi != null) &&
    parts.push(`${name} ${lo != null ? `≥ ${lo}${u}` : ""}${lo != null && hi != null ? " y " : ""}${hi != null ? `≤ ${hi}${u}` : ""}`);
  range("puntuación", r.scoreMin, r.scoreMax); range("subida", r.chgMin, r.chgMax, "%"); range("vol. relativo", r.rvolMin, r.rvolMax, "×");
  range("puesto", r.rankMin, r.rankMax); range("cierre en rango", r.closeMin, r.closeMax, "%");
  if (r.market && r.market !== "any") parts.push({ up: "mercado alcista", flat: "mercado plano", down: "mercado bajista" }[r.market]);
  if (r.repeatOnly) parts.push("solo repetidoras");
  parts.push(r.entry === "close" ? "entrada al cierre (teórica)" : "entrada en la apertura siguiente");
  range("hueco de apertura", r.gapMin, r.gapMax, "%");
  if (r.target != null) parts.push(`objetivo +${r.target}%`);
  if (r.stop != null) parts.push(`stop −${r.stop}%`);
  parts.push(`máx. ${r.days} ${r.days === 1 ? "sesión" : "sesiones"}`);
  return parts.join(" · ");
}

function labSavedRule() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) || "null"); } catch { return null; }
}

function labSaveRule(r, s) {
  const saved = {
    rule: r, desc: labDescribe(r), savedAt: new Date().toISOString(),
    stats: s.n ? { n: s.n, winRate: s.winRate, expectancy: s.expectancy, margin: s.expectancyMargin } : null,
  };
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(saved)); return true; } catch { return false; }
}

function labRender() {
  const r = labRuleFromForm();
  $("#lab-size-label").textContent = r.sizing === "fixed" ? "$ por operación" : "% por operación";
  labSaveToUrl(r);
  const res = labRun(r), base = labRun(r, false), s = res.s;
  const notes = [
    `${res.picks} selecciones cumplen el filtro`,
    `<b>${s.n || 0}</b> operaciones cerradas`,
    res.open ? `${res.open} aún abiertas (sin sesiones suficientes)` : "",
    res.skipped ? `${res.skipped} descartadas por el hueco de apertura` : "",
    res.noPath ? `${res.noPath} sin datos de precios` : "",
  ].filter(Boolean).join(" · ");

  let html = `<p class="hint">${notes}</p>${labVerdict(s)}`;
  if (s.n) {
    const reasons = Object.entries(s.reasons).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${esc(REASONS[k])}: <b>${v}</b>`).join(" · ");
    const pf = s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2);
    html += `
    <div class="kpis">
      ${kpi("% de aciertos", `${s.winRate.toFixed(0)}%`, `margen ${s.winCI[0].toFixed(0)}–${s.winCI[1].toFixed(0)}%`)}
      ${kpi("Esperanza por operación", f2(s.expectancy), s.expectancyMargin != null ? `± ${s.expectancyMargin.toFixed(2)} · mediana ${f2(s.median)}` : "", signCls(s.expectancy))}
      ${kpi("Ganancia media", f2(s.avgWin), `${s.wins} ganadoras`, "pos")}
      ${kpi("Pérdida media", f2(s.avgLoss), `${s.n - s.wins} perdedoras`, "neg")}
      ${kpi("Factor de beneficio", pf, "ganado ÷ perdido (>1 gana)", s.profitFactor > 1 ? "pos" : "neg")}
      ${kpi("Resultado acumulado", f1(s.total), `peor caída ${f1(s.maxDrawdown)}`, signCls(s.total))}
      ${kpi("Mejor / peor", `${f1(s.best)} / ${f1(s.worst)}`)}
      ${kpi("Sesiones de media", s.avgDays.toFixed(1))}
    </div>
    <p class="hint">Salidas: ${reasons}${s.ambiguous ? ` · <span title="Tocaron objetivo y stop el mismo día">${s.ambiguous} con objetivo y stop el mismo día (*)</span>` : ""}</p>
    ${base.s.n ? `<p class="hint">Referencia: con la misma entrada y salida, operar <b>todo el top</b> sin filtros da <b class="${signCls(base.s.expectancy)}">${f2(base.s.expectancy)}</b> por operación (${base.s.winRate.toFixed(0)}% de aciertos, ${base.s.n} operaciones).</p>` : ""}
    ${labMoney(res.trades, r)}
    ${labChart(s.curve)}
    ${labExplore(res.trades, r)}
    ${labTradesTable(res.trades)}`;
  }
  const saved = labSavedRule();
  const isSaved = saved && JSON.stringify(saved.rule) === JSON.stringify(r);
  html = `<div class="lab-save">
      <button type="button" id="lab-save-btn" ${isSaved ? "disabled" : ""}>${isSaved ? "⭐ Es tu regla guardada" : "⭐ Usar esta regla en el Top del día"}</button>
      ${saved && !isSaved ? `<span class="dim">Guardada ahora: ${esc(saved.desc)}</span> <button type="button" id="lab-load-btn">Cargarla</button>` : ""}
      ${saved ? `<button type="button" id="lab-clear-btn">Quitar</button>` : ""}
    </div>` + html;
  $("#lab-results").innerHTML = html;
  LAB.last = { rule: r, s };
  if (s.n) labWireChart(s.curve);
}

function labResultsClick(e) {
  const apply = e.target.closest(".lab-apply");
  if (apply) {
    const def = EXPLORE[+apply.dataset.f];
    const [, , patch] = labExploreGroups(def, labRuleFromForm())[+apply.dataset.g];
    labRuleToForm({ ...labRuleFromForm(), ...patch });
    labRender();
    $("#lab-form").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (e.target.id === "lab-save-btn") {
    if (!labSaveRule(LAB.last.rule, LAB.last.s)) alert("Tu navegador no permite guardar datos en esta página (¿modo privado?).");
    labRender();
  } else if (e.target.id === "lab-load-btn") {
    labRuleToForm({ ...LAB_DEFAULT, ...labSavedRule().rule }); labRender();
  } else if (e.target.id === "lab-clear-btn") {
    try { localStorage.removeItem(SAVED_KEY); } catch { /* sin almacenamiento */ }
    labRender();
  }
}

/* ---------- Top del día: ¿qué acciones de hoy cumplen la regla guardada? ---------- */

// Convierte una tarjeta del día en el mismo formato que una selección del histórico
function labTodayPick(r, i, day) {
  return {
    catalyst: r.catalyst?.type, ath_status: r.ath?.status, quality: r.quality?.grade, score: r.score, change_pct: r.change_pct, rvol: r.rvol,
    rank: i + 1, appearance: r.appearance?.count || 1, close_strength: r.close_strength,
    spy_change: day?.market?.SPY?.change_pct,
  };
}

function labTodayPlan(r, i, day) {
  const saved = labSavedRule();
  if (!saved || r.price == null || !labFilter(labTodayPick(r, i, day), { ...LAB_DEFAULT, ...saved.rule })) return "";
  const rule = { ...LAB_DEFAULT, ...saved.rule }, c = r.price;
  const money = (v) => `${v.toFixed(2)} $`;
  let entry;
  if (rule.entry === "close") entry = "Regla con entrada al cierre (teórica): no se puede ejecutar en la práctica.";
  else if (rule.gapMin != null || rule.gapMax != null) {
    entry = `Entrar en la apertura <b>solo si abre ${rule.gapMin != null ? `por encima de ${money(c * (1 + rule.gapMin / 100))}` : ""}${rule.gapMin != null && rule.gapMax != null ? " y " : ""}${rule.gapMax != null ? `por debajo de ${money(c * (1 + rule.gapMax / 100))}` : ""}</b> (cierre de hoy ${money(c)}).`;
  } else entry = `Entrar en la apertura del próximo día (cierre de hoy ${money(c)}).`;
  const exits = [
    rule.target != null ? `objetivo <b>+${rule.target}%</b> sobre el precio de entrada` : "",
    rule.stop != null ? `stop <b>−${rule.stop}%</b>` : "",
    `vender como tarde al cierre de la sesión ${rule.days}`,
  ].filter(Boolean).join(" · ");
  const example = rule.entry !== "close" && (rule.target != null || rule.stop != null)
    ? ` <span class="dim">Ej.: si abre a ${money(c)} → ${rule.target != null ? `objetivo ${money(c * (1 + rule.target / 100))}` : ""}${rule.target != null && rule.stop != null ? ", " : ""}${rule.stop != null ? `stop ${money(c * (1 - rule.stop / 100))}` : ""}.</span>` : "";
  const st = saved.stats ? `<span class="dim">Con esta regla en el histórico: ${saved.stats.winRate.toFixed(0)}% de aciertos, ${fmtPct(saved.stats.expectancy, 2)} por operación (${saved.stats.n} ops., al guardarla).</span>` : "";
  return `<div class="rule-box">⭐ <b>Cumple tu regla.</b> ${entry} Salida: ${exits}.${example} ${st}</div>`;
}

function labTodaySummary(day) {
  const saved = labSavedRule();
  if (!saved || !day?.top?.length) return "";
  const n = day.top.filter((r, i) => labFilter(labTodayPick(r, i, day), { ...LAB_DEFAULT, ...saved.rule })).length;
  return `<span class="pill rule-pill" title="${esc(saved.desc)}">⭐ Tu regla: <b>${n}</b> de ${day.top.length} hoy
    ${n ? `<button type="button" id="rule-only-btn">ver solo esas</button>` : ""}</span>`;
}

/* ---------- Arranque ---------- */

function labChips(container, items, name) {
  container.innerHTML = items.map(([value, label, count]) =>
    `<label class="chip"><input type="checkbox" name="${name}" value="${esc(value)}"><span>${esc(label)} <small>${count}</small></span></label>`).join("");
}

async function loadLab() {
  try {
    const [h, paths] = await Promise.all([getJSON("history.json"), getJSON("paths.json")]);
    LAB = { picks: h.picks, paths };
  } catch (e) {
    $("#lab-results").innerHTML = `<p class="empty">No se pudieron cargar los datos del Laboratorio (${esc(e.message)}).</p>`;
    return;
  }
  const count = (fn) => LAB.picks.reduce((m, p) => { const k = fn(p); m[k] = (m[k] || 0) + 1; return m; }, {});
  const cats = count((p) => p.catalyst), labels = Object.fromEntries(LAB.picks.map((p) => [p.catalyst, p.catalyst_label]));
  labChips($("#lab-catalysts"), Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, labels[k], n]), "cats");
  const quals = count((p) => p.quality || "none");
  labChips($("#lab-quality"), ["A", "B", "C", "none"].filter((g) => quals[g]).map((g) => [g, g === "none" ? "Sin nota" : `Calidad ${g}`, quals[g]]), "quality");
  const aths = count((p) => p.ath_status || "none");
  labChips($("#lab-ath"), Object.keys(ATH_LABELS).filter((k) => aths[k]).map((k) => [k, ATH_LABELS[k], aths[k]]), "ath");

  $("#lab-presets").innerHTML = LAB_PRESETS.map((p, i) => `<button type="button" data-preset="${i}">${esc(p.name)}</button>`).join("");
  $("#lab-presets").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-preset]");
    if (!b) return;
    labRuleToForm({ ...LAB_DEFAULT, ...LAB_PRESETS[+b.dataset.preset].rule });
    labRender();
  });
  $("#lab-rules-link").addEventListener("click", (e) => { e.preventDefault(); $("#lab-rules").hidden = !$("#lab-rules").hidden; });
  $("#lab-form").addEventListener("input", labRender);
  $("#lab-form").addEventListener("change", labRender);
  $("#lab-form").addEventListener("submit", (e) => e.preventDefault());
  $("#lab-results").addEventListener("click", labResultsClick);

  labRuleToForm(labLoadFromUrl());
  labRender();
}

// Un enlace con una regla guardada (#lab=...) abre directamente el Laboratorio
if (location.hash.startsWith("#lab")) document.querySelector('.tabs button[data-tab="lab"]').click();
