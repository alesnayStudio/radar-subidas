"use strict";

const DATA = "data/";
const HORIZONS = ["1", "5", "20"];
const SEGMENTS = [
  ["rvol", "Volumen"], ["catalyst", "Catalizador"], ["move", "Subida"], ["close", "Cierre"], ["size", "Tamaño"],
];

const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function safeUrl(u) {
  try { const url = new URL(u); return ["http:", "https:"].includes(url.protocol) ? url.href : "#"; }
  catch { return "#"; }
}
async function getJSON(path) {
  const res = await fetch(DATA + path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

const fmtPct = (v, digits = 1) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`);
const signCls = (v) => (v == null ? "dim" : v > 0 ? "pos" : v < 0 ? "neg" : "");
function fmtMoney(v) {
  if (v == null) return "—";
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)} B$`;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)} mil M$`;
  return `${(v / 1e6).toFixed(0)} M$`;
}
function fmtDate(iso) {
  return new Date(iso + "T12:00:00").toLocaleDateString("es-ES", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}
function timeAgo(iso) {
  const h = (Date.now() - new Date(iso)) / 36e5;
  if (h < 1) return `hace ${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `hace ${Math.round(h)} h`;
  return `hace ${Math.round(h / 24)} d`;
}
function qualityClass(q) {
  if (q >= 0.8) return "q-high";
  if (q >= 0.5) return "q-mid";
  if (q >= 0.25) return "q-low";
  return "q-none";
}

/* ---------- Top del día ---------- */

function renderSummary(d) {
  const f = d.filters;
  const provisional = d.market_state === "REGULAR" || d.market_state === "PRE";
  $("#summary").innerHTML = `
    <span class="pill">Sesión <b>${esc(fmtDate(d.date))}</b></span>
    <span class="pill"><b>${d.universe.raw_gainers}</b> suben &gt;${f.min_change_pct}% · <b>${d.universe.passed_filters}</b> pasan filtros</span>
    <span class="pill">Cap. &gt; ${fmtMoney(f.min_market_cap)} · Precio &gt; ${f.min_price}$ · RVOL &gt; ${f.min_rvol}</span>
    ${provisional ? `<span class="pill warn">Datos provisionales: escaneo con el mercado abierto</span>` : ""}`;
  $("#updated").textContent = `Actualizado ${new Date(d.generated_at).toLocaleString("es-ES")}`;
}

function scoreBar(r) {
  const parts = r.score_parts || {};
  const segs = SEGMENTS.map(([k]) => `<span class="seg-${k}" style="width:${parts[k] || 0}%" title="${k}: ${parts[k] || 0}"></span>`).join("");
  return `
    <div class="score">
      <div class="score-top"><span>Puntuación</span><b class="num">${r.score.toFixed(0)}/100</b></div>
      <div class="bar" role="img" aria-label="Puntuación ${r.score} de 100">${segs}</div>
      <div class="legend">${SEGMENTS.map(([k, l]) => `<span><i class="seg-${k}"></i>${l} ${(parts[k] || 0).toFixed(0)}</span>`).join("")}</div>
    </div>`;
}

function repeatBadge(a) {
  if (!a || a.count < 2) return "";
  const prev = a.previous.map(fmtDate).join(", ");
  return `<span class="repeat" title="Ya salió el ${esc(prev)}">🔁 ${a.count}ª vez en ${a.window} sesiones</span>`;
}

function renderHolders(h) {
  const t = $("#holders-table");
  if (!h) { $("#holders-hint").textContent = ""; t.innerHTML = ""; return; }
  $("#holders-hint").textContent = h.tracked
    ? `${h.items.length} de las ${h.tracked} acciones del top de las últimas ${h.window} sesiones siguen por encima del cierre del día en que salieron.`
    : `Aparecerán aquí cuando haya selecciones de sesiones anteriores.`;
  if (!h.items.length) { t.innerHTML = ""; return; }
  t.innerHTML = `
    <thead><tr><th>Acción</th><th>Salió el</th><th>Catalizador</th><th class="r">Sesiones</th>
      <th class="r">Precio entonces</th><th class="r">Ahora</th><th class="r">Desde entonces</th>
      <th class="r" title="Distancia al cierre más alto desde que salió. 0% = en máximos">vs máx.</th>
      <th class="r" title="Volumen de la última sesión frente a su media de 20 sesiones">Vol. rel.</th></tr></thead>
    <tbody>${h.items.map((x) => `
      <tr><td><b>${esc(x.symbol)}</b> <span class="dim">${esc(x.name.slice(0, 26))}</span>${x.appearances > 1 ? ` <span class="repeat">🔁 ${x.appearances}</span>` : ""}</td>
        <td>${esc(fmtDate(x.picked_on))}</td><td>${esc(x.catalyst_label)}</td>
        <td class="r num">${x.sessions_since}</td>
        <td class="r num">${x.picked_price.toFixed(2)}</td><td class="r num">${x.price.toFixed(2)}</td>
        <td class="r num pos">${fmtPct(x.change_since_pct)}</td>
        <td class="r num ${x.from_peak_pct < -5 ? "neg" : "dim"}">${fmtPct(x.from_peak_pct)}</td>
        <td class="r num">${x.last_rvol == null ? "—" : x.last_rvol.toFixed(1) + "×"}</td></tr>`).join("")}
    </tbody>`;
}

function card(r, i) {
  const c = r.catalyst;
  const sym = encodeURIComponent(r.symbol);
  const news = (r.news || []).slice(0, 3).map((n) => `
    <li><a href="${esc(safeUrl(n.link))}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a>
      <span class="src">${esc(n.source)} · ${esc(timeAgo(n.published))}</span></li>`).join("");
  const metric = (k, v, cls = "") => `<div class="metric"><span class="k">${k}</span><span class="v num ${cls}">${v}</span></div>`;

  return `
  <article class="card">
    <div class="card-head">
      <div style="min-width:0">
        <div class="ticker"><span class="rank">${i + 1}</span><span class="symbol">${esc(r.symbol)}</span>${repeatBadge(r.appearance)}</div>
        <div class="name" title="${esc(r.name)}">${esc(r.name)}</div>
      </div>
      <div class="change">
        <div class="pct num">${fmtPct(r.change_pct)}</div>
        <div class="price num">${r.price.toFixed(2)} $</div>
      </div>
    </div>

    <div class="catalyst">
      <span class="badge ${qualityClass(c.quality)}">${esc(c.label)}</span>
      <span class="note">${esc(c.note)}</span>
    </div>

    ${scoreBar(r)}

    <div class="metrics">
      ${metric("Vol. relativo", `${r.rvol.toFixed(1)}×`)}
      ${metric("Gap apertura", fmtPct(r.gap_pct), signCls(r.gap_pct))}
      ${metric("Cierre en rango", `${Math.round(r.close_strength * 100)}%`)}
      ${metric("Capitalización", fmtMoney(r.market_cap))}
      ${metric("vs máx. 52 sem.", fmtPct(r.pct_from_52w_high), signCls(r.pct_from_52w_high))}
      ${metric("Media 50 / 200", `${r.above_sma50 ? "▲" : "▼"} / ${r.above_sma200 ? "▲" : "▼"}`)}
    </div>

    ${news ? `<ul class="news">${news}</ul>` : `<p class="note">Sin titulares recientes encontrados.</p>`}

    <div class="links">
      <a href="https://finance.yahoo.com/quote/${sym}" target="_blank" rel="noopener noreferrer">Yahoo</a>
      <a href="https://www.tradingview.com/chart/?symbol=${sym}" target="_blank" rel="noopener noreferrer">Gráfico</a>
      <a href="https://finviz.com/quote.ashx?t=${sym}" target="_blank" rel="noopener noreferrer">Finviz</a>
    </div>
  </article>`;
}

async function loadDay(date) {
  const d = await getJSON(date ? `daily/${date}.json` : "latest.json");
  renderSummary(d);
  $("#cards").innerHTML = d.top.length
    ? d.top.map(card).join("")
    : `<p class="empty">Ninguna acción cumplió todos los filtros en esta sesión.</p>`;
  renderHolders(d.holding_up);
  fillHelp(d);
  return d;
}

function fillHelp(d) {
  const f = d.filters;
  $("#h-min").textContent = `${f.min_change_pct}% en el día`;
  $("#h-filters").innerHTML = [
    `Solo NYSE y Nasdaq (sin OTC), sin SPACs, warrants ni preferentes.`,
    `Capitalización mayor de ${fmtMoney(f.min_market_cap)} y precio mayor de ${f.min_price} $.`,
    `Más de ${fmtMoney(f.min_dollar_volume)} negociados en el día.`,
    `Volumen relativo (RVOL) mayor de ${f.min_rvol}× su media.`,
    `Si una empresa tiene varias clases de acción, solo se muestra la más líquida.`,
  ].map((t) => `<li>${esc(t)}</li>`).join("");
}

/* ---------- Seguimiento ---------- */

async function loadTracking() {
  let picks = [];
  try { picks = (await getJSON("history.json")).picks; } catch { /* aún no hay histórico */ }
  const t = $("#tracking-table");
  if (!picks.length) { t.innerHTML = `<tr><td class="empty">Todavía no hay histórico.</td></tr>`; return; }

  const cell = (p, h) => {
    const v = p.returns[h], ex = p.excess[h];
    if (v == null) return `<td class="r dim">pend.</td>`;
    return `<td class="r num"><span class="${signCls(v)}">${fmtPct(v)}</span> <span class="dim">(${fmtPct(ex)})</span></td>`;
  };
  t.innerHTML = `
    <thead><tr><th>Fecha</th><th>#</th><th>Acción</th><th>Catalizador</th><th class="r">Subida día</th><th class="r">Punt.</th>
      ${HORIZONS.map((h) => `<th class="r">+${h} ${h === "1" ? "sesión" : "sesiones"}</th>`).join("")}</tr></thead>
    <tbody>${[...picks].sort((a, b) => b.date.localeCompare(a.date) || a.rank - b.rank).map((p) => `
      <tr><td>${esc(p.date)}</td><td class="dim">${p.rank}</td>
        <td><b>${esc(p.symbol)}</b> <span class="dim">${esc(p.name.slice(0, 28))}</span></td>
        <td>${esc(p.catalyst_label)}</td>
        <td class="r num pos">${fmtPct(p.change_pct)}</td><td class="r num">${p.score.toFixed(0)}</td>
        ${HORIZONS.map((h) => cell(p, h)).join("")}</tr>`).join("")}
    </tbody>`;
}

/* ---------- Estadísticas ---------- */

const EMPTY_ROW = `<tr><td class="empty">Todavía no hay estadísticas.</td></tr>`;

function horizonTable(t, firstCol, groups) {
  const rows = Object.entries(groups || {});
  if (!rows.length) { t.innerHTML = EMPTY_ROW; return; }
  const cells = (s) => s
    ? `<td class="r num ${signCls(s.avg)}">${fmtPct(s.avg, 2)}</td><td class="r num">${s.win_rate.toFixed(0)}%</td><td class="r num ${signCls(s.avg_excess)}">${fmtPct(s.avg_excess, 2)}</td><td class="r dim num">${s.n}</td>`
    : `<td class="r dim" colspan="4">sin datos aún</td>`;
  t.innerHTML = `
    <thead>
      <tr><th rowspan="2">${firstCol}</th><th class="r" rowspan="2">Casos</th>
        ${HORIZONS.map((h) => `<th class="r" colspan="4">+${h} ${h === "1" ? "sesión" : "sesiones"}</th>`).join("")}</tr>
      <tr>${HORIZONS.map(() => `<th class="r">Media</th><th class="r">% aciertos</th><th class="r">vs SPY</th><th class="r">n</th>`).join("")}</tr>
    </thead>
    <tbody>${rows.map(([k, s]) => `
      <tr${k === "all" ? ' style="font-weight:700"' : ""}><td>${esc(s.label)}</td><td class="r num">${s.count}</td>
        ${HORIZONS.map((h) => cells(s.horizons[h])).join("")}</tr>`).join("")}
    </tbody>`;
}

function holdTable(t, sig) {
  if (!sig) { t.innerHTML = EMPTY_ROW; return; }
  t.innerHTML = `
    <thead><tr><th>A las 5 sesiones…</th><th class="r">Casos</th><th class="r">Media sesión 5→20</th>
      <th class="r">Mediana</th><th class="r">% que siguió subiendo</th></tr></thead>
    <tbody>${Object.values(sig).map(({ label, stats: s }) => `
      <tr><td>${esc(label)}</td>${s
        ? `<td class="r num">${s.n}</td><td class="r num ${signCls(s.avg)}">${fmtPct(s.avg, 2)}</td><td class="r num ${signCls(s.median)}">${fmtPct(s.median, 2)}</td><td class="r num">${s.win_rate.toFixed(0)}%</td>`
        : `<td class="r dim" colspan="4">sin datos aún (hacen falta 20 sesiones)</td>`}</tr>`).join("")}
    </tbody>`;
}

async function loadStats() {
  let stats = {};
  try { stats = await getJSON("stats.json"); } catch { /* aún no hay estadísticas */ }
  const cats = stats.catalysts || {};
  const sorted = Object.fromEntries(Object.entries(cats).sort(([a, x], [b, y]) => (a === "all" ? -1 : b === "all" ? 1 : y.count - x.count)));
  horizonTable($("#stats-table"), "Catalizador", sorted);
  horizonTable($("#stats-appearance"), "Aparición", stats.appearance);
  holdTable($("#stats-hold"), stats.hold_signal);
}

/* ---------- Navegación ---------- */

function setupTabs() {
  const loaded = {};
  const loaders = { tracking: loadTracking, stats: loadStats };
  document.querySelectorAll(".tabs button").forEach((btn) => btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", b === btn));
    document.querySelectorAll(".tab-panel").forEach((p) => (p.hidden = p.id !== `tab-${tab}`));
    $("#date-select").parentElement.style.visibility = tab === "today" ? "visible" : "hidden";
    if (loaders[tab] && !loaded[tab]) { loaded[tab] = true; loaders[tab](); }
  }));
}

async function init() {
  setupTabs();
  try {
    const latest = await loadDay(null);
    let dates = [latest.date];
    try { dates = await getJSON("dates.json"); } catch { /* opcional */ }
    const sel = $("#date-select");
    sel.innerHTML = dates.map((d) => `<option value="${esc(d)}">${esc(fmtDate(d))}</option>`).join("");
    sel.value = latest.date;
    sel.addEventListener("change", () => loadDay(sel.value));
  } catch (e) {
    $("#cards").innerHTML = `<p class="empty">No se pudieron cargar los datos (${esc(e.message)}).<br>Si abres el archivo directamente, usa un servidor local: <code>python -m http.server -d docs</code></p>`;
  }
}

init();
