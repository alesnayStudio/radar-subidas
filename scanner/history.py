"""Histórico de selecciones y seguimiento: ¿qué pasó con cada acción 1, 5 y 20 sesiones después?"""
import json
from datetime import date, timedelta
from statistics import mean, median

import pandas as pd
import yfinance as yf

from . import config

HISTORY_FILE = config.DATA_DIR / "history.json"
STATS_FILE = config.DATA_DIR / "stats.json"
GIVE_UP_DAYS = 60  # si tras 60 días naturales no hay datos (deslistada...), dejamos de intentarlo


def load() -> list[dict]:
    if HISTORY_FILE.exists():
        return json.loads(HISTORY_FILE.read_text(encoding="utf-8"))["picks"]
    return []


def save(picks: list[dict]) -> None:
    HISTORY_FILE.write_text(json.dumps({"picks": picks}, indent=1, ensure_ascii=False), encoding="utf-8")


def recent_dates(history: list[dict], before: str, sessions: int = config.REPEAT_WINDOW) -> list[str]:
    """Las últimas `sessions` fechas de escaneo anteriores a `before` (más reciente primero)."""
    return sorted({p["date"] for p in history if p["date"] < before}, reverse=True)[:sessions]


def previous_appearances(history: list[dict], symbol: str, scan_date: str) -> list[str]:
    """Fechas en que `symbol` ya salió en el top dentro de la ventana de reapariciones."""
    window = set(recent_dates(history, scan_date))
    return sorted({p["date"] for p in history if p["symbol"] == symbol and p["date"] in window}, reverse=True)


def add_picks(history: list[dict], scan_date: str, top: list[dict]) -> list[dict]:
    """Añade el top del día. Si ya había un escaneo de esa fecha se reemplaza (re-ejecuciones)."""
    history = [p for p in history if p["date"] != scan_date]
    for i, r in enumerate(top, 1):
        history.append({
            "date": scan_date, "symbol": r["symbol"], "name": r["name"], "rank": i,
            "score": r["score"], "price": r["price"], "change_pct": r["change_pct"], "rvol": r["rvol"],
            "catalyst": r["catalyst"]["type"], "catalyst_label": r["catalyst"]["label"],
            "appearance": r.get("appearance", {}).get("count", 1),  # 1 = primera vez, 2+ = repetidora
            "returns": {str(d): None for d in config.FOLLOW_UP_DAYS},
            "excess": {str(d): None for d in config.FOLLOW_UP_DAYS},
        })
    return sorted(history, key=lambda p: (p["date"], p["rank"]))


def _closes(symbols: list[str], start: str) -> pd.DataFrame:
    df = yf.download(symbols, start=start, auto_adjust=True, progress=False, threads=True)
    closes = df["Close"]
    if isinstance(closes, pd.Series):
        closes = closes.to_frame(symbols[0])
    closes.index = closes.index.date
    return closes


def _forward_return(series: pd.Series, pick_date: date, fallback_base: float, n: int):
    s = series.dropna()
    after = s[s.index > pick_date]
    if len(after) < n:
        return None
    base = s[pick_date] if pick_date in s.index else fallback_base
    return round(float(after.iloc[n - 1] / base - 1) * 100, 2)


def update_returns(history: list[dict], today: date) -> list[dict]:
    pending = [
        p for p in history
        if any(v is None for v in p["returns"].values())
        and (today - date.fromisoformat(p["date"])).days <= GIVE_UP_DAYS
        and date.fromisoformat(p["date"]) < today
    ]
    if not pending:
        return history
    start = (min(date.fromisoformat(p["date"]) for p in pending) - timedelta(days=7)).isoformat()
    symbols = sorted({p["symbol"] for p in pending} | {config.BENCHMARK})
    closes = _closes(symbols, start)
    bench = closes.get(config.BENCHMARK)

    for p in pending:
        if p["symbol"] not in closes:
            continue
        d = date.fromisoformat(p["date"])
        for n in config.FOLLOW_UP_DAYS:
            k = str(n)
            if p["returns"][k] is not None:
                continue
            ret = _forward_return(closes[p["symbol"]], d, p["price"], n)
            if ret is None:
                continue
            p["returns"][k] = ret
            if bench is not None:
                b = _forward_return(bench, d, float("nan"), n)
                p["excess"][k] = round(ret - b, 2) if b is not None and b == b else None
    return history


def holding_up(history: list[dict], scan_date: str) -> dict:
    """Acciones que salieron en el top en las últimas sesiones y siguen por encima del cierre de aquel día.

    Subir fuerte y no devolver la subida indica que no hay prisa por vender (absorción). Devuelve
    {"tracked": nº vigiladas, "items": [...las que aguantan, de más a menos ganancia]}.
    """
    window = set(recent_dates(history, scan_date, config.HOLD_WINDOW))
    latest_pick: dict[str, dict] = {}
    for p in sorted((p for p in history if p["date"] in window), key=lambda p: p["date"]):
        latest_pick[p["symbol"]] = p  # si salió varias veces, contamos desde la última aparición
    if not latest_pick:
        return {"tracked": 0, "items": []}

    df = yf.download(sorted(latest_pick), period="3mo", auto_adjust=True, progress=False, threads=True,
                     multi_level_index=True)
    end = date.fromisoformat(scan_date)
    items, tracked = [], 0
    for sym, p in latest_pick.items():
        try:
            close, vol = df["Close"][sym].dropna(), df["Volume"][sym].dropna()
        except KeyError:
            continue
        close.index, vol.index = close.index.date, vol.index.date
        close, vol = close[close.index <= end], vol[vol.index <= end]
        d = date.fromisoformat(p["date"])
        if close.empty or d not in close.index:
            continue
        base = float(close[d])
        since = close[close.index > d]
        # Si algún día no se ejecutó el escaneo, las fechas del histórico abarcarían más de N sesiones
        if since.empty or len(since) > config.HOLD_WINDOW:
            continue
        last = float(since.iloc[-1])
        change = (last / base - 1) * 100
        tracked += 1
        if change < 0:
            continue
        peak = float(since.max())
        avg_vol = float(vol.iloc[-21:-1].mean()) if len(vol) > 21 else None
        items.append({
            "symbol": sym, "name": p["name"], "picked_on": p["date"], "picked_price": round(base, 2),
            "price": round(last, 2), "change_since_pct": round(change, 2),
            "from_peak_pct": round((last / peak - 1) * 100, 2),   # 0 = en máximos desde la selección
            "sessions_since": int(len(since)),
            "last_rvol": round(float(vol.iloc[-1]) / avg_vol, 2) if avg_vol else None,
            "catalyst_label": p["catalyst_label"], "appearances": p.get("appearance", 1),
        })
    items.sort(key=lambda x: x["change_since_pct"], reverse=True)
    return {"tracked": tracked, "items": items}


def _summary(values: list[float], excess: list[float]) -> dict | None:
    if not values:
        return None
    return {
        "n": len(values),
        "avg": round(mean(values), 2),
        "median": round(median(values), 2),
        "win_rate": round(100 * sum(v > 0 for v in values) / len(values), 1),
        "avg_excess": round(mean(excess), 2) if excess else None,
    }


def _group(label: str, picks: list[dict]) -> dict:
    return {
        "label": label,
        "count": len(picks),
        "horizons": {
            str(n): _summary(
                [p["returns"][str(n)] for p in picks if p["returns"][str(n)] is not None],
                [p["excess"][str(n)] for p in picks if p["excess"][str(n)] is not None],
            )
            for n in config.FOLLOW_UP_DAYS
        },
    }


def _hold_signal(history: list[dict]) -> dict:
    """¿Aguantar la subida predice continuidad? Separa las selecciones según estuvieran por encima o
    por debajo de su precio a las 5 sesiones, y mide qué hicieron DESPUÉS (de la sesión 5 a la 20)."""
    held, faded = [], []
    for p in history:
        r5, r20 = p["returns"].get("5"), p["returns"].get("20")
        if r5 is None or r20 is None:
            continue
        after = ((1 + r20 / 100) / (1 + r5 / 100) - 1) * 100
        (held if r5 >= 0 else faded).append(after)
    return {
        "held": {"label": "Aguantaban a las 5 sesiones", "stats": _summary(held, [])},
        "faded": {"label": "Habían devuelto la subida", "stats": _summary(faded, [])},
    }


def compute_stats(history: list[dict]) -> dict:
    by_catalyst: dict[str, list[dict]] = {}
    for p in history:
        by_catalyst.setdefault(p["catalyst"], []).append(p)

    out = {
        "catalysts": {
            "all": _group("Todas", history),
            **{k: _group(v[0]["catalyst_label"], v) for k, v in by_catalyst.items()},
        },
        "appearance": {
            "first": _group("Primera aparición", [p for p in history if p.get("appearance", 1) == 1]),
            "repeat": _group("Repetidora (2ª vez o más)", [p for p in history if p.get("appearance", 1) >= 2]),
        },
        "hold_signal": _hold_signal(history),
    }
    STATS_FILE.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    return out
