"""Ficha financiera de cada empresa (datos públicos vía Yahoo Finance) y nota de CALIDAD.

La calidad intenta reflejar si el negocio es fuerte, no solo grande: márgenes altos (poder de precios),
rentabilidad sobre el capital, crecimiento, caja generada, poca deuda y la puntuación F de Piotroski
(9 comprobaciones de salud financiera con las cuentas de los dos últimos años).

Archivo por empresa: docs/data/fundamentals/TICKER.json (se refresca como mucho cada 7 días).
Bancos y biotecnológicas sin ventas no tienen algunas partidas: la nota se calcula con las que haya
y se indica cuántas se han podido evaluar.
"""
import json
import math
from datetime import date, datetime, timezone

import yfinance as yf

from . import config

FUND_DIR = config.DATA_DIR / "fundamentals"
REFRESH_DAYS = 7


def _num(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(v) or math.isinf(v) else v


def _row(df, *names):
    """Serie de la primera partida que exista (los nombres de Yahoo varían un poco según la empresa)."""
    for n in names:
        if df is not None and not df.empty and n in df.index:
            return df.loc[n]
    return None


def _at(series, col):
    return None if series is None or col not in series.index else _num(series[col])


def _div(a, b):
    return None if a is None or b in (None, 0) else a / b


def _statements(t):
    inc, bal, cf, qinc = t.income_stmt, t.balance_sheet, t.cashflow, t.quarterly_income_stmt
    years = sorted(inc.columns, reverse=True) if inc is not None and not inc.empty else []
    rows = {
        "revenue": _row(inc, "Total Revenue", "Operating Revenue"),
        "gross_profit": _row(inc, "Gross Profit"),
        "operating_income": _row(inc, "Operating Income", "Total Operating Income As Reported"),
        "net_income": _row(inc, "Net Income", "Net Income Common Stockholders"),
        "ebitda": _row(inc, "EBITDA", "Normalized EBITDA"),
        "total_assets": _row(bal, "Total Assets"),
        "current_assets": _row(bal, "Current Assets"),
        "current_liabilities": _row(bal, "Current Liabilities"),
        "long_term_debt": _row(bal, "Long Term Debt"),
        "total_debt": _row(bal, "Total Debt"),
        "cash": _row(bal, "Cash And Cash Equivalents", "Cash Cash Equivalents And Short Term Investments"),
        "equity": _row(bal, "Stockholders Equity", "Common Stock Equity"),
        "shares": _row(bal, "Ordinary Shares Number", "Share Issued"),
        "ocf": _row(cf, "Operating Cash Flow"),
        "fcf": _row(cf, "Free Cash Flow"),
    }
    annual = [{"year": int(c.year), **{k: _at(s, c) for k, s in rows.items()}} for c in years]
    # Yahoo a veces añade una columna vacía (p. ej. FERG al cambiar de año fiscal): solo años con cuentas
    annual = [a for a in annual if a["revenue"] is not None or a["net_income"] is not None][:4]

    q_rows = {"revenue": _row(qinc, "Total Revenue", "Operating Revenue"),
              "operating_income": _row(qinc, "Operating Income"),
              "net_income": _row(qinc, "Net Income", "Net Income Common Stockholders")}
    qcols = sorted(qinc.columns, reverse=True) if qinc is not None and not qinc.empty else []
    quarterly = [{"period": c.date().isoformat(), **{k: _at(s, c) for k, s in q_rows.items()}} for c in qcols]
    quarterly = [x for x in quarterly if x["revenue"] is not None or x["net_income"] is not None][:5]
    return annual, quarterly


def piotroski(y0: dict, y1: dict) -> dict:
    """Puntuación F de Piotroski (0-9) con el último año (y0) frente al anterior (y1).
    Solo se evalúan las comprobaciones con datos; 'max' dice cuántas fueron."""
    items = []

    def check(label, a, b, ok):
        if a is not None and b is not None:
            items.append({"label": label, "ok": bool(ok(a, b))})

    roa0, roa1 = _div(y0["net_income"], y0["total_assets"]), _div(y1["net_income"], y1["total_assets"])
    if roa0 is not None:
        items.append({"label": "Gana dinero (beneficio > 0)", "ok": roa0 > 0})
    if y0["ocf"] is not None:
        items.append({"label": "Genera caja con su actividad", "ok": y0["ocf"] > 0})
    check("Rentabilidad sobre activos mejora", roa0, roa1, lambda a, b: a > b)
    check("La caja supera al beneficio contable", y0["ocf"], y0["net_income"], lambda a, b: a > b)
    lev0 = _div(y0["long_term_debt"] or 0, y0["total_assets"]) if y0["total_assets"] else None
    lev1 = _div(y1["long_term_debt"] or 0, y1["total_assets"]) if y1["total_assets"] else None
    check("Baja el endeudamiento", lev0, lev1, lambda a, b: a <= b)
    cr0, cr1 = _div(y0["current_assets"], y0["current_liabilities"]), _div(y1["current_assets"], y1["current_liabilities"])
    check("Mejora la liquidez a corto plazo", cr0, cr1, lambda a, b: a > b)
    check("No emite acciones nuevas (no diluye)", y0["shares"], y1["shares"], lambda a, b: a <= b * 1.005)
    gm0, gm1 = _div(y0["gross_profit"], y0["revenue"]), _div(y1["gross_profit"], y1["revenue"])
    check("Mejora el margen bruto", gm0, gm1, lambda a, b: a > b)
    at0, at1 = _div(y0["revenue"], y0["total_assets"]), _div(y1["revenue"], y1["total_assets"])
    check("Vende más por cada $ de activos", at0, at1, lambda a, b: a > b)
    return {"score": sum(i["ok"] for i in items), "max": len(items), "items": items}


def quality(annual: list[dict], info: dict) -> dict:
    """Nota A/B/C. Cada criterio suma si se cumple; la nota depende del % logrado sobre lo evaluable."""
    if not annual:
        return {"grade": None, "points": 0, "max": 0, "details": []}
    y0 = annual[0]
    y1 = annual[1] if len(annual) > 1 else None
    details, points, maxp = [], 0, 0

    def add(label, value, ok, weight=1, fmt=None):
        nonlocal points, maxp
        if value is None:
            details.append({"label": label, "value": None, "ok": None})
            return
        maxp += weight
        pts = weight if ok is True else (ok if isinstance(ok, (int, float)) and not isinstance(ok, bool) else 0)
        points += pts
        details.append({"label": label, "value": fmt(value) if fmt else value,
                        "ok": True if pts >= weight else ("partial" if pts > 0 else False)})

    pct = lambda v: f"{v * 100:.1f}%".replace(".", ",")
    f = piotroski(y0, y1) if y1 else {"score": 0, "max": 0, "items": []}
    if f["max"] >= 5:
        ratio = f["score"] / f["max"]
        add("Salud financiera (Piotroski)", f"{f['score']}/{f['max']}", 2 if ratio >= 0.75 else 1 if ratio >= 0.55 else 0, weight=2)
    else:
        add("Salud financiera (Piotroski)", None, None)
    ni = y0["net_income"]
    add("Gana dinero (beneficio neto positivo)", ni, ni is not None and ni > 0, fmt=lambda v: f"{v / 1e6:,.0f} M".replace(",", "."))
    gm = _div(y0["gross_profit"], y0["revenue"])
    add("Margen bruto ≥ 40% (poder de precios)", gm, gm is not None and gm >= 0.40, fmt=pct)
    om = _div(y0["operating_income"], y0["revenue"])
    add("Margen operativo ≥ 15%", om, om is not None and om >= 0.15, fmt=pct)
    roe = _div(y0["net_income"], y0["equity"]) if (y0["equity"] or 0) > 0 else None
    add("Rentabilidad sobre fondos propios ≥ 15%", roe, roe is not None and roe >= 0.15, fmt=pct)
    growth = _div(y0["revenue"], y1["revenue"]) - 1 if y1 and _div(y0["revenue"], y1["revenue"]) is not None else None
    add("Ingresos crecen ≥ 10% al año", growth, growth is not None and growth >= 0.10, fmt=pct)
    fcf = y0["fcf"]
    add("Flujo de caja libre positivo", fcf, fcf is not None and fcf > 0, fmt=lambda v: f"{v / 1e6:,.0f} M".replace(",", "."))
    nd = (y0["total_debt"] or 0) - (y0["cash"] or 0) if y0["cash"] is not None else None
    lev = None if nd is None else (-1 if nd <= 0 else _div(nd, y0["ebitda"]) if (y0["ebitda"] or 0) > 0 else 99)
    add("Deuda neta ≤ 2 años de EBITDA (o caja neta)", lev, lev is not None and lev <= 2,
        fmt=lambda v: "caja neta" if v < 0 else "EBITDA negativo" if v == 99 else f"{v:.1f} años".replace(".", ","))

    grade = None
    if maxp >= 4:
        r = points / maxp
        grade = "A" if r >= 0.75 else "B" if r >= 0.50 else "C"
    return {"grade": grade, "points": points, "max": maxp, "details": details, "piotroski": f}


def fetch(symbol: str) -> dict:
    t = yf.Ticker(symbol)
    try:
        info = t.info or {}
    except Exception:
        info = {}
    annual, quarterly = _statements(t)
    return {
        "symbol": symbol, "fetched": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "name": info.get("longName") or info.get("shortName") or symbol,
        "sector": info.get("sector"), "industry": info.get("industry"),
        "employees": info.get("fullTimeEmployees"), "website": info.get("website"),
        "country": info.get("country"), "currency": info.get("financialCurrency") or "USD",
        "summary": (info.get("longBusinessSummary") or "")[:700],
        "pe": _num(info.get("trailingPE")), "forward_pe": _num(info.get("forwardPE")),
        "annual": annual, "quarterly": quarterly, "quality": quality(annual, info),
    }


def cached(symbol: str) -> dict | None:
    """Ficha guardada, sin descargar nada (aunque sea antigua)."""
    path = FUND_DIR / f"{symbol}.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def get(symbol: str, refresh_days: int = REFRESH_DAYS) -> dict | None:
    """Ficha de la caché si es reciente; si no, la descarga. None si Yahoo no da nada útil."""
    FUND_DIR.mkdir(parents=True, exist_ok=True)
    path = FUND_DIR / f"{symbol}.json"
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        age = (date.today() - date.fromisoformat(data["fetched"][:10])).days
        if age < refresh_days:
            return data
    try:
        data = fetch(symbol)
    except Exception as e:
        print(f"  [fundamentales] {symbol}: {type(e).__name__}: {e}")
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return data


def summary(f: dict | None) -> dict | None:
    """Lo mínimo que se guarda en la tarjeta del día y en el histórico."""
    if not f:
        return None
    q = f["quality"]
    return {"grade": q["grade"], "points": q["points"], "max": q["max"],
            "piotroski": f"{q['piotroski']['score']}/{q['piotroski']['max']}" if q.get("piotroski", {}).get("max") else None}
