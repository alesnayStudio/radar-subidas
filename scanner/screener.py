"""Descarga las acciones de EE.UU. que más suben hoy (screener gratuito de Yahoo) y aplica filtros de calidad."""
import math
from datetime import datetime
from zoneinfo import ZoneInfo

import yfinance as yf

from . import config

NY = ZoneInfo("America/New_York")


def _query():
    Q = yf.EquityQuery
    return Q("and", [
        Q("is-in", ["exchange", *config.EXCHANGES]),
        Q("gt", ["percentchange", config.MIN_CHANGE_PCT]),
        Q("gt", ["intradaymarketcap", config.MIN_MARKET_CAP]),
        Q("gt", ["intradayprice", config.MIN_PRICE]),
        Q("gt", ["dayvolume", config.MIN_DAY_VOLUME]),
    ])


def fetch_raw(size: int = 250) -> list[dict]:
    res = yf.screen(_query(), sortField="percentchange", sortAsc=False, size=size)
    return res.get("quotes", [])


def _num(q, key, default=None):
    v = q.get(key)
    return default if v is None or (isinstance(v, float) and math.isnan(v)) else v


def session_fraction(now: datetime | None = None) -> float:
    """Fracción transcurrida de la sesión 9:30-16:00 NY. Con el mercado abierto, el volumen del día
    está incompleto: lo comparamos con la parte proporcional de la media (mín. 10% para no exagerar)."""
    now = now or datetime.now(NY)
    minutes = (now.hour * 60 + now.minute) - (9 * 60 + 30)
    return min(1.0, max(0.1, minutes / 390))


def normalize(q: dict) -> dict | None:
    """Convierte la respuesta de Yahoo en un registro limpio con métricas propias."""
    price = _num(q, "regularMarketPrice")
    prev = _num(q, "regularMarketPreviousClose")
    vol = _num(q, "regularMarketVolume", 0)
    avg_vol = _num(q, "averageDailyVolume3Month") or _num(q, "averageDailyVolume10Day")
    if not price or not prev or not avg_vol:
        return None

    high = _num(q, "regularMarketDayHigh", price)
    low = _num(q, "regularMarketDayLow", price)
    open_ = _num(q, "regularMarketOpen", prev)
    rng = high - low
    ts = _num(q, "regularMarketTime")
    earn = _num(q, "earningsTimestampStart") or _num(q, "earningsTimestamp")
    frac = session_fraction() if q.get("marketState") == "REGULAR" else 1.0

    return {
        "symbol": q["symbol"],
        "name": q.get("longName") or q.get("shortName") or q["symbol"],
        "exchange": q.get("fullExchangeName") or q.get("exchange"),
        "price": round(price, 2),
        "day_high": round(high, 2),
        "prev_close": round(prev, 2),
        "change_pct": round(_num(q, "regularMarketChangePercent", 0), 2),
        "gap_pct": round((open_ / prev - 1) * 100, 2),
        # 1.0 = cerró en máximos del día (fuerza), 0.0 = en mínimos (vendieron la subida)
        "close_strength": round((price - low) / rng, 2) if rng > 0 else 1.0,
        "volume": int(vol),
        "avg_volume": int(avg_vol),
        "rvol": round(vol / (avg_vol * frac), 2),
        "dollar_volume": round(vol * price),
        "market_cap": _num(q, "marketCap"),
        "pe": _num(q, "trailingPE"),
        # Yahoo lo da en fracción (-0.54 = -54%), no en porcentaje
        "pct_from_52w_high": round(_num(q, "fiftyTwoWeekHighChangePercent", 0) * 100, 2),
        "above_sma50": price > _num(q, "fiftyDayAverage", math.inf),
        "above_sma200": price > _num(q, "twoHundredDayAverage", math.inf),
        "earnings_ts": earn,
        "market_time": ts,
        "market_date": datetime.fromtimestamp(ts, NY).date().isoformat() if ts else None,
        "market_state": q.get("marketState"),
    }


def passes_filters(r: dict) -> bool:
    name = r["name"].lower()
    if any(w in name for w in config.EXCLUDE_NAME_WORDS):
        return False
    return (
        r["change_pct"] >= config.MIN_CHANGE_PCT
        and r["dollar_volume"] >= config.MIN_DOLLAR_VOLUME
        and r["rvol"] >= config.MIN_RVOL
    )


def dedupe_share_classes(rows: list[dict]) -> list[dict]:
    """Zillow Z/ZG, Alphabet GOOG/GOOGL...: deja solo la clase con más volumen en dinero."""
    best: dict[str, dict] = {}
    for r in rows:
        key = r["name"].lower()
        if key not in best or r["dollar_volume"] > best[key]["dollar_volume"]:
            best[key] = r
    return list(best.values())


def get_candidates() -> tuple[list[dict], int]:
    """Devuelve (candidatas filtradas, nº total de subidas >umbral antes de filtros finos)."""
    raw = [q for q in fetch_raw() if q.get("quoteType") == "EQUITY"]
    rows = [r for r in (normalize(q) for q in raw) if r]
    filtered = dedupe_share_classes([r for r in rows if passes_filters(r)])
    return filtered, len(raw)
