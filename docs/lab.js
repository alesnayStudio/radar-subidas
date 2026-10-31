"use strict";
/* Laboratorio de estrategias: interfaz. La simulación está en lab-engine.js.
   Usa utilidades de app.js: $, esc, fmtPct, signCls, fmtDate, getJSON, rowsWithMore. */

const LAB_DEFAULT = {
  cats: [], ath: [], scoreMin: null, chgMin: null, chgMax: null, rvolMin: null, rankMax: null,
  repeatOnly: false, entry: "next_open", gapMin: null, gapMax: null,
  target: null, stop: null, days: 5, cost: 0.2, sameBar: "stop",
};
const LAB_NUM = ["scoreMin", "chgMin", "chgMax", "rvolMin", "rankMax", "gapMin", "gapMax", "target", "stop", "days", "cost"];

const LAB_PRESETS = [
  { name: "Todo el top · 5 sesiones", rule: {} },
  { name: "Resultados con mejora de previsiones", rule: { cats: ["earnings_guidance", "earnings"], target: 6, stop: 4, days: 5 } },
  { name: "OPA · objetivo +3%", rule: { cats: ["takeover"], target: 3, stop: 5, days: 10 } },
  { name: "Sin analistas ni pre-resultados", rule: { cats: ["earnings_guidance", "earnings", "fda", "contract", "capital", "corporate", "sector", "acquisition", "takeover"] } },
  { name: "Rupturas y cerca de máximos", rule: { ath: ["new_ath", "near"], stop: 5, days: 10 } },
  { name: "Sin perseguir huecos (máx. +3%)", rule: { gapMax: 3, target: 5, stop: 4, days: 5 } },
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
  r.repeatOnly = f.elements.repeatOnly.checked;
  r.cats = [...document.querySelectorAll("#lab-catalysts input:checked")].map((i) => i.value);
  r.ath = [...document.querySelectorAll("#lab-ath input:checked")].map((i) => i.value);
  return r;
}

function labRuleToForm(r) {
  const f = $("#lab-form");
  LAB_NUM.forEach((k) => (f.elements[k].value = r[k] == null ? "" : r[k]));
  f.elements.entry.value = r.entry;
  f.elements.sameBar.value = r.sameBar;
  f.elements.repeatOnly.checked = !!r.repeatOnly;
  document.querySelectorAll("#lab-catalysts input").forEach((i) => (i.checked = r.cats.includes(i.value)));
  document.querySelectorAll("#lab-ath input").forEach((i) => (i.checked = r.ath.includes(i.value)));
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
  if (r.scoreMin != null && p.score < r.scoreMin) return false;
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
    trades.push({ ...LabEngine.simulateTrade(path, r), pick: p });
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
    <tr><td>${esc(t.pick.date)}</td><td><b>${esc(t.pick.symbol)}</b></td><td>${esc(t.pick.catalyst_label)}</td>
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

function labRender() {
  const r = labRuleFromForm();
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
    ${labChart(s.curve)}
    ${labTradesTable(res.trades)}`;
  }
  $("#lab-results").innerHTML = html;
  if (s.n) labWireChart(s.curve);
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

  labRuleToForm(labLoadFromUrl());
  labRender();
}

// Un enlace con una regla guardada (#lab=...) abre directamente el Laboratorio
if (location.hash.startsWith("#lab")) document.querySelector('.tabs button[data-tab="lab"]').click();
