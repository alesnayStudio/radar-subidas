"use strict";
/* Ficha financiera de una empresa: se abre al pulsar cualquier ticker con [data-fund="TICKER"].
   Datos: docs/data/fundamentals/TICKER.json (los guarda el robot). Usa $, esc, fmtDate y getJSON de app.js. */

const QUALITY_NOTE = {
  A: "Negocio de calidad: márgenes, rentabilidad y salud financiera sólidos.",
  B: "Calidad media: tiene puntos fuertes y otros a vigilar.",
  C: "Calidad baja: márgenes, crecimiento o salud financiera flojos. Más riesgo.",
};

function qualityBadge(q, small = false) {
  if (!q || !q.grade) return "";
  return `<span class="qual q-${q.grade}${small ? " small" : ""}" title="Calidad ${q.grade}: ${q.points} de ${q.max} puntos${q.piotroski ? ` · Piotroski ${q.piotroski}` : ""}">Calidad ${q.grade}</span>`;
}

function fundMoney(v, cur) {
  if (v == null) return "—";
  const a = Math.abs(v), sign = v < 0 ? "−" : "";
  const s = a >= 1e9 ? `${(a / 1e9).toLocaleString("es-ES", { maximumFractionDigits: 1 })} mil M`
    : `${(a / 1e6).toLocaleString("es-ES", { maximumFractionDigits: a >= 1e8 ? 0 : 1 })} M`;
  return `${sign}${s}${cur && cur !== "USD" ? ` ${cur}` : ""}`;
}
const fundPct = (v) => (v == null ? "—" : `${(v * 100).toLocaleString("es-ES", { maximumFractionDigits: 1 })}%`);
const ratio = (a, b) => (a == null || !b ? null : a / b);

function fundHtml(f) {
  const q = f.quality || {};
  const mark = { true: "✔", false: "✘", partial: "◐", null: "·" };
  const cls = { true: "pos", false: "neg", partial: "warn-t", null: "dim" };
  const checks = (q.details || []).map((d) => `
    <li><span class="${cls[d.ok]}">${mark[d.ok]}</span> ${esc(d.label)}<span class="dim">${d.value != null ? ` — ${esc(d.value)}` : " — sin datos"}</span></li>`).join("");
  const pio = q.piotroski?.items?.length ? `<details><summary>Detalle de la salud financiera (Piotroski ${q.piotroski.score}/${q.piotroski.max})</summary><ul class="checks">${
    q.piotroski.items.map((i) => `<li><span class="${i.ok ? "pos" : "neg"}">${i.ok ? "✔" : "✘"}</span> ${esc(i.label)}</li>`).join("")}</ul></details>` : "";

  const yrs = f.annual || [];
  const cur = f.currency;
  const rowsA = [
    ["Ingresos", (y) => fundMoney(y.revenue, cur)],
    ["Crecimiento de ingresos", (y, i) => fundPct(yrs[i + 1] ? ratio(y.revenue, yrs[i + 1].revenue) - 1 : null)],
    ["Margen bruto", (y) => fundPct(ratio(y.gross_profit, y.revenue))],
    ["Margen operativo", (y) => fundPct(ratio(y.operating_income, y.revenue))],
    ["Beneficio neto", (y) => fundMoney(y.net_income, cur)],
    ["Flujo de caja libre", (y) => fundMoney(y.fcf, cur)],
    ["Caja", (y) => fundMoney(y.cash, cur)],
    ["Deuda total", (y) => fundMoney(y.total_debt, cur)],
  ];
  const annual = yrs.length ? `
    <h4>Cuentas anuales <small class="dim">(${cur && cur !== "USD" ? `en ${esc(cur)}` : "en $"}, M = millones)</small></h4>
    <div class="table-wrap"><table><thead><tr><th></th>${yrs.map((y) => `<th class="r">${y.year}</th>`).join("")}</tr></thead>
      <tbody>${rowsA.map(([label, fn]) => `<tr><td>${label}</td>${yrs.map((y, i) => `<td class="r num">${fn(y, i)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : "";
  const qs = f.quarterly || [];
  const quarterly = qs.length ? `
    <h4>Últimos trimestres</h4>
    <div class="table-wrap"><table><thead><tr><th>Trimestre que acaba</th><th class="r">Ingresos</th><th class="r">Beneficio operativo</th><th class="r">Beneficio neto</th><th class="r">Margen neto</th></tr></thead>
      <tbody>${qs.map((x) => `<tr><td>${esc(fmtDate(x.period))}</td><td class="r num">${fundMoney(x.revenue, cur)}</td><td class="r num">${fundMoney(x.operating_income, cur)}</td>
        <td class="r num">${fundMoney(x.net_income, cur)}</td><td class="r num">${fundPct(ratio(x.net_income, x.revenue))}</td></tr>`).join("")}</tbody></table></div>` : "";

  const sym = encodeURIComponent(f.symbol);
  const meta = [f.sector, f.industry, f.country, f.employees ? `${f.employees.toLocaleString("es-ES")} empleados` : null].filter(Boolean).map(esc).join(" · ");
  const val = [f.pe != null ? `PER actual ${f.pe.toFixed(1)}` : null, f.forward_pe != null ? `PER estimado ${f.forward_pe.toFixed(1)}` : null].filter(Boolean).join(" · ");
  return `
    <header class="fund-head">
      <div><h3>${esc(f.name)} <span class="dim">${esc(f.symbol)}</span></h3><p class="dim">${meta}</p></div>
      <button type="button" class="fund-close" aria-label="Cerrar">✕</button>
    </header>
    <section class="fund-quality">
      ${q.grade ? `${qualityBadge(q)} <span>${esc(QUALITY_NOTE[q.grade])}</span> <span class="dim">(${q.points} de ${q.max} puntos)</span>`
        : `<span class="dim">No hay datos suficientes para dar una nota de calidad.</span>`}
      <ul class="checks">${checks}</ul>${pio}
    </section>
    ${val ? `<p class="hint">Valoración: ${val}. <span class="dim">(PER = precio ÷ beneficio por acción: cuántos años de beneficios pagas)</span></p>` : ""}
    ${annual}${quarterly}
    ${f.summary ? `<details><summary>A qué se dedica <small class="dim">(descripción de Yahoo, en inglés)</small></summary><p class="fund-summary">${esc(f.summary)}…</p></details>` : ""}
    <p class="fund-links">
      <a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${sym}&owner=include&count=40" target="_blank" rel="noopener noreferrer">📄 Informes oficiales (SEC)</a>
      <a href="https://finance.yahoo.com/quote/${sym}/financials" target="_blank" rel="noopener noreferrer">Cuentas en Yahoo</a>
      ${f.website ? `<a href="${esc(safeUrl(f.website))}" target="_blank" rel="noopener noreferrer">Web de la empresa</a>` : ""}
    </p>
    <p class="dim fund-foot">Datos públicos de Yahoo Finance del ${esc(fmtDate(f.fetched.slice(0, 10)))}; pueden tener errores u omisiones. Las cifras oficiales están en los informes de la SEC (10-K anual, 10-Q trimestral; 20-F en empresas extranjeras).</p>`;
}

async function openFund(symbol) {
  const dlg = $("#fund-dialog");
  dlg.querySelector(".fund-body").innerHTML = `<p class="dim">Cargando ficha de ${esc(symbol)}…</p>`;
  if (!dlg.open) dlg.showModal();
  try {
    dlg.querySelector(".fund-body").innerHTML = fundHtml(await getJSON(`fundamentals/${encodeURIComponent(symbol)}.json`));
  } catch {
    dlg.querySelector(".fund-body").innerHTML = `
      <header class="fund-head"><h3>${esc(symbol)}</h3><button type="button" class="fund-close" aria-label="Cerrar">✕</button></header>
      <p>Todavía no hay ficha financiera de esta empresa. El robot la descargará en su próxima ejecución si vuelve a salir en el radar.</p>
      <p class="fund-links"><a href="https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/financials" target="_blank" rel="noopener noreferrer">Cuentas en Yahoo</a></p>`;
  }
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-fund]");
  if (t) { e.preventDefault(); openFund(t.dataset.fund); return; }
  const dlg = $("#fund-dialog");
  if (e.target.closest(".fund-close") || e.target === dlg) dlg.close();  // clic fuera de la ficha la cierra
});
